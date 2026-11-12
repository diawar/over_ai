'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {timings,balanceBonus,memoryProfileSupport}=require('../tools/component-budget.cjs');
const {buildPc}=require('../tools/pc-builder.cjs');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
const run=rows=>buildPc({localData:{getBuildCandidates:()=>structuredClone(rows)},city:'Алматы',purpose:'Для игр',tasks:'CS2',cpu:'AMD',budget:1000000});
test('timings use nanoseconds and reject ambiguous or missing profiles',()=>{
  assert.equal(timings({speedMTs:6000,timings:'30-36-36-76'}).ns[0],10);
  assert.equal(timings({speedMTs:3200,timings:'CL16'}).ns[0],10);
  assert.equal(timings({speedMTs:3200,timings:'16-18-18'}).ns[0],10);
  assert.ok(timings({speedMTs:6000,timings:'CL30'}).utility>timings({speedMTs:6000,timings:'CL40'}).utility);
  for(const t of ['','CL30 / CL40','0-36-36-76','30-36','CL30 XMP'])assert.equal(timings({speedMTs:6000,timings:t}).utility,0);
  assert.equal(timings({timings:'CL30'}).utility,0);
});
test('higher price alone cannot upgrade a case with identical recorded specifications',()=>{
  const rows=createBuildFixture().getBuildCandidates(),original=rows.find(r=>r.category==='Корпуса');
  original.offer.price=5000;
  const higher=structuredClone(original);higher.skuOver=higher.product.skuOver='999';higher.offer.price=15000;rows.unshift(higher);
  const build=run(rows).build;
  assert.equal(build.parts.find(p=>p.category==='Корпуса').skuOver,original.skuOver);
});
test('budget balance can prefer a better equipped case rather than the cheapest one',()=>{
  const rows=createBuildFixture().getBuildCandidates(),original=rows.find(r=>r.category==='Корпуса');
  original.offer.price=5000;original.component.facts.caseSpecifications.value.preinstalledFans='rear';
  original.component.facts.caseSpecifications.value.maxGpuLengthMm=270;
  const better=structuredClone(original);better.skuOver=better.product.skuOver='998';better.offer.price=30000;
  Object.assign(better.component.facts.caseSpecifications.value,{preinstalledFans:'front and rear',maxGpuLengthMm:350});rows.push(better);
  assert.equal(run(rows).build.parts.find(p=>p.category==='Корпуса').skuOver,better.skuOver);
  assert.equal(balanceBonus(30000,1000000,0.03,1),balanceBonus(90000,1000000,0.03,1));
});
test('same-speed lower-timing RAM survives candidate grouping and earns a bounded upgrade',()=>{
  const rows=createBuildFixture().getBuildCandidates(),ram=rows.find(r=>r.category==='Оперативная память');
  Object.assign(ram.component.facts.memorySpecifications.value,{speedMTs:6000,timings:'CL40',profiles:['EXPO']});
  rows.find(r=>r.category==='Материнские платы').component.facts.motherboardSpecifications.value.memoryProfiles=['EXPO'];
  const better=structuredClone(ram);better.skuOver=better.product.skuOver='997';better.offer.price+=1000;
  better.component.facts.memorySpecifications.value.timings='CL30';rows.push(better);
  assert.equal(run(rows).build.parts.find(p=>p.category==='Оперативная память').skuOver,better.skuOver);
});
test('EXPO and XMP need explicit matching motherboard support, not a CPU-brand assumption',()=>{
  assert.equal(memoryProfileSupport({profiles:['EXPO']},{socket:'AM5'}).utility,0);
  assert.equal(memoryProfileSupport({profiles:['XMP 3.0']},{memoryProfiles:['XMP 2.0']}).utility,0);
  assert.equal(memoryProfileSupport({profiles:['XMP 3.0']},{memoryProfiles:['XMP']}).utility,0.5);
  assert.equal(memoryProfileSupport({profiles:['EXPO','XMP 3.0']},{memoryProfiles:['EXPO']}).utility,0.5);
});
test('advantages describe recorded features without inventing Wi-Fi or profile support',()=>{
  const rows=createBuildFixture().getBuildCandidates();
  const basic=run(rows).build.advantages.join(' ');
  assert.match(basic,/SSD 1000/);assert.doesNotMatch(basic,/Встроенный Wi-Fi|поддерживают EXPO/);
  const board=rows.find(r=>r.category==='Материнские платы').component.facts.motherboardSpecifications.value;
  const ram=rows.find(r=>r.category==='Оперативная память').component.facts.memorySpecifications.value;
  board.wifiBuiltIn=true;board.memoryProfiles=['EXPO'];ram.profiles=['EXPO'];
  const updated=run(rows).build;
  assert.match(updated.advantages.join(' '),/Встроенный Wi-Fi/);
  assert.match(updated.advantages.join(' '),/поддерживают EXPO/);
  assert.ok(updated.warnings.some(w=>w.includes('проверки стабильности')));
});
