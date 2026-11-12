const test=require('node:test');
const assert=require('node:assert/strict');
const {createChatService,callOpenAI,callCorelabAI,decodeResponse,loadConfig}=require('../tools/corelab-ai.cjs');
const {createServer}=require('../tools/preview-app.cjs');
const profile={city:'Другой город',purpose:'Для игр',tasks:'',budget:null,cpu:null};
const configuration=()=>({provider:'openai',model:'test-model',apiKey:'unit-test-key'});
const result=(changes={})=>({reply:'Уточните, в какие игры Вы играете?',tasksClear:false,profile:{...profile},
  action:{kind:'answer',platformSocket:null,changeRequest:null},...changes});

test('structured workload survives omitted preferences, freezes during review and rebuilds when changed',async()=>{
  let workload={version:1,tasks:[{application:'photoshop',operation:'interactive',priority:'primary',complexity:'basic'}]};
  const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{
    const turn=JSON.parse(history.at(-1).content);
    return result({profile:turn.currentProfile,tasksClear:true,action:{kind:'answer',platformSocket:null,
      changeRequest:null,workloadProfile:workload}});
  }});
  const first=await service.chat({stage:'initial_build',message:'Photoshop',profile:{city:'Алматы',
    purpose:'Для работы и творчества',tasks:'Photoshop',budget:800000,cpu:'AMD'}});
  service.recordBuild(first.sessionId,first.profile,{total:700000,parts:[]});
  workload={version:1,tasks:[{application:'blender',operation:'gpu_render',priority:'primary',complexity:'heavy'}]};
  const review=await service.chat({stage:'build_review',sessionId:first.sessionId,message:'Готово'});
  assert.equal(review.partPreferences.workloadProfile.tasks[0].application,'photoshop');
  const change=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Теперь GPU-рендеринг Blender'});
  assert.equal(change.action.kind,'rebuild');
  assert.equal(change.partPreferences.workloadProfile.tasks[0].application,'blender');
});

test('creative and office resolution questions are not rewritten as gaming questions',async()=>{
  for(const purpose of ['Для работы и творчества','Для офиса']){
    const reply='В Photoshop Вы обрабатываете фото какого разрешения и сложности?';
    const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{
      const turn=JSON.parse(history.at(-1).content);
      return result({reply,profile:{...turn.currentProfile,tasks:'Photoshop'},
        action:{kind:'clarify',platformSocket:null,changeRequest:null}});
    }});
    const first=await service.chat({stage:'tasks',message:'фотошоп',profile:{...profile,purpose}});
    assert.equal(first.reply,reply);
    assert.equal(first.tasksClear,false);
    assert.equal(first.profile.purpose,purpose);
    const next=await service.chat({stage:'initial_build',message:'AMD',
      profile:{...profile,purpose,tasks:'Photoshop',budget:500000,cpu:'AMD'},partPreferences:{coolerType:null,skus:{},gamingResolution:'1440p'}});
    assert.equal(next.action.kind,'clarify');
    assert.equal(next.reply,reply);
  }
});

test('workload GPU requirements pass from AI into selection and cannot change during review',async()=>{
  let requirement={mode:'required',minVramGB:12,technology:'cuda'};
  const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{
    const turn=JSON.parse(history.at(-1).content);
    return result({profile:turn.currentProfile,tasksClear:true,action:{kind:'answer',platformSocket:null,
      changeRequest:null,workloadGpu:requirement}});
  }});
  const first=await service.chat({stage:'initial_build',message:'GPU рендеринг',profile:{
    city:'Алматы',purpose:'Для работы и творчества',tasks:'GPU рендеринг',budget:800000,cpu:'AMD'}});
  assert.deepEqual(first.partPreferences.workloadGpu,requirement);
  service.recordBuild(first.sessionId,{...first.profile,partPreferences:first.partPreferences},{total:750000,parts:[]});
  requirement={mode:'not_required',minVramGB:0,technology:null};
  const review=await service.chat({stage:'build_review',sessionId:first.sessionId,message:'Расчет готов',partPreferences:first.partPreferences});
  assert.equal(review.partPreferences.workloadGpu.mode,'required');
  const changed=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Теперь только Word',partPreferences:first.partPreferences});
  assert.equal(changed.partPreferences.workloadGpu.mode,'not_required');
  assert.equal(changed.action.kind,'rebuild');
});
test('missing configuration fails without external call',async()=>{
  await assert.rejects(callOpenAI({provider:'openai'},[],()=>{throw Error('must not call');}),{code:'ai_not_configured'});
  const service=createChatService({config:()=>({})});assert.equal(service.status().ready,false);
});

test('Mini App uses CoreLab settings without reading a local key file',async()=>{
  assert.deepEqual(loadConfig(),{provider:'corelab',organizationId:1});
  const oldBase=process.env.CORELAB_INTERNAL_API;
  const oldSecret=process.env.SESSION_SECRET;
  process.env.CORELAB_INTERNAL_API='http://backend:8000';
  process.env.SESSION_SECRET='unit-signing-secret';
  try{
    const output=await callCorelabAI({provider:'corelab',organizationId:3},[{role:'user',content:'test'}],async(url,options)=>{
      assert.equal(url,'http://backend:8000/api/v1/internal/ai/dialogue?organization_id=3');
      assert.equal(options.headers.Authorization,undefined);
      assert.equal(options.headers['X-CoreLab-AI-Auth'].length,64);
      const payload=JSON.parse(options.body);
      assert.ok(payload.instructions.includes('verifiedBuild'));
      assert.ok(payload.instructions.length<=12000,'instructions fit the backend limit');
      assert.equal(payload.input[0].content,'test');
      return {ok:true,json:async()=>result()};
    });
    assert.equal(output.reply,result().reply);
  }finally{
    if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;
    if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;
  }
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

test('CoreLab quota and rate limits remain distinct without exposing provider details',async()=>{
  const oldBase=process.env.CORELAB_INTERNAL_API;
  const oldSecret=process.env.SESSION_SECRET;
  process.env.CORELAB_INTERNAL_API='http://backend:8000';
  process.env.SESSION_SECRET='unit-test-secret';
  try{
    for(const [status,code] of [[402,'ai_quota_exceeded'],[429,'ai_rate_limited'],[504,'ai_timeout']]){
      await assert.rejects(callCorelabAI({organizationId:1},[],async()=>({
        ok:false,status,json:()=>{throw Error('must not expose remote details');}
      })),{status,code});
    }
    await assert.rejects(callCorelabAI({organizationId:1},[],async()=>{
      const error=new Error('private transport details');error.name='TimeoutError';throw error;
    }),{status:504,code:'ai_timeout'});
  }finally{
    if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;
    if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;
  }
});
test('provider errors never expose remote body',async()=>{
  await assert.rejects(callOpenAI(configuration(),[],async()=>({ok:false,status:401,json:()=>{throw Error('must not read error body');}})),{code:'ai_auth_failed'});
  await assert.rejects(callOpenAI(configuration(),[],async()=>({ok:false,status:429,json:()=>{throw Error('must not read error body');}})),{code:'ai_rate_limited',status:429});
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
  const retry=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Подведите итог',selection:{budget:500000,cpu:'AMD'}});
  assert.equal(retry.profile.budget,500000);
  await assert.rejects(service.chat({stage:'discussion',sessionId:first.sessionId,message:'Ещё',selection:{budget:10,cpu:'Intel'}}),{code:'invalid_request'});
});
test('resolution is asked once by buttons even if the model repeats the question',async()=>{
  const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{
    const turn=JSON.parse(history.at(-1).content);
    return result({profile:{...turn.currentProfile,tasks:'CS2, PUBG'},tasksClear:false,
      reply:'В каком разрешении Вы планируете играть?',
      action:{kind:'clarify',platformSocket:null,changeRequest:null}});
  }});
  const first=await service.chat({stage:'tasks',message:'CS2, PUBG',profile});
  assert.equal(first.tasksClear,true);
  assert.doesNotMatch(first.reply,/в каком разрешении/i);
  const next=await service.chat({stage:'initial_build',sessionId:first.sessionId,message:'AMD',
    selection:{budget:990000,cpu:'AMD'},
    partPreferences:{coolerType:null,skus:{},gamingResolution:'1440p'}});
  assert.equal(next.action.kind,'rebuild');
  assert.doesNotMatch(next.reply,/в каком разрешении/i);
});
test('an explicit resolution change in discussion overrides the old button choice',async()=>{
  const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{
    const turn=JSON.parse(history.at(-1).content);
    return result({profile:turn.currentProfile,
      action:{kind:'answer',platformSocket:null,changeRequest:null}});
  }});
  const first=await service.chat({stage:'initial_build',message:'AMD',profile:{
    city:'Алматы',purpose:'Для игр',tasks:'Cyberpunk 2077',budget:900000,cpu:'AMD'},
    partPreferences:{coolerType:null,skus:{},gamingResolution:'1440p'}});
  const question=await service.chat({stage:'discussion',sessionId:first.sessionId,
    message:'Почему для 4K нужна другая видеокарта?',partPreferences:first.partPreferences});
  assert.equal(question.partPreferences.gamingResolution,'1440p');
  const changed=await service.chat({stage:'discussion',sessionId:first.sessionId,
    message:'Хочу играть в 4К вместо 2К',partPreferences:question.partPreferences});
  assert.equal(changed.partPreferences.gamingResolution,'4K');
  const final=await service.chat({stage:'discussion',sessionId:first.sessionId,
    message:'Перейти с 4К на 2К',partPreferences:changed.partPreferences});
  assert.equal(final.partPreferences.gamingResolution,'1440p');
  assert.equal(final.action.kind,'rebuild');
});
test('first build decision uses prior answers and review sees only a server-recorded build',async()=>{
  const turns=[];
  const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{
    const turn=JSON.parse(history.at(-1).content);turns.push(turn);
    return result({tasksClear:true,profile:{...turn.currentProfile,tasks:turn.stage==='tasks'?'CS2 и монтаж видео':turn.currentProfile.tasks},
      reply:turn.stage==='build_review'?'Сборка отвечает задачам клиента.':'Проверяю условия.'});
  }});
  const first=await service.chat({stage:'tasks',message:'CS2 и монтаж видео',profile:{
    city:'Павлодар',purpose:'Для работы и творчества',tasks:'',budget:null,cpu:null}});
  const planned=await service.chat({stage:'initial_build',sessionId:first.sessionId,message:'AMD',
    selection:{budget:1200000,cpu:'AMD'}});
  assert.equal(planned.action.kind,'rebuild');
  assert.equal(turns[1].currentProfile.tasks,'CS2 и монтаж видео');
  assert.equal(turns[1].currentProfile.city,'Павлодар');
  assert.equal(turns[1].currentProfile.budget,1200000);
  assert.equal(turns[1].verifiedBuild,null);
  await assert.rejects(service.chat({stage:'build_review',sessionId:first.sessionId,message:'Оцени сборку'}),{code:'no_verified_build'});
  const build={city:'Павлодар',budget:1200000,total:1100000,parts:[{category:'Процессоры',name:'Ryzen',skuOver:'trusted'}]};
  assert.equal(service.recordBuild(first.sessionId,{...planned.profile},build),true);
  const reviewed=await service.chat({stage:'build_review',sessionId:first.sessionId,message:'Оцени сборку'});
  assert.equal(turns.at(-1).verifiedBuild.parts[0].skuOver,'trusted');
  assert.equal(reviewed.action.kind,'answer');
  assert.equal(reviewed.reply,'Сборка отвечает задачам клиента.');
  assert.equal(service.recordBuild(first.sessionId,{...planned.profile,budget:1},{...build,total:1}),false);
});
test('AI platform recommendation constrains the first build without overriding the chosen CPU vendor',async()=>{
  const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{
    const turn=JSON.parse(history.at(-1).content);
    return result({profile:turn.currentProfile,action:{kind:'rebuild',platformSocket:'AM5',changeRequest:null}});
  }});
  const amd=await service.chat({stage:'initial_build',message:'AMD',profile:{
    city:'Алматы',purpose:'Для игр',tasks:'Игры',budget:1200000,cpu:'AMD'}});
  assert.equal(amd.partPreferences.platformPreference,'AM5');
  assert.equal(amd.profile.cpu,'AMD');
  const intel=await service.chat({stage:'initial_build',message:'Intel',profile:{
    city:'Алматы',purpose:'Для игр',tasks:'Игры',budget:1200000,cpu:'Intel'}});
  assert.equal(intel.partPreferences.platformPreference,undefined);
  assert.equal(intel.profile.cpu,'Intel');
});
test('builder rejection returns to the same AI session with verified build context',async()=>{
  const turns=[];
  const service=createChatService({config:configuration,minInterval:1500,provider:async(c,history)=>{
    const turn=JSON.parse(history.at(-1).content);turns.push(turn);
    return result({profile:turn.currentProfile,reply:'Уточните желаемый результат без артикула.'});
  }});
  const first=await service.chat({stage:'initial_build',message:'AMD',profile:{
    city:'Алматы',purpose:'Для игр',tasks:'Игры',budget:1200000,cpu:'AMD'}});
  const request={...first.profile};
  assert.equal(service.recordBuild(first.sessionId,request,{total:1100000,parts:[{skuOver:'current-cpu'}]}),true);
  assert.equal(service.recordBuildError(first.sessionId,{...request,changeRequest:'Замените процессор'},
    {error:'part_request_not_found'}),true);
  const feedback=await service.chat({stage:'build_feedback',sessionId:first.sessionId,message:'Хочу процессор мощнее'});
  assert.equal(turns.at(-1).builderError.code,'part_request_not_found');
  assert.equal(turns.at(-1).verifiedBuild,null);
  assert.equal(turns.at(-1).previousBuild.parts[0].skuOver,'current-cpu');
  assert.equal(feedback.action.kind,'answer');
  assert.equal(feedback.reply,'Уточните желаемый результат без артикула.');
});
test('failed followup does not append history or corrupt profile',async()=>{
  let fail=false;let seen;
  const service=createChatService({config:configuration,minInterval:0,provider:async(c,history)=>{seen=history;if(fail)throw Error('failure');return result();}});
  const first=await service.chat({stage:'tasks',message:'Игры',profile});fail=true;
  await assert.rejects(service.chat({stage:'tasks',message:'CS2',sessionId:first.sessionId}));fail=false;
  await service.chat({stage:'tasks',message:'CS2',sessionId:first.sessionId});assert.equal(seen.length,3);
});
test('discussion classifies first, then uses a server build and never trusts a client build payload',async()=>{
  let userTurn;let builtBudget;
  const service=createChatService({config:configuration,minInterval:0,buildProvider:p=>{builtBudget=p.budget;return {ok:true,build:{total:p.budget-1,parts:[{skuOver:'verified-sku',price:100}]}};},provider:async(c,history)=>{
    userTurn=JSON.parse(history.at(-1).content);return result();
  }});
  const first=await service.chat({stage:'tasks',message:'Игры',profile});
  const answer=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Сколько стоит?',selection:{budget:500000,cpu:'AMD'},build:{total:1,parts:[]}});
  assert.equal(userTurn.verifiedBuild,null);
  assert.equal(userTurn.currentProfile.budget,500000);
  assert.equal(builtBudget,500000);
  assert.match(answer.reply,/499\s?999/);
});

test('discussion recalculates with the selected part constraint',async()=>{
  let received;
  const service=createChatService({config:configuration,minInterval:0,
    buildProvider:p=>{received=p.partPreferences;return {ok:true,build:{parts:[]}};},
    provider:async(c,history)=>result({profile:JSON.parse(history.at(-1).content).currentProfile})});
  const first=await service.chat({stage:'tasks',message:'Офис',profile});
  await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Проверь сборку',
    selection:{budget:500000,cpu:'AMD'},partPreferences:{coolerType:'air',skus:{}}});
  assert.deepEqual(received,{coolerType:'air',skus:{}});
});
test('structured customer selection overrides an inconsistent AI profile',async()=>{
  let builtBudget;
  const service=createChatService({config:configuration,minInterval:0,
    buildProvider:p=>{builtBudget=p.budget;return {ok:true,build:{budget:p.budget,total:p.budget-1,parts:[]}};},
    provider:async(c,input)=>{
      const turn=JSON.parse(input.at(-1).content);
      if(input.length===1)return result({profile:turn.currentProfile});
      assert.equal(turn.verifiedBuild,null);
      return {reply:'Старая сборка за 500 000 ₸ подходит.',tasksClear:true,
        profile:{...turn.currentProfile,budget:700000}};
    }});
  const first=await service.chat({stage:'tasks',message:'CS2',profile});
  const next=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Подведите итог',
    selection:{budget:500000,cpu:'AMD'}});
  assert.equal(builtBudget,500000);
  assert.equal(next.profile.budget,500000,'the explicit selector must stay authoritative on its turn');
  assert.doesNotMatch(next.reply,/Старая сборка|500 000/);
});

test('a later customer change suppresses stale build text until recalculation',async()=>{
  const service=createChatService({config:configuration,minInterval:0,
    buildProvider:p=>({ok:true,build:{budget:p.budget,total:p.budget-1,parts:[]}}),
    provider:async(c,input)=>{
      const turn=JSON.parse(input.at(-1).content);
      return {reply:'Подходит старая сборка за 500 000 ₸.',tasksClear:true,
        profile:input.length>3?{...turn.currentProfile,budget:700000}:turn.currentProfile};
    }});
  const first=await service.chat({stage:'tasks',message:'CS2',profile});
  await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Начнём',selection:{budget:500000,cpu:'AMD'}});
  const changed=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Новый бюджет 700000'});
  assert.equal(changed.profile.budget,700000);
  assert.match(changed.reply,/Условия изменены/);
  assert.doesNotMatch(changed.reply,/500 000/);
});
test('AM5 request after a proposal skips the stale build and preserves the socket constraint',async()=>{
  let builds=0;
  const service=createChatService({config:configuration,minInterval:0,
    buildProvider:()=>{builds++;return {ok:true,build:{total:1100000,parts:[]}};},
    provider:async(c,input)=>({reply:'Хорошо',tasksClear:true,
      profile:JSON.parse(input.at(-1).content).currentProfile,
      action:{kind:input.at(-1).content.includes('AM5')?'rebuild':'answer',
        platformSocket:input.at(-1).content.includes('AM5')?'AM5':null,changeRequest:null}})});
  const first=await service.chat({stage:'tasks',message:'Игры',profile});
  await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Покажите сборку',
    selection:{budget:1200000,cpu:'AMD'}});
  assert.equal(builds,1);
  const changed=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Замени старый AM4 на AM5',
    partPreferences:{coolerType:null,skus:{}}});
  assert.equal(builds,1);
  assert.equal(changed.profile.cpu,'AMD');
  assert.equal(changed.partPreferences.platformPreference,'AM5');
  assert.match(changed.reply,/Условия изменены/);
});
test('AI cannot describe a build when the server has no verified variant',async()=>{
  const service=createChatService({config:configuration,minInterval:0,
    buildProvider:()=>({ok:false,code:'no_verified_build'}),
    provider:async(c,input)=>({reply:'Готова сборка за 400 000 ₸ с RTX.',tasksClear:true,
      profile:JSON.parse(input.at(-1).content).currentProfile})});
  const first=await service.chat({stage:'tasks',message:'CS2',profile});
  const next=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Покажите сборку',
    selection:{budget:500000,cpu:'AMD'}});
  assert.match(next.reply,/нет полного проверенного варианта/);
  assert.doesNotMatch(next.reply,/RTX|400 000/);
});
test('AI cannot introduce fabricated parts, prices or performance into a verified reply',async()=>{
  const service=createChatService({config:configuration,minInterval:0,
    buildProvider:()=>({ok:true,build:{total:300000,parts:[{category:'Видеокарты',name:'RTX 5060'}]}}),
    provider:async(c,input)=>({reply:'RTX 5090 за 50 000 ₸ даст 300 FPS.',tasksClear:true,
      profile:JSON.parse(input.at(-1).content).currentProfile})});
  const first=await service.chat({stage:'tasks',message:'Игры',profile});
  const next=await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Сколько стоит?',
    selection:{budget:500000,cpu:'AMD'}});
  assert.match(next.reply,/300\s?000 ₸/);
  assert.doesNotMatch(next.reply,/5090|50 000|FPS/);
});
test('an old verified build is absent from later model history',async()=>{
  let currentSku='old-sku';const inputs=[];
  const service=createChatService({config:configuration,minInterval:0,
    buildProvider:()=>({ok:true,build:{parts:[{skuOver:currentSku}],rulesVersion:currentSku}}),
    provider:async(c,input)=>{inputs.push(input);const turn=JSON.parse(input.at(-1).content);
      return result({profile:turn.currentProfile});}});
  const first=await service.chat({stage:'tasks',message:'Игры',profile});
  await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Сборка',selection:{budget:500000,cpu:'AMD'}});
  currentSku='new-sku';
  await service.chat({stage:'discussion',sessionId:first.sessionId,message:'Пересчитай'});
  assert.equal(JSON.parse(inputs[2].at(-1).content).verifiedBuild,null);
  assert.ok(!JSON.stringify(inputs[2].slice(0,-1)).includes('old-sku'));
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
  const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
  const local=createBuildFixture();
  const server=createServer({chatService:service,buildDataProvider:async()=>local});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const status=await (await fetch(base+'/api/status')).json();assert.deepEqual(status,{ready:true,buildsReady:false,builderAvailable:true,catalogLoaded:true,cities:[]});
    const logo=await fetch(base+'/corelab-logo.png');assert.equal(logo.status,200);assert.match(logo.headers.get('content-type'),/image\/png/);assert.deepEqual([...new Uint8Array(await logo.arrayBuffer()).slice(0,8)],[137,80,78,71,13,10,26,10]);
    const catalogStatus=await (await fetch(base+'/api/catalog/status')).json();
    assert.equal(catalogStatus.catalogLoaded,true);assert.equal(catalogStatus.catalogSource,'test');
    assert.ok(catalogStatus.itemCount>0);assert.equal(catalogStatus.buildsReady,false);
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

test('builder uses only provider products and fails closed when CoreLab is unavailable', async()=>{
  const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
  const local=createBuildFixture();
  const allowed=new Set(local.getBuildCandidates('Алматы').map(row=>row.skuOver));
  assert.ok(allowed.delete('1'));
  const filtered=createServer({buildDataProvider:async()=>({getBuildCandidates:city=>local.getBuildCandidates(city).filter(row=>allowed.has(row.skuOver)),status:()=>local.status()})});
  await new Promise(resolve=>filtered.listen(0,'127.0.0.1',resolve));
  const filteredBase=`http://127.0.0.1:${filtered.address().port}`;
  const body=JSON.stringify({city:'Алматы',purpose:'Для офиса',budget:560000,cpu:'Intel'});
  try{
    const response=await fetch(filteredBase+'/api/pc-build',{method:'POST',
      headers:{Origin:filteredBase,'Content-Type':'application/json'},body});
    assert.equal(response.status,422);
    assert.equal((await response.json()).error,'no_verified_build');
  }finally{await new Promise(resolve=>filtered.close(resolve));}
  const server=createServer({buildDataProvider:async()=>({getBuildCandidates:()=>[],status:()=>local.status()})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Origin:base,'Content-Type':'application/json'};
  try{
    const empty=await fetch(base+'/api/pc-build',{method:'POST',headers,body});
    assert.equal(empty.status,422);
    assert.equal((await empty.json()).error,'no_verified_build');
  }finally{await new Promise(resolve=>server.close(resolve));}
  const offline=createServer({buildDataProvider:async()=>{throw new Error('corelab_catalog_unavailable');}});
  await new Promise(resolve=>offline.listen(0,'127.0.0.1',resolve));
  const offlineBase=`http://127.0.0.1:${offline.address().port}`;
  try{
    const response=await fetch(offlineBase+'/api/pc-build',{method:'POST',headers:{...headers,Origin:offlineBase},body});
    assert.equal(response.status,503);
    assert.equal((await response.json()).error,'corelab_catalog_unavailable');
  }finally{await new Promise(resolve=>offline.close(resolve));}
});
