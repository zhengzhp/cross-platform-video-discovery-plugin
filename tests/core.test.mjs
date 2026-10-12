import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DiscoveryStore, normalizeCandidate, rankCandidates, buildQueries, DEFAULT_BUDGET } from '../dist/core/index.js';

const candidate = (id, extra = {}) => ({ platform: 'new-source', platformId: id,
  url: `https://video.example/watch?id=${id}`, title: `Photography ${id}`, channel: 'page', verification: 'page-observed', ...extra });
const interest = { topics: ['Photography'], excludedTerms: ['advertisement'], depth: 0 };
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(),'video-core-'));
  const path = join(dir,'data.sqlite');
  const store = new DiscoveryStore(path);
  t.after(() => { store.close(); rmSync(dir,{recursive:true,force:true}); });
  store.setInterest('user',interest);
  const batch = store.createBatch('user',[{platform:'new-source',text:'Photography'}]);
  return { store, path, batch };
}

test('candidate normalization accepts extensible platforms and rejects unsafe fields', () => {
  const v = normalizeCandidate(candidate('a',{url:'https://video.example/watch?utm_source=x&id=a#secret'}));
  assert.equal(v.url,'https://video.example/watch?id=a');
  assert.equal(v.key,JSON.stringify(['new-source','a']));
  for (const url of ['http://video.example/a','https://user:password@video.example/a','javascript:alert(1)','https://video.example:8080/a']) {
    assert.throws(() => normalizeCandidate(candidate('a',{url})),/URL/);
  }
  assert.throws(() => normalizeCandidate(candidate('a',{title:'a\ncommand'})),/title/);
  assert.throws(() => normalizeCandidate(candidate('a',{depth:NaN})),/depth/);
  assert.throws(() => normalizeCandidate(candidate('a',{durationSeconds:-1})),/duration/);
  assert.throws(() => normalizeCandidate(candidate('a',{channel:'invented'})),/metadata/);
});

test('persistent batch order, deduplication and cross-store access', t => {
  const {store,path,batch} = setup(t);
  store.appendResults('user',batch,[candidate('a'),candidate('b'),candidate('a')]);
  const sameId = store.saveVideo(candidate('a',{url:'https://video.example/alternate'}));
  assert.equal(sameId.url,candidate('a').url);
  const noId = candidate('another'); delete noId.platformId; noId.url=candidate('a').url;
  assert.equal(store.saveVideo(noId).key,sameId.key);
  store.finishBatch('user',batch,'completed',[{platform:'new-source',status:'ok',code:'ok',elapsedMs:3}],4);
  const other = new DiscoveryStore(path);
  try {
    assert.deepEqual(other.getBatch('user',batch).results.map(v=>v.platformId),['a','b']);
    assert.equal(other.getBatch('user',batch).status,'completed');
    assert.throws(()=>other.getBatch('different-user',batch),/Unknown batch/);
    assert.throws(()=>other.appendResults('user',batch,[candidate('c')]),/not running/);
  } finally { other.close(); }
});

test('rejects a newer schema without overwriting its version', () => {
  const dir=mkdtempSync(join(tmpdir(),'video-schema-')); const path=join(dir,'data.sqlite');
  try {
    const db=new DatabaseSync(path); db.exec('PRAGMA user_version=2'); db.close();
    assert.throws(()=>new DiscoveryStore(path),/Unsupported database schema/);
    const reopened=new DatabaseSync(path);
    try { assert.equal(reopened.prepare('PRAGMA user_version').get().user_version,2); }
    finally { reopened.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('source status stores only approved fields and rejects raw diagnostic content', t => {
  const {store,batch}=setup(t);
  assert.throws(()=>store.finishBatch('user',batch,'failed',[{platform:'new-source',status:'failed',code:'raw secret error!',elapsedMs:2}]),/source status/);
  assert.equal(store.getBatch('user',batch).status,'running');
  store.finishBatch('user',batch,'failed',[{platform:'new-source',status:'failed',code:'timeout',elapsedMs:2,rawPage:'must not persist'}],2);
  assert.deepEqual(store.getBatch('user',batch).sources,[{platform:'new-source',status:'failed',code:'timeout',elapsedMs:2}]);
});

test('batch result overflow rolls back inserts and preserves numbers', t => {
  const {store,batch} = setup(t);
  store.appendResults('user',batch,Array.from({length:9},(_,i)=>candidate(String(i))));
  assert.throws(()=>store.appendResults('user',batch,[candidate('nine'),candidate('ten')]),/limit/);
  assert.equal(store.getBatch('user',batch).results.length,9);
  store.appendResults('user',batch,[candidate('next')]);
  assert.equal(store.getBatch('user',batch).results[9].platformId,'next');
  assert.throws(()=>store.createBatch('user',Array(7).fill({platform:'new-source',text:'x'})),/queries/);
});

test('feedback defaults to video, explicit author/topic scope, undo and cross-store persistence', t => {
  const {store,path,batch} = setup(t);
  store.appendResults('user',batch,[candidate('a',{author:'Alice'})]);
  const f = store.addFeedback('user',{batchId:batch,number:1,reason:'poor-quality'});
  assert.equal(f.scope,'video');
  const prefs = store.getPreferences('user');
  assert.equal(prefs.topicWeights.Photography,undefined);
  assert.equal(prefs.blockedAuthors.size,0);
  assert(prefs.blockedVideos.has(f.videoKey));
  const other = new DiscoveryStore(path);
  try {
    assert.equal(other.listFeedback('user')[0].id,f.id);
    other.revokeFeedback('user',f.id);
    assert.equal(store.getPreferences('user').blockedVideos.size,0);
    assert.equal(store.listFeedback('user')[0].revoked,true);
  } finally { other.close(); }
  const author = store.addFeedback('user',{batchId:batch,number:1,reason:'advertising',scope:'author'});
  assert.equal(store.getPreferences('user').blockedAuthors.size,1);
  store.revokeFeedback('user',author.id);
  const topic = store.addFeedback('user',{batchId:batch,number:1,reason:'topic-dislike',topic:'Photography'});
  assert.equal(store.getPreferences('user').topicWeights.Photography,-3);
  assert.deepEqual(buildQueries(['new-source'],store.getPreferences('user')),[]);
  store.revokeFeedback('user',topic.id);
  assert.equal(buildQueries(['new-source'],store.getPreferences('user')).length,1);
  assert.throws(()=>store.addFeedback('user',{batchId:batch,number:2,reason:'negative'}),/number/);
  assert.throws(()=>store.addFeedback('other',{batchId:batch,number:1,reason:'negative'}),/Unknown batch/);
  assert.throws(()=>store.revokeFeedback('other',f.id),/Unknown feedback/);
  assert.throws(()=>store.addFeedback('user',{batchId:batch,number:1,reason:'topic-dislike'}),/topic/);
  assert.throws(()=>store.addFeedback('user',{batchId:batch,number:1,reason:'topic-dislike',topic:'unconfigured'}),/configured/);
});

test('depth feedback updates queries; revocation recomputes from effective records', t => {
  const {store,batch}=setup(t);
  store.appendResults('user',batch,[candidate('a')]);
  const a=store.addFeedback('user',{batchId:batch,number:1,reason:'too-basic',topic:'Photography'});
  const b=store.addFeedback('user',{batchId:batch,number:1,reason:'too-advanced',topic:'Photography'});
  assert.equal(store.getPreferences('user').interest.depth,0);
  store.revokeFeedback('user',b.id);
  assert.equal(store.getPreferences('user').interest.depth,1);
  assert.match(buildQueries(['new-source'],store.getPreferences('user'))[0].text,/advanced/);
  store.revokeFeedback('user',a.id);
  assert.equal(store.getPreferences('user').interest.depth,0);
  const seen=store.addFeedback('user',{batchId:batch,number:1,reason:'seen'});
  assert.equal(store.getPreferences('user').seen.size,1);
  store.revokeFeedback('user',seen.id);
  assert.equal(store.getPreferences('user').seen.size,0);
});

test('ranking filters history, exclusion, unrelated candidates and duplicates, flags unknown hard conditions', t => {
  const {store,batch}=setup(t);
  store.appendResults('user',batch,[candidate('delivered')]);
  store.finishBatch('user',batch,'completed');
  const deliveredKey = store.getBatch('user',batch).results[0].key;
  store.confirmDelivery('user',batch,[deliveredKey]);
  const prefs=store.getPreferences('user');
  const input=[candidate('delivered'),candidate('a',{author:'Alice'}),candidate('a'),candidate('b',{author:'Alice'}),
    candidate('c',{author:'Bob'}),candidate('ad',{title:'Photography advertisement'}),candidate('unrelated',{title:'Gardening'}),
    candidate('long',{durationSeconds:1000})];
  const ranked=rankCandidates(input,prefs,{maxDurationSeconds:60});
  assert.deepEqual(ranked.map(r=>r.video.platformId),['a','c','b']);
  assert(ranked[0].warnings.includes('Duration condition cannot be verified'));
  assert(ranked[2].reasons.includes('Repeated author diversity penalty'));
  assert.equal(rankCandidates([candidate('delivered')],prefs,{includeHistory:true}).length,1);
  assert.throws(()=>rankCandidates(input,prefs,{limit:11}),/limit/);
  const external=rankCandidates([candidate('ext',{channel:'external-search',verification:'unverified'})],prefs)[0];
  assert.equal(external.warnings.length,2);
});

test('queries cover sources before repeated topics and enforce bounds', t => {
  const {store}=setup(t);
  store.setInterest('user',{...interest,topics:['Photography','Music','Science']});
  const q=buildQueries(['extra-source','new-source','third-source'],store.getPreferences('user'));
  assert.equal(q.length,6); assert.deepEqual(q.slice(0,3).map(x=>x.platform),['extra-source','new-source','third-source']);
  assert.match(q[0].text,/-"advertisement"/);
  assert.equal(DEFAULT_BUDGET.maxConcurrentSources,2);
  assert.equal(DEFAULT_BUDGET.roundTimeoutMs,300000);
  assert.throws(()=>store.setInterest('user',{...interest,depth:6}),/interest/);
});

test('withLock releases after rejection or cancellation, not before task settles', async t => {
  const {store}=setup(t);
  const abort=new AbortController();
  await assert.rejects(store.withLock('user',abort.signal,async()=>{ throw new Error('failed'); }),/failed/);
  const lock=store.acquireLock('user'); lock.release(); lock.release();
  await assert.rejects(store.withLock('user',abort.signal,async()=>{
    abort.abort(); assert.throws(()=>store.acquireLock('user'),/running/); abort.signal.throwIfAborted();
  }));
  const next=store.acquireLock('user'); next.release();
  await assert.rejects(store.withLock('user',abort.signal,async()=>assert.fail('must not run')));
});

test('delivery confirmation is idempotent and filters history separately from saved results', t => {
  const {store,batch}=setup(t);
  store.appendResults('user',batch,[candidate('a'),candidate('b'),candidate('c')]);
  store.finishBatch('user',batch,'completed');

  // Confirm partial delivery (only first 2 results)
  const delivered = store.getBatch('user',batch).results.slice(0,2).map(v=>v.key);
  store.confirmDelivery('user',batch,delivered);

  // Delivered videos should be filtered from history
  const prefs1 = store.getPreferences('user');
  assert.equal(prefs1.delivered.size,2);
  const ranked1 = rankCandidates([candidate('a'),candidate('b'),candidate('c')],prefs1);
  assert.deepEqual(ranked1.map(r=>r.video.platformId),['c']);

  // Repeated confirmation should be idempotent
  store.confirmDelivery('user',batch,delivered);
  assert.equal(store.getPreferences('user').delivered.size,2);

  // Confirm additional delivery
  const allKeys = store.getBatch('user',batch).results.map(v=>v.key);
  store.confirmDelivery('user',batch,allKeys);
  assert.equal(store.getPreferences('user').delivered.size,3);

  // Cannot confirm delivery for unfinished batch
  const batch2 = store.createBatch('user',[{platform:'new-source',text:'Photography'}]);
  store.appendResults('user',batch2,[candidate('d')]);
  assert.throws(()=>store.confirmDelivery('user',batch2,[store.getBatch('user',batch2).results[0].key]),/finished/);

  // Cannot confirm delivery for non-existent video key
  store.finishBatch('user',batch2,'completed');
  assert.throws(()=>store.confirmDelivery('user',batch2,['invalid-key']),/not in batch/);
});

test('saved but undelivered results do not filter history', t => {
  const {store,batch}=setup(t);
  store.appendResults('user',batch,[candidate('saved-only')]);
  store.finishBatch('user',batch,'cancelled',[],0);

  // Saved but cancelled/undelivered should not filter history
  const prefs = store.getPreferences('user');
  assert.equal(prefs.delivered.size,0);
  const ranked = rankCandidates([candidate('saved-only')],prefs);
  assert.equal(ranked.length,1,'Saved but undelivered result should not be filtered');

  // After explicit delivery confirmation, it should filter
  store.confirmDelivery('user',batch,[store.getBatch('user',batch).results[0].key]);
  const prefs2 = store.getPreferences('user');
  assert.equal(prefs2.delivered.size,1);
  assert.equal(rankCandidates([candidate('saved-only')],prefs2).length,0);
});

test('seen feedback and delivery confirmation filter independently', t => {
  const {store,batch}=setup(t);
  store.appendResults('user',batch,[candidate('a'),candidate('b')]);
  store.finishBatch('user',batch,'completed');

  // Mark one as seen via feedback
  store.addFeedback('user',{batchId:batch,number:1,reason:'seen'});
  const prefs1 = store.getPreferences('user');
  assert.equal(prefs1.seen.size,1);
  assert.equal(prefs1.delivered.size,0);

  // Both seen and undelivered should be filtered
  const ranked1 = rankCandidates([candidate('a'),candidate('b')],prefs1);
  assert.deepEqual(ranked1.map(r=>r.video.platformId),['b']);

  // Confirm delivery of the other video
  const keyB = store.getBatch('user',batch).results[1].key;
  store.confirmDelivery('user',batch,[keyB]);
  const prefs2 = store.getPreferences('user');
  assert.equal(prefs2.seen.size,1);
  assert.equal(prefs2.delivered.size,1);

  // Both should now be filtered
  const ranked2 = rankCandidates([candidate('a'),candidate('b')],prefs2);
  assert.equal(ranked2.length,0);

  // includeHistory should bypass filtering
  const ranked3 = rankCandidates([candidate('a'),candidate('b')],prefs2,{includeHistory:true});
  assert.equal(ranked3.length,2);
});
