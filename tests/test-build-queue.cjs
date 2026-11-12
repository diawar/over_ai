'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createBuildQueue}=require('../tools/build-queue.cjs');
const {createServer}=require('../tools/preview-app.cjs');
function fixture(options={}){
  const workers=[];
  const queue=createBuildQueue({...options,workerFactory:data=>{
    const worker=new EventEmitter();worker.data=data;worker.stopped=false;
    worker.terminate=async()=>{worker.stopped=true;};workers.push(worker);return worker;
  }});
  return {queue,workers};
}
const result=w=>w.emit('message',{type:'result',status:200,payload:{organizationId:w.data.organizationId}});
test('shared capacity, FIFO and bounded admission preserve organization results',async()=>{
  const {queue,workers}=fixture({concurrency:1,maxPending:1});
  const first=queue.run({organizationId:1}),second=queue.run({organizationId:2});
  await assert.rejects(queue.run({organizationId:3}),{code:'build_queue_full'});
  assert.deepEqual(queue.stats(),{active:1,pending:1});result(workers[0]);
  assert.equal((await first).payload.organizationId,1);assert.equal(workers[0].stopped,true);
  result(workers[1]);assert.equal((await second).payload.organizationId,2);
  assert.deepEqual(queue.stats(),{active:0,pending:0});await queue.close();
});
test('disconnect cancels pending and running jobs without starting cancelled work',async()=>{
  const {queue,workers}=fixture({concurrency:1});
  const a=new AbortController(),b=new AbortController();
  const first=queue.run({}, {signal:a.signal}),second=queue.run({}, {signal:b.signal});
  b.abort();await assert.rejects(second,{code:'build_cancelled'});
  a.abort();await assert.rejects(first,{code:'build_cancelled'});
  assert.equal(workers.length,1);assert.equal(workers[0].stopped,true);
  assert.deepEqual(queue.stats(),{active:0,pending:0});await queue.close();
});
test('deadline stops workers and unexpected clean exit does not hang the queue',async()=>{
  const {queue,workers}=fixture({timeoutMs:20,concurrency:1});
  await assert.rejects(queue.run({}),{code:'build_timeout'});
  assert.equal(workers[0].stopped,true);
  const next=queue.run({});workers[1].emit('exit',0);
  await assert.rejects(next,{code:'build_failed'});await queue.close();
});
test('server shutdown rejects queued and running work',async()=>{
  const {queue}=fixture({concurrency:1});
  const jobs=[queue.run({}),queue.run({})];
  const checks=jobs.map(job=>assert.rejects(job,{code:'build_unavailable'}));
  await queue.close();await Promise.all(checks);
  await assert.rejects(queue.run({}),{code:'build_unavailable'});
});
test('JSON and streamed HTTP builds use the same queue and pass tenant context',async()=>{
  const calls=[];
  const queue={close:async()=>{},run:async(data,options)=>{
    calls.push(data);assert.ok(options.signal);
    options.onProgress?.({type:'progress',phase:'inventory'});
    return {status:422,payload:{error:'needs_review'}};
  }};
  const server=createServer({buildQueue:queue,chatService:{recordBuildError(){}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const accept of ['application/json','application/x-ndjson']){
      const response=await fetch(base+'/api/pc-build?organization_id=7',{method:'POST',
        headers:{Origin:base,'Content-Type':'application/json',Accept:accept},body:'{}'});
      const text=await response.text();assert.match(text,/needs_review/);
      if(accept==='application/json')assert.equal(response.status,422);
      else assert.match(text,/'queued'|"queued"/);
    }
    assert.equal(calls.length,2);assert.ok(calls.every(call=>call.organizationId===7));
  }finally{await new Promise(resolve=>server.close(resolve));}
});
