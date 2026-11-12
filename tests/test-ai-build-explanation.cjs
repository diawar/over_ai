const test=require('node:test'),assert=require('node:assert/strict');
const {explainValidatedBuild}=require('../tools/ai-build-explanation.cjs');
const cards=[{skuOver:'a',category:'GPU',price:100,specifications:{memoryGB:16},performance:{workload:null}},{skuOver:'b',category:'GPU',price:80,specifications:{memoryGB:12}}];
const catalog={snapshotId:'s',customerRequest:()=>({budget:200}),details:({skus})=>({items:cards.filter(c=>skus.includes(c.skuOver))}),validate:({parts})=>({ok:parts.every(p=>p.skuOver==='a'),snapshotId:'s',parts,total:parts.reduce((n,p)=>n+cards.find(c=>c.skuOver===p.skuOver).price*p.quantity,0),warnings:['USB needs checking'],violations:parts.some(p=>p.skuOver==='b')?[{code:'incompatible'}]:[]})};
const validation={ok:true,snapshotId:'s',parts:[{skuOver:'a',quantity:1}],total:999};
const reply=()=>({summary:'Сборка для задач.',reasons:[{text:'Ёмкость памяти.',evidence:[{skuOver:'a',field:'specifications.memoryGB'}]}],tradeoffs:[],alternatives:[{replacements:[{skuOver:'b',quantity:2}],assessment:'Меньшая память.'}],limitations:['Данные неполные.']});
test('explanation resolves recorded facts, calculates quantity prices and preserves rejected alternatives',async()=>{
 const result=await explainValidatedBuild({catalog,validation,inspectedSkus:['b'],provider:async()=>reply()});
 assert.equal(result.baselineTotal,100);assert.equal(result.reasons[0].evidence[0].value,16);
 assert.equal(result.alternatives[0].validation.total,160);assert.equal(result.alternatives[0].priceDifference,60);
 assert.equal(result.alternatives[0].validation.ok,false);assert.deepEqual(result.validationWarnings,['USB needs checking']);
 assert.equal(result.narrativeVerified,false);
});
test('unvalidated builds never invoke paid explanation',async()=>{
 let calls=0;await assert.rejects(explainValidatedBuild({catalog,validation:{...validation,snapshotId:'other'},provider:async()=>{calls++;}}),/unvalidated/);assert.equal(calls,0);
});

test('changed build report retains previous evidence and recalculates its full cost',async()=>{
 const c={...catalog,validate:({parts})=>({ok:true,snapshotId:'s',parts,total:parts.reduce((sum,p)=>sum+cards.find(c=>c.skuOver===p.skuOver).price*p.quantity,0),warnings:[]})};
 const current={...validation,parts:[{skuOver:'b',quantity:1}]};
 const report=await explainValidatedBuild({catalog:c,validation:current,comparisonBaseline:validation,inspectedSkus:Array.from({length:20},(_,i)=>'unused'+i),provider:async({input,instructions})=>{
  const data=JSON.parse(input[0].content);assert.equal(data.previousValidatedBuild.total,100);
  assert.equal(data.previousValidatedBuild.priceDifference,-20);assert.ok(data.cards.some(c=>c.skuOver==='a'));
  assert.match(instructions,/Savings are not proof/);
  const r=reply();r.alternatives=[];return r;
 }});
 assert.equal(report.previousBuildTotal,100);assert.equal(report.baselineTotal,80);assert.equal(report.priceDifference,-20);assert.equal(report.narrativeVerified,false);
 await assert.rejects(explainValidatedBuild({catalog:c,validation:current,comparisonBaseline:{...validation,snapshotId:'other'},provider:()=>assert.fail('must not pay')}),/unvalidated/);
});
test('unknown or null evidence cannot be presented as verified',async()=>{
 for(const ref of [{skuOver:'fake',field:'specifications.memoryGB'},{skuOver:'a',field:'specifications.fake'},{skuOver:'a',field:'performance.workload'}]){
  await assert.rejects(explainValidatedBuild({catalog,validation,provider:async()=>{const r=reply();r.reasons[0].evidence=[ref];return r;}}),/invalid_evidence/);
 }
});
test('uninspected alternative is rejected instead of fetched or trusted',async()=>{
 await assert.rejects(explainValidatedBuild({catalog,validation,provider:async()=>reply()}),/invalid_alternative/);
});
test('price references use the catalog unit price rather than model-supplied amounts',async()=>{
 const result=await explainValidatedBuild({catalog,validation,inspectedSkus:['b'],provider:async()=>{const r=reply();r.reasons[0].evidence=[{skuOver:'a',field:'price'}];return r;}});
 assert.equal(result.reasons[0].evidence[0].value,100);
});

test('replacement keeps unlisted parts and quantities, and rejects duplicate categories',async()=>{
 const moreCards=[...cards,{skuOver:'ram',category:'RAM',price:20,specifications:{capacityGB:16}}];
 const c={...catalog,details:({skus})=>({items:moreCards.filter(c=>skus.includes(c.skuOver))}),validate:({parts})=>({ok:true,snapshotId:'s',parts,total:parts.reduce((n,p)=>n+moreCards.find(c=>c.skuOver===p.skuOver).price*p.quantity,0)})};
 const v={...validation,parts:[...validation.parts,{skuOver:'ram',quantity:2}]};
 const result=await explainValidatedBuild({catalog:c,validation:v,inspectedSkus:['b'],provider:async()=>reply()});
 assert.deepEqual(result.alternatives[0].validation.parts,[{skuOver:'b',quantity:2},{skuOver:'ram',quantity:2}]);
 await assert.rejects(explainValidatedBuild({catalog:c,validation:v,inspectedSkus:['b'],provider:async()=>{const r=reply();r.alternatives[0].replacements.push({skuOver:'a',quantity:1});return r;}}),/invalid_alternative/);
});
test('replacement cannot add a category absent from the baseline',async()=>{
 const c={...catalog,details:({skus})=>({items:cards.filter(c=>skus.includes(c.skuOver)).map(c=>c.skuOver==='b'?{...c,category:'RAM'}:c)})};
 await assert.rejects(explainValidatedBuild({catalog:c,validation,inspectedSkus:['b'],provider:async()=>reply()}),/invalid_alternative/);
});
for(const [label,purpose,applications,expected] of [
 ['work','Для работы и творчества',['photoshop','twinmotion'],false],
 ['office','Для офиса',null,false],
 ['games','Для игр',null,true],
 ['mixed','Для работы и творчества',['photoshop','gaming'],true],
])test(`explanation evidence follows authoritative ${label} workload`,async()=>{
 const source=cards.map(c=>({...c,performance:{workload:{status:'not_evaluated'},gaming:{referenceFps:50}}}));
 const original=structuredClone(source);
 const request={purpose,partPreferences:{gamingResolution:'1440p',...(applications?{workloadProfile:{version:1,tasks:applications.map(application=>({application,operation:'interactive',priority:'primary',complexity:'unknown'}))}}:{})}};
 const c={...catalog,customerRequest:()=>request,details:({skus})=>({items:source.filter(c=>skus.includes(c.skuOver))})};
 await explainValidatedBuild({catalog:c,validation,inspectedSkus:['b'],provider:async({input})=>{
  const data=JSON.parse(input[0].content);
  for(const card of data.cards){assert.equal(Object.hasOwn(card.performance,'gaming'),expected);assert.ok(card.performance.workload.tasksByKey);assert.equal(Object.hasOwn(card.performance.workload,'status'),false);assert.equal(card.specifications.memoryGB,source.find(s=>s.skuOver===card.skuOver).specifications.memoryGB);}
  return reply();
 }});
 assert.deepEqual(source,original);
});
test('work explanation cannot cite hidden gaming evidence',async()=>{
 const c={...catalog,customerRequest:()=>({purpose:'Для офиса'}),details:({skus})=>({items:cards.filter(c=>skus.includes(c.skuOver)).map(c=>({...c,performance:{gaming:{referenceFps:50}}}))})};
 await assert.rejects(explainValidatedBuild({catalog:c,validation,provider:async()=>{const r=reply();r.reasons[0].evidence=[{skuOver:'a',field:'performance.gaming.referenceFps'}];return r;}}),/invalid_evidence/);
});

test('mixed-task report keeps measured evidence separate from missing tasks and operations',async()=>{
 const task=(application,operation='interactive')=>({application,operation,priority:'primary',complexity:'unknown'});
 const tasks=[task('photoshop'),task('blender','cpu_render'),task('blender','gpu_render')];
 const source=cards.map(c=>({...c,performance:{workload:{status:'partial',score:90,coverage:{measured:2,total:3},tasks:[
  {...tasks[0],status:'measured',score:90,evidence:{metric:'Photoshop test',value:900}},
  {...tasks[1],status:'measured',score:80,evidence:{metric:'CPU render test',value:800}},
  {...tasks[2],status:'not_evaluated',score:null,evidence:null},
  {...task('twinmotion','gpu_render'),status:'measured',score:999,evidence:{metric:'unrequested'}}
 ]}}}));
 source[1].performance.workload.tasks=source[1].performance.workload.tasks.map(t=>({...t,status:'not_evaluated',score:null,evidence:null}));
 const before=structuredClone(source);
 const c={...catalog,customerRequest:()=>({purpose:'Для работы и творчества',partPreferences:{workloadProfile:{version:1,tasks}}}),details:({skus})=>({items:source.filter(c=>skus.includes(c.skuOver))})};
 const result=await explainValidatedBuild({catalog:c,validation,inspectedSkus:['b'],provider:async({input})=>{
  const supplied=JSON.parse(input[0].content).cards;
  const workload=supplied[0].performance.workload;
  assert.deepEqual(Object.keys(workload),['tasksByKey']);
  assert.equal(workload.tasksByKey.photoshop_interactive.status,'measured');
  assert.equal(supplied[1].performance.workload.tasksByKey.photoshop_interactive.status,'not_evaluated');
  assert.equal(workload.tasksByKey.blender_cpu_render.evidence.value,800);
  assert.equal(workload.tasksByKey.blender_gpu_render.status,'not_evaluated');
  assert.equal(workload.tasksByKey.blender_gpu_render.score,null);
  assert.equal(Object.hasOwn(workload.tasksByKey,'twinmotion_gpu_render'),false);
  const r=reply();r.reasons[0].evidence=[{skuOver:'a',field:'performance.workload.tasksByKey.photoshop_interactive.evidence.value'}];return r;
 }});
 assert.equal(result.reasons[0].evidence[0].value,900);
 assert.deepEqual(source,before);
 for(const field of ['performance.workload.score','performance.workload.status','performance.workload.tasksByKey.twinmotion_gpu_render']){
  await assert.rejects(explainValidatedBuild({catalog:c,validation,inspectedSkus:['b'],provider:async()=>{
   const r=reply();r.reasons[0].evidence=[{skuOver:'a',field}];return r;
  }}),/invalid_evidence_reference/);
 }
});

test('missing gaming evidence has an explicit availability fact while null references remain invalid',async()=>{
 const c={...catalog,customerRequest:()=>({purpose:'Для игр',budget:200}),details:({skus})=>({items:cards.filter(c=>skus.includes(c.skuOver)).map(c=>({...c,performance:{gaming:null}}))})};
 const provider=async({input})=>{const data=JSON.parse(input[0].content);assert.equal(data.cards[0].performance.gaming,null);assert.equal(data.cards[0].performance.gamingEvidenceAvailable,false);const r=reply();r.alternatives=[];r.tradeoffs=[{text:'Игровой тест отсутствует.',evidence:[{skuOver:'a',field:'performance.gamingEvidenceAvailable'}]}];return r;};
 const r=await explainValidatedBuild({catalog:c,validation,provider});assert.equal(r.tradeoffs[0].evidence[0].value,false);
 await assert.rejects(explainValidatedBuild({catalog:c,validation,provider:async args=>{const r=await provider(args);r.tradeoffs[0].evidence[0].field='performance.gaming';return r;}}),/invalid_evidence_reference/);
});
