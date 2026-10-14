const test=require('node:test');
const assert=require('node:assert/strict');
const {createChatService,callOpenAI,decodeResponse}=require('../tools/corelab-ai.cjs');
const {createServer}=require('../tools/preview-app.cjs');
const profile={city:'Другой город',purpose:'Для игр',tasks:'',budget:null,cpu:null};
const configuration=()=>({provider:'openai',model:'test-model',apiKey:'unit-test-key'});
const result=(changes={})=>({reply:'Уточните, в какие игры Вы играете?',tasksClear:false,profile:{...profile},...changes});
test('missing configuration fails without external call',async()=>{
  await assert.rejects(callOpenAI({provider:'openai'},[],()=>{throw Error('must not call');}),{code:'ai_not_configured'});
  const service=createChatService({config:()=>({})});assert.equal(service.status().ready,false);
});
test('Responses adapter sends key only to fixed endpoint, schema and store:false',async()=>{
  const answer=await callOpenAI(configuration(),[{role:'user',content:'Игры'}],async(url,opts)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(opts.redirect,'error');
    assert.equal(opts.headers.Authorization,'Bearer unit-test-key');
    const body=JSON.parse(opts.body);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);
    assert.deepEqual(body.reasoning,{effort:'medium'});
    assert.ok(body.instructions.includes('verifiedBuild'));
    return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result())}]}]})};
  });
  assert.equal(answer.tasksClear,false);
});
test('provider errors never expose remote body',async()=>{
  await assert.rejects(callOpenAI(configuration(),[],async()=>({ok:false,status:401,json:()=>{throw Error('must not read error body');}})),{code:'ai_auth_failed'});
});
test('refusal, incomplete and invalid structured output are rejected',()=>{
  assert.throws(()=>decodeResponse({status:'incomplete'}),{code:'ai_incomplete'});
  assert.throws(()=>decodeResponse({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]}),{code:'ai_refusal'});
  assert.throws(()=>decodeResponse({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]}),{code:'ai_invalid_response'});
});
test('session retains context, accepts structured selection, never enables builds',async()=>{
  const calls=[];
  const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{
    calls.push(history);const turn=JSON.parse(history.at(-1).content);
    return result({tasksClear:true,profile:{...turn.currentProfile,tasks:'CS2'}});
  }});
  const first=await service.chat({stage:'tasks',message:'CS2',profile});
  assert.ok(first.sessionId);assert.equal(first.buildsReady,false);
  const next=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Подведите итог',selection:{budget:500000,cpu:'AMD'}});
  assert.equal(next.profile.budget,500000);assert.equal(next.profile.city,'Другой город');assert.equal(calls[1].length,3);
  await assert.rejects(service.chat({stage:'discussion',sessionId:first.sessionId,message:'Ещё',selection:{budget:10,cpu:'Intel'}}),{code:'invalid_request'});
});
test('failed followup does not append history or corrupt profile',async()=>{
  let fail=false;let seen;
  const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{seen=history;if(fail)throw Error('failure');return result();}});
  const first=await service.chat({stage:'tasks',message:'Игры',profile});fail=true;
  await assert.rejects(service.chat({stage:'tasks',message:'CS2',sessionId:first.sessionId}));fail=false;
  await service.chat({stage:'tasks',message:'CS2',sessionId:first.sessionId});assert.equal(seen.length,3);
});
test('discussion receives a server-calculated build and never trusts a client build payload',async()=>{
  let userTurn;
  const service=createChatService({config:configuration,minInterval:0,buildProvider:p=>({ok:true,build:{total:p.budget-1,parts:[{skuOver:'verified-sku',price:100}]}}),provider:async(c,history)=>{
    userTurn=JSON.parse(history.at(-1).content);return result();
  }});
  const first=await service.chat({stage:'tasks',message:'Игры',profile});
  await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Покажи подбор',selection:{budget:500000,cpu:'AMD'},build:{total:1,parts:[]}});
  assert.equal(userTurn.verifiedBuild.total,499999);
  assert.equal(userTurn.verifiedBuild.parts[0].skuOver,'verified-sku');
});
test('parallel requests and unknown session IDs are rejected',async()=>{
  let release;let count=0;
  const service=createChatService({config:configuration,minInterval:0,provider:async()=>{if(++count>1)await new Promise(resolve=>{release=resolve;});return result();}});
  const first=await service.chat({stage:'tasks',message:'Игры',profile});
  const running=service.chat({stage:'tasks',message:'CS2',sessionId:first.sessionId});
  await assert.rejects(service.chat({stage:'tasks',message:'Ещё',sessionId:first.sessionId}),{code:'request_in_progress'});
  release();await running;
  await assert.rejects(service.chat({stage:'tasks',message:'Ещё',sessionId:'missing'}),{code:'session_expired'});
});
test('HTTP endpoint enforces same origin, JSON, size and server-only secrets',async()=>{
  const service=createChatService({config:configuration,provider:async()=>result()});
  const server=createServer({chatService:service});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const status=await (await fetch(base+'/api/status')).json();assert.deepEqual(status,{ready:true,buildsReady:false,builderAvailable:true});
    const catalogStatus=await (await fetch(base+'/api/catalog/status')).json();
    assert.equal(catalogStatus.catalogLoaded,true);assert.equal(catalogStatus.evidenceDatabaseLoaded,true);
    assert.ok(catalogStatus.snapshotAt);assert.ok(catalogStatus.itemCount>0);assert.equal(catalogStatus.buildsReady,false);
    assert.equal(catalogStatus.buildEngineReady,true);
    assert.equal((await fetch(base+'/.secrets/corelab-ai.json')).status,404);
    assert.equal((await fetch(base+'/api/chat',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
    const headers={Origin:base,'Content-Type':'application/json'};
    assert.equal((await fetch(base+'/api/chat',{method:'POST',headers,body:'invalid'})).status,400);
    assert.equal((await fetch(base+'/api/chat',{method:'POST',headers,body:'x'.repeat(17000)})).status,413);
    const response=await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({stage:'tasks',message:'Игры',profile})});
    assert.equal(response.status,200);const content=await response.text();assert.ok(!content.includes('unit-test-key'));assert.ok(content.includes('sessionId'));
    const buildResponse=await fetch(base+'/api/pc-build',{method:'POST',headers,body:JSON.stringify({city:'Алматы',purpose:'Для игр',budget:560000,cpu:'AMD',tasks:'CS2'})});
    assert.equal(buildResponse.status,200);const buildBody=await buildResponse.json();
    assert.ok(buildBody.build.total>0);assert.equal(buildBody.build.parts.some(part=>part.category==='Видеокарты'&&/RTX 50(60|70|80)/.test(part.name)),true);
    assert.ok(buildBody.build.parts.every(part=>!Object.hasOwn(part,'supplier')&&!Object.hasOwn(part,'stock')));
  }finally{await new Promise(resolve=>server.close(resolve));}
});
