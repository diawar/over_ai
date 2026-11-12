'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {cpuModel}=require('../tools/model-identity.cjs');
const {gpuAssessment,gpuEvidence,cpuEvidence}=require('../tools/performance-evidence.cjs');
const {buildPc}=require('../tools/pc-builder.cjs');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');

test('exact chip identity ignores packaging but preserves CPU suffix and GPU VRAM',()=>{
  assert.equal(cpuModel('Процессор Intel Core i5-12600KF BOX','Intel'),'Intel Core i5 12600KF');
  assert.equal(cpuModel('AMD Ryzen 5 7600X OEM','Intel'),null);
  assert.equal(cpuModel('AMD Ryzen 5 7600 + AMD Ryzen 7 7700','AMD'),null);
  assert.equal(cpuEvidence({name:'AMD Ryzen 5 7600XYZ',manufacturer:'AMD'},{socket:'AM5',cores:6}),null);
  const known=gpuEvidence({gpu:' NVIDIA GeForce RTX 5070 ',memoryGB:12},'', '1440p');
  assert.ok(known);
  assert.equal(gpuEvidence({gpu:'GeForce RTX 5070',memoryGB:24}),null);
  assert.deepEqual(gpuAssessment({gpu:'AMD Radeon AI PRO R9700',memoryGB:32}),{
    model:'Radeon AI PRO R9700',family:'radeon_ai_pro',memoryGB:32,status:'not_evaluated',label:'Производительность не оценена',score:null});
});

function fixture(){
  const data=createBuildFixture(), rows=data.getBuildCandidates('Алматы');
  const card=structuredClone(rows.find(r=>r.category==='Видеокарты'));
  card.skuOver=card.product.skuOver='9700';card.product.name='Radeon AI PRO R9700';
  card.component.facts.graphicsCardSpecifications.value.gpu='Radeon AI PRO R9700';
  card.component.facts.graphicsCardSpecifications.value.memoryGB=32;card.offer.price=1311304;
  rows.push(card);
  return {...data,getBuildCandidates:()=>structuredClone(rows)};
}
const options={city:'Алматы',cpu:'AMD',purpose:'Для работы и творчества',budget:1250000,
  partPreferences:{skus:{},workloadGpu:{mode:'required',minVramGB:8,technology:null}}};
test('unrated R9700 no longer excludes compatible in-budget RTX cards for creative work',()=>{
  const result=buildPc({...options,localData:fixture()});
  assert.equal(result.ok,true);assert.equal(result.build.overBudget,false);
  assert.notEqual(result.build.parts.find(p=>p.category==='Видеокарты').skuOver,'9700');
  assert.equal(result.build.gpuAssessment.status,'not_evaluated');
  assert.equal(result.build.gpuAssessment.score,null);
  assert.ok(result.build.warnings.some(w=>w.includes('оптимальность')));
});
test('explicit unrated GPU is allowed with warning without inventing test scores',()=>{
  const result=buildPc({...options,localData:fixture(),purpose:'Для игр',budget:2000000,
    partPreferences:{skus:{'Видеокарты':'9700'}}});
  assert.equal(result.ok,true);
  assert.equal(result.build.gpuAssessment.status,'not_evaluated');
  assert.equal(result.build.performanceEvidence,undefined);
});
test('unrated CPU cannot win automatic game selection by core count; explicit choice can be checked',()=>{
  const data=fixture(),rows=data.getBuildCandidates('Алматы');
  const cpu=rows.find(r=>r.category==='Процессоры');
  cpu.product.name=cpu.component.officialModel='AMD Ryzen 9 9999X';cpu.component.facts.processorSpecifications.value.cores=16;
  const localData={...data,getBuildCandidates:()=>structuredClone(rows)};
  // Remove other processors so there is no measured alternative.
  const onlyUnknown={...localData,getBuildCandidates:()=>structuredClone(rows.filter(r=>r.category!=='Процессоры'||r===cpu))};
  const automatic=buildPc({...options,localData:onlyUnknown,purpose:'Для игр'});
  assert.equal(automatic.code,'needs_review');
  const explicit=buildPc({...options,localData:onlyUnknown,purpose:'Для игр',partPreferences:{skus:{'Процессоры':cpu.skuOver}}});
  assert.equal(explicit.ok,true);
  assert.equal(explicit.build.cpuAssessment.score,null);
});
