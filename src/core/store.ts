import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { authorKey, normalizeCandidate, text, validateInterest } from './ranking.js';
import { BusyError } from './types.js';
import type { Batch, BatchStatus, Candidate, Feedback, FeedbackInput, FeedbackReason, FeedbackScope, Interest, Preferences, Query, SourceStatus, Video } from './types.js';

type Row = Record<string, unknown>;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const reasons: FeedbackReason[] = ['too-basic','too-advanced','topic-dislike','poor-quality','advertising','negative','seen'];
const scopes: FeedbackScope[] = ['video','author','topic'];

/** One local SQLite file shared by hosts. No database is opened on module import. */
export class DiscoveryStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 1) throw new Error('Unsupported database schema version');
      this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=2000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS interests(user_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS videos(key TEXT PRIMARY KEY, platform TEXT NOT NULL, url TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(platform,url));
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, queries TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, sources TEXT NOT NULL DEFAULT '[]', elapsed_ms INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS results(batch_id TEXT NOT NULL REFERENCES batches(id), number INTEGER NOT NULL, video_key TEXT NOT NULL REFERENCES videos(key), PRIMARY KEY(batch_id,number), UNIQUE(batch_id,video_key));
      CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES batches(id), video_key TEXT NOT NULL REFERENCES videos(key), reason TEXT NOT NULL, scope TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS discovery_locks(user_id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL);
      PRAGMA user_version=1;
      COMMIT;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private user(userId: string): string { return text(userId, 'user ID', 200); }
  setInterest(userId: string, interest: Interest): void {
    const data = validateInterest(interest);
    this.db.prepare('INSERT INTO interests VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data')
      .run(this.user(userId), JSON.stringify(data));
  }
  getInterest(userId: string): Interest {
    const row = this.db.prepare('SELECT data FROM interests WHERE user_id=?').get(this.user(userId));
    if (!row) throw new Error('Set an interest first');
    return validateInterest(decode<Interest>(row.data));
  }
  saveVideo(candidate: Candidate): Video {
    const video = normalizeCandidate(candidate);
    return this.transaction(() => this.upsert(video));
  }
  private upsert(video: Video): Video {
    const row = this.db.prepare('SELECT data FROM videos WHERE key=? OR (platform=? AND url=?) ORDER BY key LIMIT 1')
      .get(video.key, video.platform, video.url);
    if (row) return decode<Video>(row.data);
    this.db.prepare('INSERT INTO videos VALUES(?,?,?,?)').run(video.key, video.platform, video.url, JSON.stringify(video));
    return video;
  }
  createBatch(userId: string, queries: Query[]): string {
    const user = this.user(userId);
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > 6) throw new Error('Invalid queries');
    const clean = queries.map(q => {
      const platform = text(q.platform, 'platform', 64);
      if (!/^[a-z][a-z0-9_-]*$/u.test(platform)) throw new Error('Invalid platform');
      return { platform, text: text(q.text, 'query', 4096) };
    });
    const id = randomUUID();
    this.db.prepare('INSERT INTO batches(id,user_id,queries,status,created_at) VALUES(?,?,?,?,?)')
      .run(id,user,JSON.stringify(clean),'running',Date.now());
    return id;
  }
  private ownedBatch(userId: string, batchId: string): Row {
    const row = this.db.prepare('SELECT * FROM batches WHERE id=? AND user_id=?')
      .get(text(batchId, 'batch ID', 100), this.user(userId));
    if (!row) throw new Error('Unknown batch for this user');
    return row;
  }
  /** Incremental results; existing numbers never shift. */
  appendResults(userId: string, batchId: string, candidates: Candidate[]): Video[] {
    if (candidates.length > 10) throw new Error('Too many results');
    const clean = candidates.map(normalizeCandidate);
    return this.transaction(() => {
      const batch = this.ownedBatch(userId, batchId);
      if (batch.status !== 'running') throw new Error('Batch is not running');
      let number = Number(this.db.prepare('SELECT COUNT(*) AS n FROM results WHERE batch_id=?').get(batchId)!.n);
      for (const candidate of clean) {
        const video = this.upsert(candidate);
        if (this.db.prepare('SELECT 1 FROM results WHERE batch_id=? AND video_key=?').get(batchId,video.key)) continue;
        if (number >= 10) throw new Error('Batch result limit exceeded');
        this.db.prepare('INSERT INTO results VALUES(?,?,?)').run(batchId,++number,video.key);
      }
      return this.getBatch(userId,batchId).results;
    });
  }
  finishBatch(userId: string, batchId: string, status: Exclude<BatchStatus,'running'>, sources: SourceStatus[] = [], elapsedMs = 0): void {
    if (!['completed','failed','cancelled'].includes(status) || !Number.isFinite(elapsedMs) || elapsedMs < 0 || sources.length > 6) throw new Error('Invalid batch status');
    const clean = sources.map(s => {
      if (!['ok','failed','paused'].includes(s.status) || !/^[a-z0-9_-]{1,64}$/u.test(s.code) || !Number.isFinite(s.elapsedMs) || s.elapsedMs < 0) throw new Error('Invalid source status');
      const platform = text(s.platform,'platform',64);
      if (!/^[a-z][a-z0-9_-]*$/u.test(platform)) throw new Error('Invalid platform');
      return { platform, status: s.status, code: s.code, elapsedMs: s.elapsedMs };
    });
    this.transaction(() => {
      if (this.ownedBatch(userId,batchId).status !== 'running') throw new Error('Batch is not running');
      this.db.prepare('UPDATE batches SET status=?,sources=?,elapsed_ms=? WHERE id=?').run(status,JSON.stringify(clean),elapsedMs,batchId);
    });
  }
  getBatch(userId: string, batchId: string): Batch {
    const row = this.ownedBatch(userId,batchId);
    const results = this.db.prepare('SELECT v.data FROM results r JOIN videos v ON v.key=r.video_key WHERE r.batch_id=? ORDER BY r.number')
      .all(batchId).map(r => decode<Video>(r.data));
    return { id: String(row.id), userId: String(row.user_id), queries: decode<Query[]>(row.queries),
      status: row.status as BatchStatus, createdAt: Number(row.created_at), sources: decode<SourceStatus[]>(row.sources), elapsedMs: Number(row.elapsed_ms), results };
  }
  addFeedback(userId: string, input: FeedbackInput): Feedback {
    if (!Number.isInteger(input.number) || input.number < 1 || input.number > 10 || !reasons.includes(input.reason)) throw new Error('Invalid feedback');
    return this.transaction(() => {
      this.ownedBatch(userId,input.batchId);
      const row = this.db.prepare('SELECT v.data FROM results r JOIN videos v ON v.key=r.video_key WHERE batch_id=? AND number=?').get(input.batchId,input.number);
      if (!row) throw new Error('Unknown batch number');
      const video = decode<Video>(row.data);
      const depthReason = input.reason === 'too-basic' || input.reason === 'too-advanced';
      const scope = input.scope ?? (input.reason === 'topic-dislike' || depthReason ? 'topic' : 'video');
      if (!scopes.includes(scope) || (input.reason === 'seen' && scope !== 'video') || (depthReason && scope !== 'topic')) throw new Error('Invalid feedback scope');
      let target = video.key;
      if (scope === 'author') {
        if (!video.author) throw new Error('Author is unknown');
        target = authorKey(video);
      } else if (scope === 'topic') {
        target = text(input.topic,'feedback topic',100);
        if (!this.getInterest(userId).topics.includes(target)) throw new Error('Feedback topic must be explicit and configured');
      }
      const feedback: Feedback = { id: randomUUID(), batchId: input.batchId, videoKey: video.key,
        reason: input.reason, scope, target, createdAt: Date.now(), revoked: false };
      this.db.prepare('INSERT INTO feedback(id,user_id,batch_id,video_key,reason,scope,target,created_at,revoked) VALUES(?,?,?,?,?,?,?,?,0)').run(feedback.id,this.user(userId),feedback.batchId,feedback.videoKey,feedback.reason,feedback.scope,feedback.target,feedback.createdAt);
      return feedback;
    });
  }
  revokeFeedback(userId: string, feedbackId: string): void {
    this.transaction(() => {
      const result = this.db.prepare('UPDATE feedback SET revoked=1 WHERE id=? AND user_id=?').run(text(feedbackId,'feedback ID',100),this.user(userId));
      if (Number(result.changes) !== 1) throw new Error('Unknown feedback for this user');
    });
  }
  listFeedback(userId: string): Feedback[] {
    return this.db.prepare('SELECT * FROM feedback WHERE user_id=? ORDER BY created_at,id').all(this.user(userId)).map(row => ({
      id: String(row.id), batchId: String(row.batch_id), videoKey: String(row.video_key), reason: row.reason as FeedbackReason,
      scope: row.scope as FeedbackScope, target: String(row.target), createdAt: Number(row.created_at), revoked: Boolean(row.revoked),
    }));
  }
  /** Derived inside a transaction, never an increment-only cached preference. */
  getPreferences(userId: string): Preferences {
    return this.transaction(() => {
      const interest = this.getInterest(userId);
      const prefs: Preferences = { interest, topicWeights: Object.create(null) as Record<string,number>,
        blockedVideos: new Set(), blockedAuthors: new Set(), seen: new Set(), displayed: new Set() };
      for (const row of this.db.prepare('SELECT r.video_key FROM results r JOIN batches b ON b.id=r.batch_id WHERE b.user_id=?').all(this.user(userId))) {
        prefs.displayed.add(String(row.video_key));
      }
      let depthDelta = 0;
      for (const f of this.listFeedback(userId).filter(f => !f.revoked)) {
        if (f.reason === 'seen') { prefs.seen.add(f.videoKey); continue; }
        if (f.scope === 'topic' && !interest.topics.includes(f.target)) continue;
        if (f.reason === 'too-basic') { depthDelta++; continue; }
        if (f.reason === 'too-advanced') { depthDelta--; continue; }
        if (f.scope === 'video') prefs.blockedVideos.add(f.target);
        else if (f.scope === 'author') prefs.blockedAuthors.add(f.target);
        else prefs.topicWeights[f.target] = (prefs.topicWeights[f.target] ?? 0) - 3;
      }
      interest.depth = Math.max(-5,Math.min(5,interest.depth + depthDelta));
      return prefs;
    });
  }
  /** PID-owned local-machine lock. Never steal a live PID's lock on a timer. */
  acquireLock(userId: string): { release: () => void } {
    const user = this.user(userId);
    const token = randomUUID();
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM discovery_locks WHERE user_id=?').get(user);
      if (row) {
        let alive = true;
        try { process.kill(Number(row.pid),0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new BusyError();
        this.db.prepare('DELETE FROM discovery_locks WHERE user_id=? AND token=?').run(user,String(row.token));
      }
      this.db.prepare('INSERT INTO discovery_locks VALUES(?,?,?)').run(user,token,process.pid);
    });
    return { release: () => { this.db.prepare('DELETE FROM discovery_locks WHERE user_id=? AND token=?').run(user,token); } };
  }
  async withLock<T>(userId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const lock = this.acquireLock(userId);
    // Do not release early on abort: the task must settle and clean up first.
    try { signal.throwIfAborted(); return await task(); }
    finally { lock.release(); }
  }
}
