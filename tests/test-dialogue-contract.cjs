const test=require('node:test'),assert=require('node:assert/strict');
const {validateWorkload}=require('../tools/workload-profile.cjs');
const {createChatService}=require('../tools/corelab-ai.cjs');
test('identical workload duplicates collapse, conflicting priorities do not',()=>{
 const task={application:'gaming',operation:'interactive',priority:'primary',complexity:'unknown'};
 assert.equal(validateWorkload({version:1,tasks:[task,{...task}]}).tasks.length,1);
 assert.throws(()=>validateWorkload({version:1,tasks:[task,{...task,complexity:'heavy'}]}));
});
test('a clarification cannot advance to budget even if AI marks tasks clear',async()=>{
 const profile={city:'Павлодар',purpose:'Для офиса',tasks:'1С',budget:null,cpu:null,graphicsPreference:null};
 const service=createChatService({config:()=>({}),provider:async()=>({profile,reply:'Уточните размер базы?',tasksClear:true,action:{kind:'answer',platformSocket:null,changeRequest:null}})});
 const result=await service.chat({stage:'tasks',message:'1С',profile});
 assert.equal(result.tasksClear,false);assert.equal(result.action.kind,'clarify');
});
test('acknowledged tasks do not advertise model-invented buttons',async()=>{
 const profile={city:'Павлодар',purpose:'Для игр',tasks:'CS2 и Dota 2',budget:null,cpu:null,graphicsPreference:null};
 const service=createChatService({config:()=>({}),provider:async()=>({profile,reply:'Задачи понятны. Кнопки FPS появятся ниже.',tasksClear:true,action:{kind:'clarify',platformSocket:null,changeRequest:null}})});
 const result=await service.chat({stage:'tasks',message:'CS2 и Dota 2',profile});
 assert.equal(result.tasksClear,true);assert.equal(result.action.kind,'answer');assert.doesNotMatch(result.reply,/кнопк/iu);
});
test('task collection cannot invent an AM5/AMD preference',async()=>{
 const profile={city:'Павлодар',purpose:'Для работы и творчества',tasks:'Blender CPU',budget:null,cpu:null,graphicsPreference:null};
 const service=createChatService({config:()=>({}),provider:async()=>({profile:{...profile,cpu:'AMD'},reply:'Задачи понятны.',tasksClear:true,action:{kind:'answer',platformSocket:'AM5',changeRequest:null}})});
 const result=await service.chat({stage:'tasks',message:'Blender CPU',profile});
 assert.equal(result.profile.cpu,null);assert.equal(result.action.platformSocket,null);assert.ok(!result.partPreferences.platformPreference);
});
test('explicit customer platform survives task collection',async()=>{
 for(const [cpu,socket] of [['AMD','AM5'],['Intel','LGA1700']]){
 const profile={city:'Павлодар',purpose:'Для офиса',tasks:'Word',budget:null,cpu:null,graphicsPreference:null};
 const service=createChatService({config:()=>({}),provider:async()=>({profile:{...profile,cpu},reply:'Задачи понятны.',tasksClear:true,action:{kind:'answer',platformSocket:socket,changeRequest:null}})});
 const result=await service.chat({stage:'tasks',message:`Word, хочу ${cpu} ${socket}`,profile});
 assert.equal(result.profile.cpu,cpu);assert.equal(result.action.platformSocket,socket);
 }
});
