import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscoveryStore } from '../dist/core/index.js';

function child(path) {
  const c=fork(new URL('./fixtures/lock-worker.mjs',import.meta.url),[path],{stdio:['ignore','ignore','ignore','ipc']});
  const message=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ c.kill('SIGKILL'); reject(new Error('worker timeout')); },5000);
    c.once('message',value=>{clearTimeout(timer);resolve(value);});
    c.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  return {c,message};
}

test('independent process lock contention, release and crash recovery', {timeout:15000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'video-lock-')); const path=join(dir,'data.sqlite');
  const store=new DiscoveryStore(path); const children=[];
  try {
    const first=child(path); children.push(first.c);
    assert.equal(await first.message,'acquired');
    const second=child(path); children.push(second.c);
    const secondExit=once(second.c,'exit');
    assert.equal(await second.message,'busy'); await secondExit;
    assert.throws(()=>store.acquireLock('user'),/running/);
    const firstExit=once(first.c,'exit'); first.c.send('release'); await firstExit;
    const lock=store.acquireLock('user'); lock.release();
    const crashed=child(path); children.push(crashed.c);
    assert.equal(await crashed.message,'acquired');
    const crashedExit=once(crashed.c,'exit'); crashed.c.kill('SIGKILL'); await crashedExit;
    const recovered=store.acquireLock('user');
    assert.throws(()=>store.acquireLock('user'),/running/);
    recovered.release();
  } finally {
    for(const c of children) if(c.exitCode===null && c.signalCode===null) { const exited=once(c,'exit');c.kill('SIGKILL');await exited; }
    store.close();rmSync(dir,{recursive:true,force:true});
  }
});
