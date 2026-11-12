'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createSessionStore}=require('../tools/chat-session-store.cjs');
const {createChatService}=require('../tools/corelab-ai.cjs');
test('sessions survive restart, stay tenant isolated and expire',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'corelab-chat-'));
  let time=10000;const options={now:()=>time};const id='a'.repeat(48);
  try{
    const store=createSessionStore(directory,1,options);
    store.save(id,{profile:{city:'Павлодар'},history:[],touched:time,busy:true,lastCall:time,
      verifiedBuild:{parts:[],total:150000},workloadProfile:{version:1}});
    const restored=createSessionStore(directory,1,options).load().get(id);
    assert.equal(restored.busy,false);assert.equal(restored.verifiedBuild.total,150000);
    assert.deepEqual(restored.workloadProfile,{version:1});
    assert.equal(createSessionStore(directory,2,options).load().size,0);
    assert.throws(()=>store.save('../escape',{}),/invalid_session/);
    time+=3600000;assert.equal(store.load().size,0);
    assert.equal(fs.readdirSync(path.join(directory,'1')).length,0);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('corrupt context is removed instead of being trusted',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'corelab-chat-'));
  try{
    const store=createSessionStore(directory,1);
    fs.writeFileSync(path.join(directory,'1','b'.repeat(48)+'.json'),'broken');
    assert.equal(store.load().size,0);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('AI service persists history and server-verified build across recreation without real AI calls',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'corelab-chat-'));
  const profile={city:'Павлодар',purpose:'Для офиса',tasks:'Word',budget:150000,cpu:'AMD'};
  const options={config:()=>({provider:'openai',apiKey:'test',model:'test'}),minInterval:0,
    provider:async()=>({reply:'Уточните задачи',tasksClear:false,profile,
      action:{kind:'clarify',platformSocket:null,changeRequest:null}})};
  try{
    const first=createChatService({...options,sessionStore:createSessionStore(directory,1)});
    const request={requestId:'c'.repeat(48),stage:'tasks',message:'Word',profile};
    const reply=await first.chat(request);
    assert.equal(first.recordBuild(reply.sessionId,reply.profile,{total:140000,parts:[]}),true);
    let received;
    const next=createChatService({...options,sessionStore:createSessionStore(directory,1),
      provider:async(c,history)=>{received=history;return options.provider();}});
    assert.deepEqual(await next.chat(request),reply);
    assert.equal(received,undefined);
    await next.chat({sessionId:reply.sessionId,stage:'build_review',message:'Объясните'});
    assert.ok(received.length>=3);
    assert.equal(JSON.parse(received.at(-1).content).verifiedBuild.total,140000);
    const other=createChatService({...options,sessionStore:createSessionStore(directory,2)});
    await assert.rejects(other.chat({sessionId:reply.sessionId,stage:'tasks',message:'Word'}),{code:'session_expired'});
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
