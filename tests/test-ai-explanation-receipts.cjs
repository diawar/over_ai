const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createPlannerProvider}=require('../tools/ai-planner-provider.cjs');
const args={instructions:'Explain',input:[{role:'user',content:'validated build'}],schema:{}};
function setup(t){
 const old={base:process.env.CORELAB_INTERNAL_API,secret:process.env.SESSION_SECRET};
 process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';
 t.after(()=>{for(const [key,value] of [['CORELAB_INTERNAL_API',old.base],['SESSION_SECRET',old.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
}
const response=data=>({ok:true,json:async()=>data});

test('explanation polls a durable receipt with a signed scoped GET',async t=>{
 setup(t);let posts=0,gets=0,id;
 const provider=createPlannerProvider({organizationId:2,explanationMode:true,fetcher:async(url,options)=>{
  if(options.method==='POST'){posts++;id=JSON.parse(options.body).request_id;assert.match(id,/^[a-f0-9]{64}$/);return response({request_id:id,status:'running'});}
  gets++;assert.ok(url.endsWith(`/explanations/${id}?organization_id=2`));
  const digest=crypto.createHash('sha256').update(`explanation:${id}`).digest('hex');
  assert.equal(options.headers['X-CoreLab-AI-Auth'],crypto.createHmac('sha256','test').update(`${options.headers['X-CoreLab-AI-Timestamp']}:2:${digest}`).digest('hex'));
  return response({request_id:id,status:'completed',result:{summary:'saved'}});
 }});
 assert.deepEqual(await provider(args),{summary:'saved'});assert.equal(posts,1);assert.equal(gets,1);
});

test('cancelled wait can resume with GET only and identical inputs reuse ID',async t=>{
 setup(t);let id,posts=0,completed=false;
 const controller=new AbortController();
 const provider=createPlannerProvider({organizationId:1,explanationMode:true,fetcher:async(url,options)=>{
  if(options.method==='POST'){
   posts++;const next=JSON.parse(options.body).request_id;if(id)assert.equal(next,id);id=next;
   if(!completed)controller.abort(Error('client_deadline'));
  }
  return response({request_id:id,status:completed?'completed':'running',result:{summary:'saved'}});
 }});
 await assert.rejects(provider({...args,signal:controller.signal}),error=>error.requestId===id&&error.message==='client_deadline');
 completed=true;
 assert.deepEqual(await provider.resumeExplanation({requestId:id}),{summary:'saved'});
 assert.equal(posts,1);
 assert.deepEqual(await provider(args),{summary:'saved'});
 assert.equal(posts,2); // A repeated POST has the same receipt ID, never a new generation.
});

test('stored failure and wrong receipt never trigger another submission',async t=>{
 setup(t);let calls=0;
 const id='a'.repeat(64);
 const p=createPlannerProvider({organizationId:1,explanationMode:true,fetcher:async()=>{calls++;return response({request_id:id,status:'failed',error:'ai_http_504'});}});
 await assert.rejects(p.resumeExplanation({requestId:id}),/ai_http_504/);assert.equal(calls,1);
 const wrong=createPlannerProvider({organizationId:1,explanationMode:true,fetcher:async()=>response({request_id:'b'.repeat(64),status:'completed',result:{}})});
 await assert.rejects(wrong.resumeExplanation({requestId:id}),/ai_invalid_response/);
});
