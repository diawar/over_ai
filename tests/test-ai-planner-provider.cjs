const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createPlannerProvider}=require('../tools/ai-planner-provider.cjs');
test('provider signs exact body and rejects oversized input before payment',async()=>{
 const oldBase=process.env.CORELAB_INTERNAL_API,oldSecret=process.env.SESSION_SECRET;
 process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test-secret';let calls=0;
 try{const p=createPlannerProvider({organizationId:7,fetcher:async(url,options)=>{calls++;assert.match(url,/organization_id=7$/);const digest=crypto.createHash('sha256').update(options.body).digest('hex');assert.equal(options.headers['X-CoreLab-AI-Auth'],crypto.createHmac('sha256','test-secret').update(`${options.headers['X-CoreLab-AI-Timestamp']}:7:${digest}`).digest('hex'));assert.ok(JSON.parse(options.body).input.every(t=>t.content.length<=10000));return {ok:true,json:async()=>({action:'stop'})};}});
 assert.equal((await p({instructions:'test',schema:{},input:[{role:'user',content:'a'.repeat(12000)}]})).action,'stop');await assert.rejects(p({instructions:'test',schema:{},input:[{role:'user',content:'я'.repeat(30000)}]}),/ai_context_limit/);assert.equal(calls,1);
 }finally{if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;}
});
test('spacing can be cancelled without sending another paid request',async()=>{
 const oldBase=process.env.CORELAB_INTERNAL_API,oldSecret=process.env.SESSION_SECRET;process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';let calls=0;
 try{const p=createPlannerProvider({organizationId:1,minIntervalMs:1000,fetcher:async()=>{calls++;return {ok:true,json:async()=>({})}}});const args={instructions:'x',schema:{},input:[{role:'user',content:'x'}]};await p(args);const c=new AbortController();const pending=p({...args,signal:c.signal});c.abort();await assert.rejects(pending);assert.equal(calls,1);}finally{if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;}
});
test('Kimi command adapter uses reasoning only after details and optional query fields',async()=>{
 const oldBase=process.env.CORELAB_INTERNAL_API,oldSecret=process.env.SESSION_SECRET;process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';const modes=[];
 try{const p=createPlannerProvider({organizationId:1,structuredCommands:'kimi',reasoningMode:'adaptive',fetcher:async(url,options)=>{const b=JSON.parse(options.body);modes.push(b.mode);assert.deepEqual(b.schema.properties.queries.items.required,[]);return {ok:true,json:async()=>({action:'stop',queries:[],skus:[],parts:[],explanation:''})}}});
 const base={instructions:'test',schema:{},input:[{role:'user',content:'{"request":{},"catalog":{}}'}]};await p(base);await p({...base,input:[...base.input,{role:'user',content:JSON.stringify({tool:'details',result:{items:Array.from({length:6},(_,i)=>({skuOver:String(i)}))}})}]});assert.deepEqual(modes,['dialogue','planner']);
 }finally{if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;}
});

test('complete category coverage never forbids searching for a feasible alternative',async()=>{
 const oldBase=process.env.CORELAB_INTERNAL_API,oldSecret=process.env.SESSION_SECRET;process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';const enums=[];
 try{const p=createPlannerProvider({organizationId:1,structuredCommands:'kimi',fetcher:async(url,o)=>{enums.push(JSON.parse(o.body).schema.properties.action.enum);return {ok:true,json:async()=>({action:'stop',queries:[],skus:[],parts:[],explanation:''})}}});const categories=['Процессоры','Материнские платы','Оперативная память','Твердотельные диски (SSD)','Блоки питания','Корпуса','Кулеры для процессоров'];const input=[{role:'user',content:'{"request":{"purpose":"Для офиса"}}'},{role:'user',content:JSON.stringify({tool:'details',result:{items:categories.map((category,i)=>({category,skuOver:String(i)}))}})}];await p({instructions:'',schema:{},input});await p({instructions:'',schema:{},input:[...input,{role:'user',content:JSON.stringify({tool:'propose',result:{ok:false,violations:[{code:'cooling_mismatch'}]}})}]});assert.deepEqual(enums[0],['batch','details','propose','stop']);assert.ok(enums[1].includes('batch'));await p({instructions:'',schema:{},input:[...input,{role:'user',content:JSON.stringify({tool:'propose',result:{ok:false,violations:[{code:'cooling_mismatch'}]}})},input[1]]});assert.ok(enums[2].includes('batch'));
 }finally{if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;}
});

test('search candidates move the model to inspection before more searches',async()=>{
 const oldBase=process.env.CORELAB_INTERNAL_API,oldSecret=process.env.SESSION_SECRET;process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';
 try{const p=createPlannerProvider({organizationId:1,structuredCommands:'kimi',fetcher:async(url,o)=>{assert.deepEqual(JSON.parse(o.body).schema.properties.action.enum,['details','stop']);return {ok:true,json:async()=>({action:'details',queries:[],skus:['001'],parts:[],explanation:''})}}});const r=await p({instructions:'',schema:{},input:[{role:'user',content:'{"request":{}}'},{role:'user',content:JSON.stringify({previouslySeenCandidates:{items:Array.from({length:8},(_,i)=>[String(i),'CPU',100,1,'Процессоры'])}})}]});assert.equal(r.action,'details');
 }finally{if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;}
});

test('empty repair search keeps search open instead of forcing stale candidate details',async()=>{
 const oldBase=process.env.CORELAB_INTERNAL_API,oldSecret=process.env.SESSION_SECRET;
 process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';
 const enums=[];
 try{
  const p=createPlannerProvider({organizationId:1,structuredCommands:'kimi',fetcher:async(url,o)=>{enums.push(JSON.parse(o.body).schema.properties.action.enum);return {ok:true,json:async()=>({action:'stop',queries:[],skus:[],parts:[],explanation:''})}}});
  const base=[{role:'user',content:JSON.stringify({request:{}})},{role:'user',content:JSON.stringify({tool:'propose',result:{ok:false}})},{role:'user',content:JSON.stringify({previouslySeenCandidates:{items:[['old','Board',100,1,'Материнские платы']]}})}];
  for(const total of [0,1])await p({instructions:'',schema:{},input:[...base,{role:'user',content:JSON.stringify({tool:'batch',result:{results:[{result:{total}}]}})}]});
  assert.ok(enums[0].includes('batch'));assert.deepEqual(enums[1],['details','stop']);
 }finally{if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;}
});

test('partial inspection leaves search available to fill missing component categories',async()=>{
 const oldBase=process.env.CORELAB_INTERNAL_API,oldSecret=process.env.SESSION_SECRET;process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';
 try{
 const p=createPlannerProvider({organizationId:1,structuredCommands:'kimi',fetcher:async(url,o)=>{assert.ok(JSON.parse(o.body).schema.properties.action.enum.includes('batch'));return {ok:true,json:async()=>({action:'stop',queries:[],skus:[],parts:[],explanation:''})}}});
 await p({instructions:'',schema:{},input:[{role:'user',content:JSON.stringify({request:{}})},{role:'user',content:JSON.stringify({tool:'details',result:{items:[{skuOver:'cpu',category:'Процессоры'}]}})},{role:'user',content:JSON.stringify({tool:'batch',result:{results:[{result:{total:2}}]}})}]});
 }finally{if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;}
});





test('two fruitful searches require inspection, while empty searches remain available',async()=>{
 const oldBase=process.env.CORELAB_INTERNAL_API,oldSecret=process.env.SESSION_SECRET;process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';
 const enums=[];
 try{
  const p=createPlannerProvider({organizationId:1,structuredCommands:true,fetcher:async(url,o)=>{enums.push(JSON.parse(o.body).schema.properties.action.enum);return {ok:true,json:async()=>({action:'stop',queries:[],skus:[],parts:[]})};}});
  const turn=data=>({role:'user',content:JSON.stringify(data)}),command={role:'assistant',content:JSON.stringify({action:'batch',arguments:'{"queries":[{}]}'})};
  const input=[turn({request:{}}),turn({tool:'details',result:{items:[{skuOver:'old'}]}}),command,command];
  for(const total of [1,0])await p({instructions:'',schema:{},input:[...input,turn({tool:'batch',result:{results:[{result:{total}}]}}),turn({previouslySeenCandidates:{items:[['new','item',10,1]]}})]});
  assert.deepEqual(enums[0],['details','propose','stop']);assert.ok(enums[1].includes('batch'));
 }finally{if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;}
});
test('fast OpenAI effort is explicit and leaves default mode intact',async()=>{
 const oldBase=process.env.CORELAB_INTERNAL_API,oldSecret=process.env.SESSION_SECRET;process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';const modes=[];
 try{
  for(const effort of ['low','medium'])await createPlannerProvider({organizationId:1,structuredCommands:true,openaiEffort:effort,fetcher:async(url,o)=>{modes.push(JSON.parse(o.body).mode);return {ok:true,json:async()=>({action:'stop',queries:[],skus:[],parts:[]})};}})({input:[{role:'user',content:'{"request":{}}'}]});
  assert.deepEqual(modes,['planner_fast','dialogue']);
  assert.throws(()=>createPlannerProvider({organizationId:1,openaiEffort:'low'}),/invalid_openai_effort/);
 }finally{if(oldBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=oldBase;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;}
});
