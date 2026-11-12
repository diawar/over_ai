'use strict';
const {Worker}=require('node:worker_threads');
const path=require('node:path');

// One bounded queue per server process, shared by every organization and transport.
function createBuildQueue({concurrency=2,maxPending=8,timeoutMs=80000,
  workerFactory=data=>new Worker(path.join(__dirname,'build-worker.cjs'),{workerData:data})}={}){
  let active=0,closed=false;
  const pending=[],running=new Set();
  const error=code=>Object.assign(new Error(code),{code});
  function pump(){
    while(!closed&&active<concurrency&&pending.length){
      const job=pending.shift();
      if(job.finished)continue;
      active++;running.add(job);job.started=true;
      try{
        job.worker=workerFactory(job.data);
        job.worker.on('message',event=>{
          if(job.finished)return;
          if(event.type==='result')void job.finish(null,{status:event.status,payload:event.payload});
          else job.onProgress?.(event);
        });
        job.worker.on('error',()=>void job.finish(error('build_failed')));
        job.worker.on('exit',()=>{if(!job.finished)void job.finish(error('build_failed'));});
      }catch{void job.finish(error('build_failed'));}
    }
  }
  function run(data,{signal,onProgress}={}){
    if(closed)return Promise.reject(error('build_unavailable'));
    if(signal?.aborted)return Promise.reject(error('build_cancelled'));
    if(active>=concurrency&&pending.length>=maxPending)return Promise.reject(error('build_queue_full'));
    return new Promise((resolve,reject)=>{
      const job={data,onProgress,started:false,finished:false,worker:null};
      const abort=()=>void job.finish(error('build_cancelled'));
      job.finish=async(err,result)=>{
        if(job.finished)return;
        job.finished=true;clearTimeout(job.timer);signal?.removeEventListener('abort',abort);
        const index=pending.indexOf(job);if(index>=0)pending.splice(index,1);
        // Do not release the slot while a CPU-bound worker is still alive.
        try{if(job.worker)await job.worker.terminate();}catch{}
        if(job.started){active--;running.delete(job);}
        if(err)reject(err);else resolve(result);
        pump();
      };
      job.timer=setTimeout(()=>void job.finish(error('build_timeout')),timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});
      pending.push(job);pump();
    });
  }
  function close(){closed=true;return Promise.all([...pending,...running].map(job=>job.finish(error('build_unavailable'))));}
  return {run,close,stats:()=>({active,pending:pending.length})};
}
module.exports={createBuildQueue};
