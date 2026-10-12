import { DiscoveryStore } from '../../dist/core/index.js';
const store=new DiscoveryStore(process.argv[2]);
try {
  const lock=store.acquireLock('user');
  process.send?.('acquired');
  process.on('message',message=>{
    if(message==='release') { lock.release(); store.close(); process.exit(0); }
  });
} catch(error) {
  process.send?.(error.name==='BusyError'?'busy':'error');
  store.close(); process.exit(error.name==='BusyError'?0:1);
}
