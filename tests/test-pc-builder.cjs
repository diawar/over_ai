'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createLocalData}=require('../tools/local-data.cjs');
const {buildPc}=require('../tools/pc-builder.cjs');

test('gaming build uses confirmed RTX 50 parts, available stock, compatible dimensions and separate time units',()=>{
  const localData=createLocalData();
  const result=buildPc({localData,city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр',tasks:'CS2'});
  assert.equal(result.ok,true);
  const build=result.build;
  const categories=new Set(build.parts.map(part=>part.category));
  for(const category of ['Процессоры','Материнские платы','Оперативная память','Видеокарты','Твердотельные диски (SSD)','Блоки питания','Корпуса','Кулеры для процессоров']) assert.ok(categories.has(category),category);
  const gpu=build.parts.find(part=>part.category==='Видеокарты');
  assert.match(gpu.name,/RTX 50(60|70|80)/);
  assert.equal(build.total,build.parts.reduce((sum,part)=>sum+part.price,0));
  assert.equal(build.overBudget,build.total>560000);
  assert.equal(build.assemblyCalendarDays,2);
  assert.equal(Number.isInteger(build.maxTransferBusinessDays),true);
  assert.equal(Object.hasOwn(build,'estimatedCalendarDays'),false);
  assert.equal(build.assemblyFree,true);
  assert.equal(build.priceValidDays,1);
  assert.ok(Date.parse(build.expiresAt)>Date.parse(build.createdAt));
  const data=localData.getBuildCandidates('Алматы');
  for(const part of build.parts){
    const candidate=data.find(row=>String(row.skuOver)===String(part.skuOver));
    assert.ok(candidate);
    assert.ok(candidate.offer.quantity>0);
    assert.notEqual(candidate.offer.supplier,'OVER ALB');
    assert.notEqual(candidate.offer.supplier,'VENDER_P_S');
  }
  const enclosure=data.find(row=>String(row.skuOver)===String(build.parts.find(part=>part.category==='Корпуса').skuOver));
  assert.doesNotMatch(enclosure.component.facts.caseSpecifications.value.preinstalledFans,/side/i);
});

test('other city always maps to Almaty for stock and transfer calculation',()=>{
  const result=buildPc({localData:createLocalData(),city:'Другой город',budget:560000,cpu:'AMD',purpose:'Для игр',tasks:'CS2'});
  assert.equal(result.ok,true);
  assert.equal(result.build.city,'Алматы');
  assert.ok(result.build.parts.every(part=>part.transferBusinessDays<=10));
});

test('gaming build fails closed when a case has no confirmed factory-installed fans',()=>{
  const data=createLocalData();
  const localData={...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(row.category!=='Корпуса')return row;
    const facts={...row.component.facts};
    facts.caseSpecifications={...facts.caseSpecifications,value:{...facts.caseSpecifications.value,preinstalledFans:null}};
    return {...row,component:{...row.component,facts}};
  })};
  const result=buildPc({localData,city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр',tasks:'CS2'});
  assert.deepEqual(result,{ok:false,code:'no_verified_build',city:'Алматы'});
});

test('an explicit higher GPU preference is respected even when the total exceeds budget',()=>{
  const result=buildPc({localData:createLocalData(),city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр',tasks:'CS2',graphicsPreference:'RTX 5070'});
  assert.equal(result.ok,true);
  assert.match(result.build.parts.find(part=>part.category==='Видеокарты').name,/RTX 5070|RTX 5080/);
});

// Use a real compatible configuration, then isolate budget decisions from
// changing catalog prices. All alternatives still run through compatibility.
function budgetFixture() {
  const data=createLocalData();
  const seed=buildPc({localData:data,city:'Павлодар',budget:1700000,cpu:'AMD',purpose:'Для игр'}).build;
  const skus=new Set(seed.parts.map(p=>String(p.skuOver)));
  const rows=data.getBuildCandidates('Павлодар').filter(r=>skus.has(r.skuOver));
  for(const row of rows) {row.offer.price=1000;row.offer.quantity=10;row.offer.days=0;}
  const ssd=rows.find(r=>r.category==='Твердотельные диски (SSD)');
  ssd.component.facts.solidStateDriveSpecifications.value.capacityGB=1000;
  const two=structuredClone(ssd);two.skuOver=two.product.skuOver='900000001';two.offer.price=2000;
  two.component.facts.solidStateDriveSpecifications.value.capacityGB=2000;
  const four=structuredClone(ssd);four.skuOver=four.product.skuOver='900000002';four.offer.price=4000;
  four.component.facts.solidStateDriveSpecifications.value.capacityGB=4000;
  rows.push(two,four);
  return {rows,ssd,two,four,base:seed.parts.reduce((n,p)=>n+1000*p.quantity,0),
    run(budget){return buildPc({localData:{getBuildCandidates:()=>structuredClone(rows)},city:'Павлодар',budget,cpu:'AMD',purpose:'Для игр'}).build;}};
}
const fixture=budgetFixture();
const storage=build=>build.parts.find(p=>p.category==='Твердотельные диски (SSD)');

test('spare budget upgrades 1 TB to 2 TB and 4 TB at their exact affordable thresholds',()=>{
  assert.equal(String(storage(fixture.run(fixture.base+999)).skuOver),fixture.ssd.skuOver);
  for(const [extra,row] of [[1000,fixture.two],[3000,fixture.four]]) {
    const build=fixture.run(fixture.base+extra);
    assert.equal(String(storage(build).skuOver),row.skuOver);
    assert.equal(build.overBudget,false);assert.equal(build.remainingBudget,0);
  }
});

test('equivalent capacity prefers lower cost, not a dearer 2048 GB label or case',()=>{
  const f=budgetFixture();
  const expensive=structuredClone(f.two);expensive.skuOver=expensive.product.skuOver='900000003';
  expensive.offer.price=2500;expensive.component.facts.solidStateDriveSpecifications.value.capacityGB=2048;
  const enclosure=structuredClone(f.rows.find(r=>r.category==='Корпуса'));
  enclosure.skuOver=enclosure.product.skuOver='900000004';enclosure.offer.price=2000;
  f.rows.unshift(expensive,enclosure);
  const build=f.run(f.base+2500);
  assert.equal(String(storage(build).skuOver),f.two.skuOver);
  assert.equal(build.total,f.base+1000);
});

test('a cheaper weaker processor does not win merely to spend more on storage; incompatible SSDs stay excluded',()=>{
  const f=budgetFixture();
  const cpu=f.rows.find(r=>r.category==='Процессоры');
  const cheapCpu=structuredClone(cpu);cheapCpu.skuOver=cheapCpu.product.skuOver='900000005';cheapCpu.offer.price=1;
  cheapCpu.component.officialModel='AMD Ryzen 5 8400F';
  f.rows.push(cheapCpu);
  const original=f.run(f.base+1000);
  assert.equal(String(original.parts.find(p=>p.category==='Процессоры').skuOver),cpu.skuOver);
  f.two.component.facts.solidStateDriveSpecifications.value.interface='unsupported';
  assert.equal(String(storage(f.run(f.base+1000)).skuOver),f.ssd.skuOver);
});

test('insufficient budget retains the cheapest valid over-budget proposal',()=>{
  const build=fixture.run(fixture.base-1);
  assert.equal(build.overBudget,true);assert.equal(build.total,fixture.base);
  assert.equal(String(storage(build).skuOver),fixture.ssd.skuOver);
});

test('after capacity, spare budget can buy a faster confirmed SSD of the same class',()=>{
  const f=budgetFixture();
  f.two.component.facts.solidStateDriveSpecifications.value.sequentialReadMBs=6000;
  f.two.component.facts.solidStateDriveSpecifications.value.sequentialWriteMBs=5000;
  const faster=structuredClone(f.two);faster.skuOver=faster.product.skuOver='900000006';faster.offer.price=2500;
  faster.component.facts.solidStateDriveSpecifications.value.sequentialReadMBs=7000;
  faster.component.facts.solidStateDriveSpecifications.value.sequentialWriteMBs=7000;
  f.rows.push(faster);
  assert.equal(String(storage(f.run(f.base+1499)).skuOver),f.two.skuOver);
  assert.equal(String(storage(f.run(f.base+1500)).skuOver),faster.skuOver);
});

test('office and creative budgets use purpose-specific RAM and SSD targets',()=>{
  const f=budgetFixture();
  const ram=f.rows.find(r=>r.category==='Оперативная память');
  ram.component.facts.memorySpecifications.value.capacityGB=16;
  ram.component.facts.memorySpecifications.value.moduleCount=1;
  const larger=structuredClone(ram);larger.skuOver=larger.product.skuOver='900000007';larger.offer.price=3000;
  larger.component.facts.memorySpecifications.value.capacityGB=64;
  larger.component.facts.memorySpecifications.value.moduleCount=2;
  f.rows.push(larger);
  for(const [purpose,expectedRam,expectedSSD] of [['Для офиса',ram,f.ssd],['Для работы и творчества',larger,f.four]]) {
    const {build}=buildPc({localData:{getBuildCandidates:()=>structuredClone(f.rows)},city:'Павлодар',budget:100000,cpu:'AMD',purpose});
    assert.equal(String(build.parts.find(p=>p.category==='Оперативная память').skuOver),expectedRam.skuOver);
    assert.equal(String(storage(build).skuOver),expectedSSD.skuOver);
    assert.equal(build.overBudget,false);
  }
});

test('first proposal upgrades CPU and required board together, independent of inventory order',()=>{
  const f=budgetFixture();
  const cpu=f.rows.find(r=>r.category==='Процессоры');
  cpu.component.officialModel='AMD Ryzen 5 7600';
  delete cpu.component.facts.processorSpecifications.value.series;
  const board=f.rows.find(r=>r.category==='Материнские платы');
  const spec=board.component.facts.motherboardSpecifications.value;
  Object.assign(spec,{memorySlots:2,m2Slots:2,lan:'Gigabit Ethernet',wifiBuiltIn:false,supportedCpuSeries:[]});
  delete spec.wifi;
  f.rows.find(r=>r.category==='Кулеры для процессоров').component.officialModel='DeepCool AK620 G2';
  const stronger=structuredClone(cpu);stronger.skuOver=stronger.product.skuOver='900000008';
  stronger.component.officialModel='AMD Ryzen 7 9700X';stronger.offer.price=3000;
  stronger.component.facts.processorSpecifications.value.series='Ryzen 9000';
  const betterBoard=structuredClone(board);betterBoard.skuOver=betterBoard.product.skuOver='900000009';betterBoard.offer.price=2000;
  Object.assign(betterBoard.component.facts.motherboardSpecifications.value,{memorySlots:4,lan:'2.5 Gigabit Ethernet',wifiBuiltIn:true,supportedCpuSeries:['Ryzen 9000']});
  f.rows.push(stronger,betterBoard);
  assert.equal(String(f.run(f.base).parts.find(p=>p.category==='Процессоры').skuOver),cpu.skuOver);
  const result=f.run(f.base+3000);
  assert.equal(String(result.parts.find(p=>p.category==='Процессоры').skuOver),stronger.skuOver);
  assert.equal(String(result.parts.find(p=>p.category==='Материнские платы').skuOver),betterBoard.skuOver);
  assert.equal(result.overBudget,false);
  f.rows.reverse();
  assert.deepEqual(f.run(f.base+3000).parts,result.parts);
  betterBoard.component.facts.motherboardSpecifications.value.supportedCpuSeries=[];
  assert.equal(String(f.run(f.base+3000).parts.find(p=>p.category==='Процессоры').skuOver),cpu.skuOver);
});

test('costlier identical CPUs are not upgrades and the requested brand stays mandatory',()=>{
  const f=budgetFixture();const cpu=f.rows.find(r=>r.category==='Процессоры');
  const duplicate=structuredClone(cpu);duplicate.skuOver=duplicate.product.skuOver='900000010';duplicate.offer.price=10000;
  f.rows.unshift(duplicate);
  assert.equal(String(f.run(100000).parts.find(p=>p.category==='Процессоры').skuOver),cpu.skuOver);
  const response=buildPc({localData:{getBuildCandidates:()=>f.rows},city:'Павлодар',budget:100000,cpu:'Intel',purpose:'Для игр'});
  assert.equal(response.ok,false);
});
