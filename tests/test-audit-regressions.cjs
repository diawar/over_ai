'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createChatService}=require('../tools/corelab-ai.cjs');
const {memoryProfileSupport}=require('../tools/component-budget.cjs');
const {createServer}=require('../tools/preview-app.cjs');
const profile={city:'Алматы',purpose:'Для офиса',tasks:'Word',budget:150000,cpu:'AMD',graphicsPreference:null};
const answer=p=>({reply:'Ответ',tasksClear:true,profile:p,action:{kind:'answer',platformSocket:null,changeRequest:null}});
test('changed criteria and failed rebuild cannot resurrect a verified quote',async()=>{
  let changed=false;const seen=[];
  const service=createChatService({minInterval:0,config:()=>({}),provider:async(c,h)=>{
    seen.push(JSON.parse(h.at(-1).content));return answer({...profile,budget:changed?100000:150000});
  }});
  const first=await service.chat({stage:'initial_build',message:'Начать',profile});
  service.recordBuild(first.sessionId,profile,{total:140000,parts:[]});changed=true;
  await service.chat({sessionId:first.sessionId,stage:'discussion',message:'Бюджет 100000'});
  service.recordBuildError(first.sessionId,{...profile,budget:100000},{error:'needs_review'});
  const last=await service.chat({sessionId:first.sessionId,stage:'discussion',message:'Стоимость?'});
  assert.equal(seen.at(-1).verifiedBuild,null);assert.doesNotMatch(last.reply,/140/);
});
test('replaying a completed first request returns its receipt without another provider call',async()=>{
  let calls=0;const service=createChatService({minInterval:0,config:()=>({}),provider:async()=>{calls++;return answer(profile);}});
  const body={requestId:'a'.repeat(48),stage:'tasks',message:'Word',profile};
  const first=await service.chat(body);assert.deepEqual(await service.chat(body),first);assert.equal(calls,1);
  await assert.rejects(service.chat({...body,message:'Other'}),{code:'request_conflict'});
});
test('disconnected request receives abort and cannot commit a late answer or be charged twice by retry',async()=>{
  const controller=new AbortController();let calls=0,release,observed;
  const service=createChatService({minInterval:0,config:()=>({}),provider:async(c,h,f,{signal})=>{
    calls++;observed=signal;await new Promise(resolve=>{release=resolve;});return answer(profile);
  }});
  const body={requestId:'b'.repeat(48),stage:'tasks',message:'Word',profile};
  const pending=service.chat(body,{signal:controller.signal});controller.abort();release();
  await assert.rejects(pending,{code:'request_interrupted'});assert.equal(observed.aborted,true);
  await assert.rejects(service.chat(body),{code:'request_interrupted'});assert.equal(calls,1);
});
test('unknown RAM profiles do not beat unsupported profiles; explicit JEDEC and matching OC remain distinct',()=>{
  assert.equal(memoryProfileSupport({},{}).tuningAllowed,false);
  assert.equal(memoryProfileSupport({profiles:['EXPO']},{}).tuningAllowed,false);
  assert.equal(memoryProfileSupport({profiles:[]},{}).tuningAllowed,true);
  assert.equal(memoryProfileSupport({profiles:['EXPO']},{memoryProfiles:['EXPO']}).tuningAllowed,true);
});
test('static and unknown routes do not initialize a tenant service or touch storage',async()=>{
  const previous=process.env.CHAT_SESSION_DIRECTORY;
  // An invalid file path makes any attempted store construction fail.
  process.env.CHAT_SESSION_DIRECTORY=__filename;
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base+'/style.css?organization_id=99999')).status,200);
    assert.equal((await fetch(base+'/missing?organization_id=99998')).status,404);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    if(previous===undefined)delete process.env.CHAT_SESSION_DIRECTORY;else process.env.CHAT_SESSION_DIRECTORY=previous;
  }
});
