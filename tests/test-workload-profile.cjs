'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateWorkload,assessWorkload,workloadGaps}=require('../tools/workload-profile.cjs');
const {validatePartPreferences}=require('../tools/part-preferences.cjs');
const {buildPc}=require('../tools/pc-builder.cjs');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
const profile=(application='blender',operation='gpu_render')=>({version:1,tasks:[{application,operation,priority:'primary',complexity:'unknown'}]});
// Synthetic measurements test isolation and arithmetic, never shipped as evidence.
const cohort={id:'fixture',version:'4.0',application:'blender',operation:'gpu_render',component:'gpu',
  url:'https://example.com/test',date:'2024-01-01',metric:'samples/min',baseValue:100,direction:'higher',
  observations:[{model:'RTX 5060',memoryGB:8,value:120}]};
test('workload observations cannot leak between applications, operations or GPU variants',()=>{
  assert.equal(assessWorkload(profile(),'gpu','RTX 5060',8,[cohort]).score,120);
  for(const p of [profile('twinmotion'),profile('photoshop','interactive'),profile('blender','cpu_render')])
    assert.equal(assessWorkload(p,'gpu','RTX 5060',8,[cohort]).score,null);
  assert.equal(assessWorkload(profile(),'gpu','RTX 5060',16,[cohort]).score,null);
  assert.equal(assessWorkload(profile(),'gpu','RTX 5060 Ti',8,[cohort]).score,null);
});
test('unmeasured primary tasks are not silently dropped from a mixed assessment',()=>{
  const mixed={version:1,tasks:[...profile().tasks,...profile('twinmotion').tasks]};
  const assessment=assessWorkload(mixed,'gpu','RTX 5060',8,[cohort]);
  assert.equal(assessment.score,120);assert.equal(assessment.status,'partial');
  assert.deepEqual(assessment.coverage,{measured:1,total:2});
  assert.equal(assessment.tasks[1].score,null);
  assert.deepEqual(validatePartPreferences({skus:{},workloadProfile:mixed}).workloadProfile,mixed);
  assert.deepEqual(validateWorkload({...mixed,tasks:[...mixed.tasks,...profile().tasks]}),mixed);
});

test('gap notices mention only applications in the client workload',()=>{
  const data=require('../tools/performance-models.json').workloadObservations;
  const ps=assessWorkload(profile('photoshop','interactive'),'gpu','GeForce RTX 5070',12,data);
  const warnings=workloadGaps(null,ps).join(' ');
  assert.match(warnings,/Photoshop/);
  assert.doesNotMatch(warnings,/Twinmotion|Blender|Premiere/);
  assert.deepEqual(workloadGaps(null,null),[]);
});

test('mixed workloads preserve measured CPU preference and expose missing task tests',()=>{
  const base=createBuildFixture(),rows=base.getBuildCandidates();
  const original=rows.find(r=>r.category==='Процессоры');
  Object.assign(original.product,{name:'AMD Ryzen 5 7600X',skuOver:original.skuOver});
  original.component.officialModel='AMD Ryzen 5 7600X';
  const faster=structuredClone(original);
  faster.skuOver='9700';faster.product.skuOver='9700';faster.product.name='AMD Ryzen 7 9700X';
  faster.component.officialModel='AMD Ryzen 7 9700X';faster.offer.price+=10000;
  rows.push(faster);
  const result=buildPc({localData:{...base,getBuildCandidates:()=>structuredClone(rows)},city:'Алматы',
    purpose:'Для работы и творчества',cpu:'AMD',budget:1000000,partPreferences:{skus:{},
      workloadProfile:{version:1,tasks:[...profile('photoshop','interactive').tasks,...profile('twinmotion').tasks]}}});
  assert.equal(result.ok,true);
  assert.match(result.build.parts.find(p=>p.category==='Процессоры').name,/9700X/);
  assert.equal(result.build.workloadAssessment.cpu.status,'partial');
  assert.equal(result.build.workloadAssessment.cpu.tasks[1].score,null);
  assert.match(result.build.warnings.join(' '),/Не оценено по тестам.*Twinmotion/);
});
test('GPU rendering requires a discrete GPU without relying on a second AI flag',()=>{
  const result=buildPc({localData:createBuildFixture(),city:'Алматы',purpose:'Для работы и творчества',
    cpu:'AMD',budget:1000000,partPreferences:{skus:{},workloadProfile:profile('twinmotion')}});
  assert.equal(result.ok,true);
  assert.ok(result.build.parts.some(p=>p.category==='Видеокарты'));
  assert.equal(result.build.workloadAssessment.gpu.score,null);
  assert.ok(result.build.warnings.some(w=>w.includes('оптимальность')));
});
test('Blender selection uses its measured cohort instead of the cheapest unassessed GPU',()=>{
  const result=buildPc({localData:createBuildFixture(),city:'Алматы',purpose:'Для работы и творчества',
    cpu:'AMD',budget:1000000,partPreferences:{skus:{},workloadProfile:profile()}});
  assert.equal(result.ok,true);
  assert.match(result.build.parts.find(p=>p.category==='Видеокарты').name,/5070/);
  assert.equal(result.build.workloadAssessment.gpu.status,'measured');
  assert.equal(result.build.workloadAssessment.gpu.score,100);
});

test('published CPU cohorts distinguish workloads, suffixes and time direction',()=>{
  const data=require('../tools/performance-models.json').workloadObservations;
  const ps=profile('photoshop','interactive'),render=profile('blender','cpu_render');
  const assess=(p,model)=>assessWorkload(p,'cpu',model,null,data);
  assert.equal(assess(ps,'AMD Ryzen 7 9700X').tasks[0].evidence.value,11950);
  assert.ok(assess(ps,'AMD Ryzen 7 9700X').score>assess(ps,'AMD Ryzen 9 9950X').score);
  assert.ok(assess(render,'AMD Ryzen 9 9950X').score>assess(render,'AMD Ryzen 7 9700X').score);
  assert.equal(assess(ps,'Intel Core i5 14600KF').score,null);
  assert.equal(assess(ps,'AMD Ryzen 5 7600').score,null);
  assert.equal(assess(ps,'AMD Ryzen 5 7600X').score,100);
  for(const c of data){
    assert.ok(c.observations.every(r=>r.value>0));
    assert.equal(new Set(c.observations.map(r=>`${r.model}:${r.memoryGB}`)).size,c.observations.length);
    assert.ok(c.observations.some(r=>r.value===c.baseValue));
  }
});
test('Twinmotion reference scene cannot silently rank a generic client workload',()=>{
  const data=require('../tools/performance-models.json').workloadObservations;
  const assessment=assessWorkload(profile('twinmotion'),'gpu','NVIDIA RTX 4000 Ada Generation',20,data);
  assert.equal(assessment.score,null);
  assert.equal(assessment.tasks[0].evidence,null);
});

test('Premiere cohort ranks exact VRAM variants and cannot stand in for other tasks',()=>{
  const cohorts=require('../tools/performance-models.json').workloadObservations;
  const p=profile('premiere','interactive');
  assert.equal(assessWorkload(p,'gpu','GeForce RTX 5070',12,cohorts).score,100);
  assert.equal(assessWorkload(p,'gpu','GeForce RTX 5060 Ti',16,cohorts).tasks[0].evidence.value,8784);
  assert.equal(assessWorkload(p,'gpu','GeForce RTX 5060 Ti',8,cohorts).score,null);
  assert.equal(assessWorkload(profile('photoshop','interactive'),'gpu','GeForce RTX 5070',12,cohorts).score,null);
  assert.equal(assessWorkload(profile('premiere','gpu_render'),'gpu','GeForce RTX 5070',12,cohorts).score,null);
  const result=buildPc({localData:createBuildFixture(),city:'Алматы',purpose:'Для работы и творчества',
    cpu:'AMD',budget:1000000,partPreferences:{skus:{},workloadProfile:p,workloadGpu:{mode:'required',minVramGB:0,technology:null}}});
  assert.equal(result.ok,true);
  assert.match(result.build.parts.find(p=>p.category==='Видеокарты').name,/5070/);
  assert.equal(result.build.workloadAssessment.gpu.status,'measured');
});

test('Twinmotion memory floors survive omitted or contradictory AI GPU requirements',()=>{
  const localData=createBuildFixture();
  const rows=localData.getBuildCandidates();
  rows.find(r=>r.category==='Видеокарты').component.facts.graphicsCardSpecifications.value.memoryGB=4;
  const run=(complexity,minVramGB=0)=>buildPc({localData:{...localData,getBuildCandidates:()=>structuredClone(rows)},
    city:'Алматы',purpose:'Для работы и творчества',cpu:'AMD',budget:1000000,
    partPreferences:{skus:{},workloadGpu:{mode:'not_required',minVramGB,technology:null},
      workloadProfile:{version:1,tasks:[{application:'twinmotion',operation:'interactive',priority:'primary',complexity}]}}});
  const ordinary=run('unknown');
  assert.equal(ordinary.ok,true);
  assert.match(ordinary.build.parts.find(p=>p.category==='Видеокарты').name,/5070/);
  assert.equal(ordinary.build.workloadAssessment.gpu.score,null);
  const heavy=run('heavy');
  assert.equal(heavy.ok,true);
  assert.equal(heavy.build.parts.find(p=>p.category==='Оперативная память').quantity,4);
  assert.equal(run('unknown',24).ok,false);
  for(const row of rows.filter(r=>r.category==='Видеокарты'))
    row.component.facts.graphicsCardSpecifications.value.memoryGB=undefined;
  assert.equal(run('unknown').ok,false);
});
