'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {cpuCoolingPower}=require('../tools/cpu-cooling-power.cjs');
const {buildPc}=require('../tools/pc-builder.cjs');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
test('recorded power wins; fallback follows the approved processor families',()=>{
  assert.equal(cpuCoolingPower({socket:'AM5',tdpW:170},'AMD Ryzen 9 9950X'),255);
  assert.equal(cpuCoolingPower({socket:'AM5',tdpW:170,pptW:230},'AMD Ryzen 9 9950X'),230);
  assert.equal(cpuCoolingPower({socket:'AM4',tdpW:65},'Ryzen 7 5700G'),98);
  assert.equal(cpuCoolingPower({socket:'AM4',tdpW:65},'Ryzen 5 5600G'),88);
  assert.equal(cpuCoolingPower({socket:'LGA1700',tdpW:65,maxTurboPowerW:154}),154);
  assert.equal(cpuCoolingPower({socket:'LGA1700',tdpW:65}),null);
  for (const name of ['Intel Celeron G5905','Intel Pentium Gold G6400','Intel Pent G4400','Intel Core i3-10100'])
    assert.equal(cpuCoolingPower({tdpW:65},name),65);
  for (const name of ['Intel Core i5-10400','Intel Core i7-10700KF']) {
    assert.equal(cpuCoolingPower({tdpW:65},name),88);
    assert.equal(cpuCoolingPower({tdpW:65,maxTurboPowerW:154},name),154);
  }
  assert.equal(cpuCoolingPower({tdpW:125,series:'Intel Core i7'},''),169);
  assert.equal(cpuCoolingPower({tdpW:125},'Intel Core i9-10900'),null);
});
test('9950X cannot use a 200 W cooler; both air and liquid must meet power limit',()=>{
  for(const liquid of [false,true]){
    const localData=createBuildFixture();
    const rows=localData.getBuildCandidates('Алматы');
    const cpu=rows.find(r=>r.category==='Процессоры');
    cpu.component.officialModel='AMD Ryzen 9 9950X';
    cpu.component.facts.processorSpecifications.value.tdpW=170;
    const cooler=rows.find(r=>r.category==='Кулеры для процессоров');
    cooler.component.facts.cpuCoolerSpecifications.value.tdpW=200;
    if(liquid){cooler.category='Системы водяного / жидкостного охлаждения (СЖО)';
      Object.assign(cooler.component.facts.cpuCoolerSpecifications.value,{type:'aio',radiatorSizeMm:240});}
    const result=buildPc({localData:{...localData,getBuildCandidates:()=>rows},city:'Алматы',purpose:'Для офиса',budget:1000000,cpu:'AMD'});
    assert.equal(result.ok,false);
  }
});
