'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createBuildFixture:createLocalData}=require('./fixtures/pc-build-fixture.cjs');
const {buildPc,driveBayFit,cpuPowerConnectorFit}=require('../tools/pc-builder.cjs');
const {calculateBuildResponse}=require('../tools/preview-app.cjs');
const {cpuEvidence,gpuEvidence}=require('../tools/performance-evidence.cjs');

test('calculated parts retain exact catalog website links',()=>{
  const data=createLocalData();
  const rows=data.getBuildCandidates('Алматы');
  for(const row of rows)row.product.productUrl=`https://shop.example/products/${row.product.skuOver}`;
  const result=buildPc({localData:{...data,getBuildCandidates:()=>rows},city:'Алматы',purpose:'Для офиса',budget:1000000,cpu:'AMD'});
  assert.equal(result.ok,true);
  for(const part of result.build.parts)assert.equal(part.productUrl,`https://shop.example/products/${part.skuOver}`);
});

function officeStorageFixture() {
  const rows=createLocalData().getBuildCandidates('Алматы');
  rows.forEach(row=>{row.offer.price=1000;});
  const ssd=rows.find(row=>row.category==='Твердотельные диски (SSD)');
  rows.splice(rows.indexOf(ssd),1);
  for(const [capacity,price] of [[120,500],[240,1000],[480,2000],[512,2500],[1000,4000]]){
    const row=structuredClone(ssd);
    row.skuOver=row.product.skuOver=String(90000+capacity);
    row.offer.price=price;
    row.component.facts.solidStateDriveSpecifications.value.capacityGB=capacity;
    rows.push(row);
  }
  return rows;
}

test('office SSD accepts 480 GB and falls back to smaller drives only when budget requires it',()=>{
  const rows=officeStorageFixture();
  for(const [budget,capacity,total] of [[8000,480,8000],[7000,240,7000],[6500,120,6500],[6000,120,6500]]){
    const result=buildPc({localData:{getBuildCandidates:()=>structuredClone(rows)},city:'Алматы',
      budget,cpu:'AMD',purpose:'Для офиса'});
    assert.equal(result.ok,true);
    assert.equal(result.build.parts.find(p=>p.category==='Твердотельные диски (SSD)').skuOver,String(90000+capacity));
    assert.equal(result.build.total,total);
    assert.equal(result.build.overBudget,total>budget);
  }
});

test('office prioritizes recommended SSD over an unnecessary CPU upgrade and does not pay for 1 TB',()=>{
  const rows=officeStorageFixture();
  const cpu=structuredClone(rows.find(row=>row.category==='Процессоры'));
  cpu.skuOver=cpu.product.skuOver='99001';cpu.offer.price=2500;
  cpu.component.facts.processorSpecifications.value.cores=8;
  rows.push(cpu);
  const run=budget=>buildPc({localData:{getBuildCandidates:()=>structuredClone(rows)},city:'Алматы',budget,cpu:'AMD',purpose:'Для офиса'});
  assert.equal(run(8500).build.parts.find(p=>p.category==='Твердотельные диски (SSD)').skuOver,'90480');
  assert.equal(run(15000).build.parts.find(p=>p.category==='Твердотельные диски (SSD)').skuOver,'90480');
});

test('gaming SSD minimum stays at 1 TB',()=>{
  const rows=officeStorageFixture();
  const result=buildPc({localData:{getBuildCandidates:()=>structuredClone(rows)},city:'Алматы',budget:50000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(result.ok,true);
  assert.equal(result.build.parts.find(p=>p.category==='Твердотельные диски (SSD)').skuOver,'91000');
});

test('multiple branches in a configured city use direct routes and list exact-build pickup options',()=>{
  const rows=createLocalData().getBuildCandidates('Алматы');
  const operations={version:3,assembly_workdays:2,branches:[
    {code:'S',kind:'warehouse',city:'Караганда',active:true},
    {code:'A',name:'Центр',address:'Адрес A',kind:'branch',city:'Караганда',active:true},
    {code:'B',name:'Юг',address:'Адрес B',kind:'branch',city:'Караганда',active:true},
    {code:'C',name:'Без маршрута',kind:'branch',city:'Караганда',active:true},
    {code:'OFF',kind:'branch',city:'Караганда',active:false},
  ],routes:[{from_branch:'S',to_branch:'A',workdays:1},{from_branch:'S',to_branch:'B',workdays:3},
    {from_branch:'A',to_branch:'C',workdays:1}]};
  const localData={getOperations:()=>operations,
    getBranches:city=>operations.branches.filter(b=>b.active&&b.kind==='branch'&&(!city||b.city===city)),
    getBuildCandidates:(city,code)=>{
      const route=operations.routes.find(r=>r.from_branch==='S'&&r.to_branch===code);
      return route&&city==='Караганда'?rows.map(row=>({...row,offer:{...row.offer,supplier:'S',days:route.workdays}})):[];
    }};
  const request={localData,city:'Караганда',budget:700000,cpu:'AMD',purpose:'Для игр'};
  const result=buildPc(request);
  assert.equal(result.ok,true);
  assert.equal(result.build.pickupBranch,null);
  assert.deepEqual(result.build.pickupOptions.map(b=>[b.code,b.maxTransferBusinessDays]),[['A',1],['B',3]]);
  assert.equal(result.build.pickupOptions[1].address,'Адрес B');
  const selected=buildPc({...request,pickupBranch:'B'});
  assert.equal(selected.ok,true);
  assert.equal(selected.build.pickupBranch.code,'B');
  assert.equal(selected.build.maxTransferBusinessDays,3);
  assert.equal(buildPc({...request,pickupBranch:'OFF'}).ok,false);
  assert.equal(buildPc({...request,city:'Не настроен'}).ok,false);
});

test('city selection cannot combine parts available only at mutually unreachable branches',()=>{
  const rows=createLocalData().getBuildCandidates('Алматы');
  const operations={branches:['A','B'].map(code=>({code,city:'Алматы',kind:'branch',active:true})),routes:[]};
  const localData={getOperations:()=>operations,getBranches:()=>operations.branches,
    getBuildCandidates:(_city,code)=>rows.filter(row=>(row.category==='Процессоры')===(code==='A'))
      .map(row=>({...row,offer:{...row.offer,supplier:code,days:0}}))};
  assert.equal(buildPc({localData,city:'Алматы',budget:700000,cpu:'AMD',purpose:'Для игр'}).ok,false);
});

test('builder uses source and assembly calendars from organization settings',()=>{
  const rows=createLocalData().getBuildCandidates('Алматы');
  rows.forEach(row=>{row.offer.supplier='A';row.offer.days=1;});
  const operations={version:12,assembly_workdays:2,branches:[
    {code:'A',kind:'warehouse',active:true,weekly_days_off:[6]},
    {code:'B',kind:'branch',city:'Алматы',active:true,weekly_days_off:[0,5,6]},
  ],routes:[{from_branch:'A',to_branch:'B',workdays:1}]};
  const localData={getBuildCandidates:()=>rows,getOperations:()=>operations};
  const result=buildPc({localData,city:'Алматы',budget:700000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(result.ok,true);
  const expected=require('../tools/branch-calendar.cjs').routeSchedule(result.build.createdAt,1,2,...operations.branches);
  assert.equal(result.build.readyDate,expected.readyDate);
  assert.equal(result.build.calendarVersion,12);
  operations.branches[0].active=false;
  assert.equal(buildPc({localData,city:'Алматы',budget:700000,cpu:'AMD',purpose:'Для игр'}).code,'needs_review');
});

test('large budget favors a matched memory kit and verified cooling capacity',()=>{
  const rows=createLocalData().getBuildCandidates('Алматы');
  const ram=rows.find(row=>row.category==='Оперативная память');
  const kit=structuredClone(ram);
  kit.skuOver=kit.product.skuOver='9101';
  kit.product.name='DDR5 matched 2 x 16 GB kit';
  kit.component.facts.memorySpecifications.value.capacityGB=32;
  kit.component.facts.memorySpecifications.value.moduleCount=2;
  kit.offer.price=95000;
  rows.push(kit);
  const standard=rows.find(row=>row.category==='Кулеры для процессоров');
  const upgraded=structuredClone(standard);
  upgraded.skuOver=upgraded.product.skuOver='9102';
  upgraded.product.name='High-capacity compatible tower';
  upgraded.component.facts.cpuCoolerSpecifications.value.tdpW=280;
  upgraded.offer.price=30000;
  rows.push(upgraded);
  const localData={getBuildCandidates:()=>structuredClone(rows)};
  const run=budget=>buildPc({localData,city:'Алматы',budget,cpu:'AMD',purpose:'Для игр'});
  const lower=run(535000);
  const higher=run(700000);
  assert.equal(lower.ok,true);
  assert.equal(higher.ok,true);
  assert.notEqual(lower.build.parts.find(part=>part.category==='Оперативная память').skuOver,'9101');
  assert.equal(higher.build.parts.find(part=>part.category==='Оперативная память').skuOver,'9101');
  assert.equal(higher.build.parts.find(part=>part.category==='Кулеры для процессоров').skuOver,'9102');
  assert.ok(higher.build.total<=700000);
});

test('gaming builder considers a compatible 64 GB matched kit when budget allows',()=>{
  const rows=createLocalData().getBuildCandidates('Алматы');
  const ram=rows.find(row=>row.category==='Оперативная память');
  const kit=structuredClone(ram);
  kit.skuOver=kit.product.skuOver='9164';
  kit.product.name='DDR5 64 GB (2 x 32 GB) matched kit';
  kit.component.facts.memorySpecifications.value.capacityGB=64;
  kit.component.facts.memorySpecifications.value.moduleCount=2;
  kit.offer.price=210000;
  rows.push(kit);
  const result=buildPc({localData:{getBuildCandidates:()=>structuredClone(rows)},
    city:'Алматы',budget:1500000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(result.ok,true);
  assert.equal(result.build.parts.find(part=>part.category==='Оперативная память').skuOver,'9164');
});

test('spare budget does not reward dearer copies of the same case and cooler',()=>{
  const rows=createLocalData().getBuildCandidates('Алматы');
  for(const [category,sku] of [['Корпуса','9165'],['Кулеры для процессоров','9166']]){
    const basic=rows.find(row=>row.category===category);
    basic.offer.price=5000;
    const premium=structuredClone(basic);
    premium.skuOver=premium.product.skuOver=sku;
    premium.offer.price=30000;
    rows.push(premium);
  }
  const result=buildPc({localData:{getBuildCandidates:()=>structuredClone(rows)},
    city:'Алматы',budget:1500000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(result.ok,true);
  assert.notEqual(result.build.parts.find(part=>part.category==='Корпуса').skuOver,'9165');
  assert.notEqual(result.build.parts.find(part=>part.category==='Кулеры для процессоров').skuOver,'9166');
});

test('ComputerBase measurements admit capable GPUs without a model allowlist',()=>{
  const preferred=gpuEvidence({gpu:'Radeon RX 7900 XTX',memoryGB:24},'Cyberpunk 2077','4K');
  const backup=gpuEvidence({gpu:'GeForce RTX 5080',memoryGB:16},'Cyberpunk 2077','4K');
  assert.equal(preferred.source,'ComputerBase');
  assert.equal(backup.source,'ComputerBase');
  const rows=createLocalData().getBuildCandidates('Алматы');
  const gpu=rows.find(row=>row.category==='Видеокарты');
  for(const row of rows.filter(row=>row.category==='Видеокарты')){
    row.component.facts.graphicsCardSpecifications.value.gpu='Unsupported GPU';
  }
  gpu.component.facts.graphicsCardSpecifications.value.gpu='Radeon RX 7900 XTX';
  gpu.component.facts.graphicsCardSpecifications.value.memoryGB=24;
  const result=buildPc({localData:{getBuildCandidates:()=>rows},city:'Алматы',budget:700000,
    cpu:'AMD',purpose:'Для игр',tasks:'Cyberpunk 2077',
    partPreferences:{coolerType:null,skus:{},gamingResolution:'4K'}});
  assert.equal(result.ok,true);
  assert.equal(result.build.performanceEvidence.source,'ComputerBase');
});

test('structured GPU power inventory passes the initial gaming candidate filter',()=>{
  const fixture=createLocalData();
  const result=buildPc({localData:{...fixture,getBuildCandidates:city=>fixture.getBuildCandidates(city).map(row=>{
    if(row.category==='Видеокарты')row.component.facts.graphicsCardSpecifications.value.powerConnectors=[
      {kind:'pcie_8',count:1,raw:'1 x 8-pin'}];
    return row;
  })},city:'Алматы',budget:700000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(result.ok,true);
});
test('a requested AM5 platform cannot select an older socket',()=>{
  const fixture=createLocalData();
  const request=platformPreference=>buildPc({localData:fixture,city:'Алматы',budget:700000,
    cpu:'AMD',purpose:'Для игр',partPreferences:{coolerType:null,skus:{},platformPreference}});
  assert.equal(request('AM5').ok,true);
  const oldSocket=request('AM4');
  assert.equal(oldSocket.ok,false);
  assert.equal(oldSocket.code,'requested_part_no_build');
});
test('explicit gaming resolution rejects weak GPUs and reports unaffordable 4K',()=>{
  const fixture=createLocalData();
  const rows=fixture.getBuildCandidates('Алматы');
  const ti=structuredClone(rows.find(row=>row.category==='Видеокарты'&&
    row.component.facts.graphicsCardSpecifications.value.gpu==='GeForce RTX 5070'));
  ti.skuOver=ti.product.skuOver='9001';
  ti.product.name='GeForce RTX 5070 Ti 16 GB';
  ti.component.facts.graphicsCardSpecifications.value.gpu='GeForce RTX 5070 Ti';
  ti.component.facts.graphicsCardSpecifications.value.memoryGB=16;
  ti.offer.price=340000;
  rows.push(ti);
  const localData={getBuildCandidates:()=>structuredClone(rows)};
  const request=(budget,partPreferences)=>buildPc({localData,city:'Алматы',budget,cpu:'AMD',
    purpose:'Для игр',tasks:'Cyberpunk 2077',partPreferences:{coolerType:null,skus:{},...partPreferences}});
  const qhd=request(700000,{gamingResolution:'1440p'});
  assert.equal(qhd.ok,true);
  assert.notEqual(qhd.build.parts.find(part=>part.category==='Видеокарты').name,'GeForce RTX 5060');
  const fourK=request(700000,{gamingResolution:'4K'});
  assert.equal(fourK.ok,true);
  assert.equal(fourK.build.parts.find(part=>part.category==='Видеокарты').name,'GeForce RTX 5070 Ti 16 GB');
  const budget=request(560000,{gamingResolution:'4K'});
  assert.equal(budget.ok,false);
  assert.equal(budget.code,'resolution_budget_unmet');
  assert.ok(budget.minimumTotal>budget.budgetLimit);
  const response=calculateBuildResponse({city:'Алматы',budget:560000,cpu:'AMD',
    purpose:'Для игр',tasks:'Cyberpunk 2077',
    partPreferences:{coolerType:null,skus:{},gamingResolution:'4K'}},localData);
  assert.equal(response.status,422);
  assert.equal(response.payload.error,'resolution_budget_unmet');
  assert.equal(response.payload.minimumTotal,budget.minimumTotal);
  const exact=request(700000,{gamingResolution:'4K',skus:{'Видеокарты':'4'}});
  assert.equal(exact.ok,false);
  assert.equal(exact.code,'resolution_requirement_unmet');
});
test('build progress counts completed CPU candidates',()=>{
  const progress=[];
  const result=calculateBuildResponse({city:'Алматы',purpose:'Для игр',budget:700000,cpu:'AMD'},
    createLocalData(),event=>progress.push(event));
  assert.equal(result.status,200);
  assert.equal(progress[0].phase,'compare');
  assert.equal(progress[0].completed,0);
  assert.equal(progress.at(-1).completed,progress.at(-1).total);
});

test('white build selects only verified white parts and fails closed when a required color is unknown',()=>{
  const fixture=createLocalData();
  const withColors=city=>fixture.getBuildCandidates(city).map(row=>{
    const key={
      'Материнские платы':'motherboardSpecifications','Оперативная память':'memorySpecifications',
      'Блоки питания':'powerSupplySpecifications',
      'Корпуса':'caseSpecifications','Кулеры для процессоров':'cpuCoolerSpecifications',
      'Системы водяного / жидкостного охлаждения (СЖО)':'cpuCoolerSpecifications',
      'Видеокарты':'graphicsCardSpecifications','Охлаждение для корпусов ПК':'caseFanSpecifications'
    }[row.category];
    if(key)row.component.facts[key].value.color='Белый';
    return row;
  });
  const result=buildPc({localData:{...fixture,getBuildCandidates:withColors},city:'Алматы',budget:700000,
    cpu:'AMD',purpose:'Для игр',tasks:'Белый ПК'});
  assert.equal(result.ok,true);
  assert.ok(result.build.parts.filter(row=>[
    'Материнские платы','Оперативная память','Блоки питания','Корпуса','Кулеры для процессоров',
    'Системы водяного / жидкостного охлаждения (СЖО)','Видеокарты','Охлаждение для корпусов ПК'
  ].includes(row.category)).length>=5);
  const missing=buildPc({localData:{...fixture,getBuildCandidates:city=>withColors(city).map(row=>{
    if(row.category==='Оперативная память')row.component.facts.memorySpecifications.value.color='Чёрный';
    return row;
  })},city:'Алматы',budget:700000,cpu:'AMD',purpose:'Для игр',tasks:'Белый ПК'});
  assert.equal(missing.ok,false);
  assert.equal(missing.code,'requested_part_no_build');
  const nonWhitePsu=buildPc({localData:{...fixture,getBuildCandidates:city=>withColors(city).map(row=>{
    if(row.category==='Блоки питания')row.component.facts.powerSupplySpecifications.value.color='Чёрный';
    return row;
  })},city:'Алматы',budget:700000,cpu:'AMD',purpose:'Для игр',tasks:'Белый ПК'});
  assert.equal(nonWhitePsu.ok,false);
  assert.equal(nonWhitePsu.code,'requested_part_no_build');
});

test('missing front USB header warns the customer without excluding the build',()=>{
  const fixture=createLocalData();
  const run=available=>buildPc({localData:{...fixture,getBuildCandidates:city=>fixture.getBuildCandidates(city).map(row=>{
    if(row.category==='Материнские платы')row.component.facts.motherboardSpecifications.value.internalUsbHeaders=[
      {kind:'usb2_9pin',count:2,raw:'2 x USB 2.0 internal header'},
      {kind:'usb_c_type_e',count:available,raw:`${available} x Type-C internal header`}];
    if(row.category==='Корпуса')row.component.facts.caseSpecifications.value.frontUsbHeaders=[
      {kind:'usb_c_type_e',count:1,ports:1,raw:'1 x Type-C'}];
    return row;
  })},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'});
  const mismatch=run(0);
  assert.equal(mismatch.ok,true);
  assert.match(mismatch.build.warnings.join(' '),/USB-C/);
  assert.deepEqual(run(1).build.warnings,[]);
});

test('CPU power cables must cover each separate board socket',()=>{
  assert.equal(cpuPowerConnectorFit(['1 x CPU 8-pin'],['1 x CPU 4+4-pin']),'yes');
  assert.equal(cpuPowerConnectorFit(['1 x CPU 4-pin'],['1 x CPU 4+4-pin']),'yes');
  assert.equal(cpuPowerConnectorFit(['1 x CPU 8-pin','1 x CPU 4-pin'],['1 x CPU 4+4-pin']),'no');
  assert.equal(cpuPowerConnectorFit(['1 x CPU 8-pin','1 x CPU 4-pin'],['2 x CPU 4+4-pin']),'yes');
  assert.equal(cpuPowerConnectorFit(['2 x CPU 8-pin'],['1 x CPU 8-pin','1 x CPU 4+4-pin']),'yes');
  assert.equal(cpuPowerConnectorFit(['1 x CPU 8-pin'],['2 x PCIe 6+2-pin']),'review');
  assert.equal(cpuPowerConnectorFit(undefined,['2 x CPU 4+4-pin']),'review');
});

test('CPU power connector rule blocks a build with too few EPS cables',()=>{
  const data=createLocalData();
  const run=(boardConnectors,psuConnectors)=>buildPc({localData:{...data,
    getRules:()=>[
      {category:'Материнские платы',required:true,attributes:['motherboard_cpu_power_connectors']},
      {category:'Блоки питания',required:true,attributes:['psu_cpu_connectors']}
    ],
    getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
      if(row.category==='Материнские платы')
        row.component.facts.motherboardSpecifications.value.cpuPowerConnectors=boardConnectors;
      if(row.category==='Блоки питания')
        row.component.facts.powerSupplySpecifications.value.cpuConnectors=psuConnectors;
      return row;
    })},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(run(['1 x CPU 8-pin'],['1 x CPU 4+4-pin']).ok,true);
  assert.equal(run(['1 x CPU 8-pin','1 x CPU 4-pin'],['1 x CPU 4+4-pin']).code,'no_verified_build');
  assert.equal(run(undefined,['2 x CPU 4+4-pin']).code,'needs_review');
});


test('a shared 3.5/2.5 tray cannot hold an HDD and SSD at the same time',()=>{
  const caseSpec={driveBays25:2,driveBays35:1,sharedDriveBays:1};
  assert.equal(driveBayFit(caseSpec,2,0),'yes');
  assert.equal(driveBayFit(caseSpec,2,1),'no');
  assert.equal(driveBayFit(caseSpec,1,1),'yes');
  assert.equal(driveBayFit({...caseSpec,sharedDriveBays:undefined},2,1),'review');
  assert.equal(driveBayFit({...caseSpec,sharedDriveBays:undefined},1,1),'yes');
  assert.equal(driveBayFit({driveBays25:2,driveBays35:1,sharedDriveBays:0},2,1),'yes');
});

test('required HDD uses one case bay and a SATA port alongside a 2.5-inch SSD',()=>{
  const fixture=createLocalData();
  const run=(shared,sataPorts=4)=>buildPc({localData:{...fixture,
    getRules:()=>[{category:'Жесткие диски 3.5" (для ПК)',required:true,attributes:[]}],
    getBuildCandidates:city=>{
      const rows=fixture.getBuildCandidates(city);
      const ssd=rows.find(row=>row.category==='Твердотельные диски (SSD)');
      ssd.component.facts.solidStateDriveSpecifications.value.formFactor='2.5"';
      ssd.component.facts.solidStateDriveSpecifications.value.interface='SATA';
      ssd.component.facts.solidStateDriveSpecifications.value.connection='SATA';
      rows.find(row=>row.category==='Материнские платы').component.facts.motherboardSpecifications.value.sataPorts=sataPorts;
      const enclosure=rows.find(row=>row.category==='Корпуса').component.facts.caseSpecifications.value;
      enclosure.driveBays25=1;
      enclosure.driveBays35=1;
      enclosure.sharedDriveBays=shared;
      const hdd=structuredClone(ssd);
      hdd.category='Жесткие диски 3.5" (для ПК)';
      hdd.skuOver='hdd-1';
      hdd.product={skuOver:'hdd-1',name:'Verified SATA HDD'};
      hdd.component.facts={hardDriveSpecifications:{value:{capacityGB:2000,
        formFactor:'3.5"',interface:'SATA',connection:'SATA'}}};
      hdd.offer.price=20000;
      rows.push(hdd);
      return rows;
    }},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'});
  const independent=run(0);
  assert.equal(independent.ok,true);
  assert.ok(independent.build.parts.some(part=>part.category==='Жесткие диски 3.5" (для ПК)'));
  assert.equal(run(1).code,'no_verified_build');
  assert.equal(run(undefined).code,'needs_review');
  assert.equal(run(0,1).code,'no_verified_build');
});

test('socket aliases from official attributes match without relaxing a different socket',()=>{
  const data=createLocalData();
  const run=socket=>buildPc({localData:{...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(row.category==='Материнские платы')row.component.facts.motherboardSpecifications.value.socket=socket;
    if(row.category==='Кулеры для процессоров')row.component.facts.cpuCoolerSpecifications.value.mountingSockets=['AMD AM5'];
    return row;
  })},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(run('AMD AM5').ok,true);
  assert.equal(run('AMD AM4').code,'no_verified_build');
});

test('chipset platform must agree with CPU and board sockets; BIOS version is not required',()=>{
  const data=createLocalData();
  const run=chipset=>buildPc({localData:{...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(row.category==='Материнские платы')row.component.facts.motherboardSpecifications.value.chipset=chipset;
    return row;
  })},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(run('B650').ok,true);
  assert.equal(run('  amd B650  ').ok,true);
  for(const chipset of ['A320','A520','B450','B550'])
    assert.equal(run(`AMD ${chipset}`).code,'no_verified_build');
  for(const chipset of ['320','520','450','Intel B650','AMD UNKNOWN','AMD B650 extra'])
    assert.equal(run(chipset).code,'needs_review');
  assert.equal(run('B550').code,'no_verified_build');
  assert.equal(run('UNKNOWN').code,'needs_review');
  assert.equal(run(undefined).code,'needs_review');
});

test('Intel chipset families distinguish LGA1700 from LGA1851',()=>{
  const data=createLocalData();
  const run=(socket,chipset)=>buildPc({localData:{...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(row.category==='Процессоры'){
      row.product.manufacturer='Intel';
      row.product.name=row.component.officialModel=socket==='LGA1851'?'Intel Core Ultra 5 245K':'Intel Core i5-13400';
      row.component.facts.processorSpecifications.value.socket=socket;
      row.component.facts.processorSpecifications.value.maxTurboPowerW=65;
    }
    if(row.category==='Материнские платы'){
      const board=row.component.facts.motherboardSpecifications.value;
      board.socket=socket;
      board.chipset=chipset;
    }
    if(row.category==='Кулеры для процессоров')
      row.component.facts.cpuCoolerSpecifications.value.mountingSockets=[socket];
    return row;
  })},city:'Алматы',budget:560000,cpu:'Intel',purpose:'Для игр',partPreferences:{skus:{'Процессоры':'1'}}});
  assert.equal(run('LGA1700','H610').ok,true);
  assert.equal(run('LGA1700','Intel H610').ok,true);
  assert.equal(run('LGA1851',' intel B860 ').ok,true);
  assert.equal(run('LGA1700','AMD H610').code,'requested_part_no_build');
  assert.equal(run('LGA1851','B860').ok,true);
  assert.equal(run('LGA1851','B760').code,'requested_part_no_build');
});

test('CPU selection uses socket and chipset regardless of missing or incomplete board series',()=>{
  const run=(socket,chipset,cpuSeries,boardSeries)=>{
    const rows=createLocalData().getBuildCandidates('Алматы');
    for(const row of rows){
      if(row.category==='Процессоры')Object.assign(row.component.facts.processorSpecifications.value,{socket,series:cpuSeries});
      if(row.category==='Материнские платы')Object.assign(row.component.facts.motherboardSpecifications.value,{socket,chipset,supportedCpuSeries:boardSeries});
      if(row.category==='Кулеры для процессоров')row.component.facts.cpuCoolerSpecifications.value.mountingSockets=[socket];
    }
    return buildPc({localData:{getBuildCandidates:()=>rows},city:'Алматы',budget:560000,cpu:'На усмотрение специалиста',purpose:'Для офиса'});
  };
  for(const series of [undefined,[],['Ryzen 5000']])
    for(const chipset of ['AMD A320','AMD A520','B450','B550'])
      assert.equal(run('AM4',chipset,'Ryzen 3000',series).ok,true);
  assert.equal(run('LGA1700','Intel H610','Intel Core 14th Gen',['Intel Core 12th Gen']).ok,true);
  assert.equal(run('AM4','B650','Ryzen 3000',[]).code,'no_verified_build');
});

test('GPU power connectors require the confirmed quantity, not just a matching type',()=>{
  const data=createLocalData();
  const run=count=>buildPc({localData:{...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(row.category==='Видеокарты')row.component.facts.graphicsCardSpecifications.value.powerConnectors='8-pin x 3';
    if(row.category==='Блоки питания'){
      const spec=row.component.facts.powerSupplySpecifications.value;
      spec.pciE8PinCount=count;
      spec.pcieConnectors=[{kind:'pcie_8',count,cables:count,raw:`PCIe 6+2-pin x ${count}`}];
    }
    return row;
  })},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(run(2).code,'no_verified_build');
  assert.equal(run(3).ok,true);
});

test('leading connector quantity is not confused with pin count',()=>{
  const data=createLocalData();
  const run=connector=>buildPc({localData:{...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(row.category==='Видеокарты')row.component.facts.graphicsCardSpecifications.value.powerConnectors=connector;
    if(row.category==='Блоки питания'){
      const spec=row.component.facts.powerSupplySpecifications.value;
      spec.pciE8PinCount=2;
      spec.pcieConnectors=[{kind:'pcie_8',count:2,cables:2,raw:'2 x PCIe 6+2-pin'}];
    }
    return row;
  })},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(run('1 x 8-pin').ok,true);
  assert.equal(run('2x8-pin').ok,true);
  assert.equal(run('3 x 8-pin').code,'no_verified_build');
  assert.equal(run('3x8-pin').code,'no_verified_build');
  assert.equal(run('8-pin x 2').ok,true);
});

test('CPU memory limit and case PSU form factors reject incompatible parts',()=>{
  const data=createLocalData();
  const run=(maxMemoryGB,psuFormFactors)=>buildPc({localData:{...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(row.category==='Процессоры')row.component.facts.processorSpecifications.value.maxMemoryGB=maxMemoryGB;
    if(row.category==='Корпуса')row.component.facts.caseSpecifications.value.psuFormFactors=psuFormFactors;
    return row;
  })},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(run(8,['ATX']).code,'no_verified_build');
  assert.equal(run(128,['SFX']).code,'no_verified_build');
  assert.equal(run(128,['ATX']).ok,true);
  assert.equal(run(undefined,['ATX']).code,'needs_review');
  assert.equal(run(128,undefined).code,'needs_review');
});

test('a filled required attribute without a comparison cannot certify the build',()=>{
  const data=createLocalData();
  const profile={localData:{...data,getRules:()=>[
    {category:'Процессоры',required:true,attributes:['socket']},
    {category:'Видеокарты',required:false,attributes:['gpu_unknown_connector']}],
    getRulesVersion:()=> 'coverage-v1'},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'};
  const result=buildPc(profile);
  assert.equal(result.code,'needs_review');
  assert.equal(result.rulesVersion,'coverage-v1');
  assert.match(result.reasons.join(' '),/gpu_unknown_connector/);
  assert.equal(buildPc({...profile,purpose:'Для офиса'}).ok,true);
});

test('category requirement changes the next calculation and snapshots the rule version',()=>{
  const fixture=createLocalData();
  let required=true;
  const data={...fixture,
    getRules:()=>[{category:'Охлаждение для корпусов ПК',required}],
    getRulesVersion:()=>required?'fans-required':'fans-optional',
    getBuildCandidates:city=>{
      const rows=fixture.getBuildCandidates(city);
      for(const row of rows){
        if(row.category==='Корпуса')row.component.facts.caseSpecifications.value.fanMounts=['rear 120 mm'];
        if(row.category==='Материнские платы')row.component.facts.motherboardSpecifications.value.fanHeaders=2;
      }
      rows.push({skuOver:'fan-1',category:'Охлаждение для корпусов ПК',
        product:{skuOver:'fan-1',name:'Verified 120 mm fan'},offer:{price:3000,quantity:2,days:0,supplier:'local'},
        component:{facts:{caseFanSpecifications:{value:{size:'120 x 120 mm',connector:[{kind:'fan_pwm_4pin',count:1,current_a:0.2}]}}}}});
      return rows;
    }};
  const profile={localData:data,city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для офиса'};
  const first=buildPc(profile);
  assert.equal(first.ok,true);
  assert.equal(first.build.rulesVersion,'fans-required');
  assert.ok(first.build.parts.some(part=>part.category==='Охлаждение для корпусов ПК'));
  required=false;
  const second=buildPc(profile);
  assert.equal(second.ok,true);
  assert.equal(second.build.rulesVersion,'fans-optional');
  assert.ok(!second.build.parts.some(part=>part.category==='Охлаждение для корпусов ПК'));
});

test('gaming case without factory fans needs two confirmed compatible fans',()=>{
  const fixture=createLocalData();
  const data={...fixture,getRules:()=>[],getRulesVersion:()=> 'fan-rule-v1',
    getBuildCandidates:city=>{
      const rows=fixture.getBuildCandidates(city);
      for(const row of rows){
        if(row.category==='Корпуса')Object.assign(row.component.facts.caseSpecifications.value,
          {preinstalledFans:'0',fanMounts:['front 120 mm','rear 120 mm']});
        if(row.category==='Материнские платы')row.component.facts.motherboardSpecifications.value.fanHeaders=2;
      }
      rows.push({skuOver:'fan-2',category:'Охлаждение для корпусов ПК',
        product:{skuOver:'fan-2',name:'Verified 120 mm fan'},offer:{price:3000,quantity:2,days:0,supplier:'local'},
        component:{facts:{caseFanSpecifications:{value:{size:'120 x 120 mm',connector:[{kind:'fan_pwm_4pin',count:1,current_a:0.2}]}}}}});
      return rows;
    }};
  const result=buildPc({localData:data,city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(result.ok,true);
  const fan=result.build.parts.find(part=>part.category==='Охлаждение для корпусов ПК');
  assert.equal(fan.quantity,2);
  assert.equal(fan.price,6000);
});

test('unused GPU clearances do not block an office build without a GPU',()=>{
  const fixture=createLocalData();
  const data={...fixture,getBuildCandidates:city=>fixture.getBuildCandidates(city).map(row=>{
    if(row.category==='Материнские платы'){
      delete row.component.facts.motherboardSpecifications.value.pcieX16;
      delete row.component.facts.motherboardSpecifications.value.dimensionsMmReported;
    }
    if(row.category==='Корпуса')delete row.component.facts.caseSpecifications.value.maxGpuLengthMm;
    return row;
  })};
  assert.equal(buildPc({localData:data,city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для офиса'}).ok,true);
  assert.equal(buildPc({localData:data,city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр'}).ok,false);
});

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
  assert.equal(build.assemblyBusinessDays,2);
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
  assert.match(enclosure.component.facts.caseSpecifications.value.preinstalledFans,/front|rear|top|bottom|side/i);
});

test('a case with confirmed side fans does not require an unlisted motherboard clearance',()=>{
  const data=createLocalData();
  const localData={...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(!row.component.facts.caseSpecifications)return row;
    const facts={...row.component.facts};
    facts.caseSpecifications={...facts.caseSpecifications,value:{...facts.caseSpecifications.value,
      preinstalledFans:'Side: 2 x 120 mm; Rear: 1 x 120 mm'}};
    return {...row,component:{...row.component,facts}};
  })};
  const result=buildPc({localData,city:'\u0410\u043b\u043c\u0430\u0442\u044b',budget:560000,
    cpu:'AMD',purpose:'\u0414\u043b\u044f \u0438\u0433\u0440',tasks:'CS2'});
  assert.equal(result.ok,true);
});

test('cooler rating must cover CPU power and must be confirmed',()=>{
  const data=createLocalData();
  const run=(rating,cpuTurboPowerW)=>buildPc({localData:{...data,getBuildCandidates:city=>
    data.getBuildCandidates(city).map(row=>{
      const processor=row.component.facts.processorSpecifications;
      if(processor && cpuTurboPowerW!==undefined)processor.value.pptW=cpuTurboPowerW;
      const spec=row.component.facts.cpuCoolerSpecifications;
      if(!spec)return row;
      if(rating===undefined)delete spec.value.tdpW;
      else spec.value.tdpW=rating;
      return row;
    })},city:'\u0410\u043b\u043c\u0430\u0442\u044b',budget:560000,cpu:'AMD',
    purpose:'\u0414\u043b\u044f \u0438\u0433\u0440',tasks:'CS2'});
  assert.equal(run(88).ok,true);
  assert.equal(run(87).code,'no_verified_build');
  assert.equal(run(undefined).code,'needs_review');
  assert.equal(run(104,105).code,'no_verified_build');
  assert.equal(run(105,105).ok,true);
});

test('AIO fit requires both radiator support and sufficient confirmed cooling power',()=>{
  const data=createLocalData();
  const run=rating=>buildPc({localData:{...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(row.category==='Кулеры для процессоров'){
      row.category='Системы водяного / жидкостного охлаждения (СЖО)';
      const spec=row.component.facts.cpuCoolerSpecifications.value;
      delete spec.dimensionsMm;
      spec.radiatorSizeMm=240;
      spec.pumpConnectors=[{kind:'fan_pwm_4pin',count:1,current_a:0.4}];
      if(rating===undefined)delete spec.tdpW;else spec.tdpW=rating;
    }
    if(row.category==='Корпуса')row.component.facts.caseSpecifications.value.radiatorSupport=['top 240 mm'];
    return row;
  })},city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для офиса'});
  assert.equal(run(undefined).ok,false);
  assert.equal(run(87).ok,false);
  assert.equal(run(88).ok,true);
});

test('other city always maps to Almaty for stock and transfer calculation',()=>{
  const result=buildPc({localData:createLocalData(),city:'Другой город',budget:560000,cpu:'AMD',purpose:'Для игр',tasks:'CS2'});
  assert.equal(result.ok,true);
  assert.equal(result.build.city,'Алматы');
  assert.ok(result.build.parts.every(part=>part.transferBusinessDays<=10));
});

test('gaming build needs review when factory-installed fans are unknown',()=>{
  const data=createLocalData();
  const localData={...data,getBuildCandidates:city=>data.getBuildCandidates(city).map(row=>{
    if(row.category!=='Корпуса')return row;
    const facts={...row.component.facts};
    facts.caseSpecifications={...facts.caseSpecifications,value:{...facts.caseSpecifications.value,preinstalledFans:null}};
    return {...row,component:{...row.component,facts}};
  })};
  const result=buildPc({localData,city:'Алматы',budget:560000,cpu:'AMD',purpose:'Для игр',tasks:'CS2'});
  assert.equal(result.ok,false);
  assert.equal(result.code,'needs_review');
  assert.match(result.reasons.join(' '),/штатных вентиляторах/);
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
  const ram=rows.find(r=>r.category==='Оперативная память');
  ram.component.facts.memorySpecifications.value.capacityGB=32;
  ram.component.facts.memorySpecifications.value.moduleCount=2;
  const ssd=rows.find(r=>r.category==='Твердотельные диски (SSD)');
  ssd.component.facts.solidStateDriveSpecifications.value.capacityGB=1000;
  const two=structuredClone(ssd);two.skuOver=two.product.skuOver='900000001';two.offer.price=2000;
  two.component.facts.solidStateDriveSpecifications.value.capacityGB=2000;
  const four=structuredClone(ssd);four.skuOver=four.product.skuOver='900000002';four.offer.price=4000;
  four.component.facts.solidStateDriveSpecifications.value.capacityGB=4000;
  rows.push(two,four);
  return {rows,ssd,two,four,base:seed.parts.length*1000,
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

test('office and creative budgets respect the 16-32 GB RAM range and SSD targets',()=>{
  const f=budgetFixture();
  const ram=f.rows.find(r=>r.category==='Оперативная память');
  ram.component.facts.memorySpecifications.value.capacityGB=16;
  ram.component.facts.memorySpecifications.value.moduleCount=1;
  const larger=structuredClone(ram);larger.skuOver=larger.product.skuOver='900000007';larger.offer.price=3000;
  larger.component.facts.memorySpecifications.value.capacityGB=64;
  larger.component.facts.memorySpecifications.value.moduleCount=2;
  f.rows.push(larger);
  for(const [purpose,expectedRam,expectedSSD] of [['Для офиса',ram,f.ssd],['Для работы и творчества',ram,f.four]]) {
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
  f.rows.find(r=>r.category==='Кулеры для процессоров').component.officialModel='DeepCool AG600';
  const stronger=structuredClone(cpu);stronger.skuOver=stronger.product.skuOver='900000008';
  stronger.component.officialModel='AMD Ryzen 7 9700X';stronger.product.name='AMD Ryzen 7 9700X';stronger.offer.price=3000;
  stronger.component.facts.processorSpecifications.value.cores=8;
  stronger.component.facts.processorSpecifications.value.threads=16;
  stronger.component.facts.processorSpecifications.value.series='Ryzen 9000';
  const betterBoard=structuredClone(board);betterBoard.skuOver=betterBoard.product.skuOver='900000009';betterBoard.offer.price=2000;
  Object.assign(betterBoard.component.facts.motherboardSpecifications.value,{memorySlots:4,lan:'2.5 Gigabit Ethernet',wifiBuiltIn:true,supportedCpuSeries:['Ryzen 9000']});
  f.rows.push(stronger,betterBoard);
  assert.equal(String(f.run(f.base).parts.find(p=>p.category==='Процессоры').skuOver),cpu.skuOver);
  const result=f.run(f.base+6000);
  assert.equal(String(result.parts.find(p=>p.category==='Процессоры').skuOver),stronger.skuOver);
  assert.equal(String(result.parts.find(p=>p.category==='Материнские платы').skuOver),betterBoard.skuOver);
  assert.equal(result.overBudget,false);
  f.rows.reverse();
  assert.deepEqual(f.run(f.base+6000).parts,result.parts);
  betterBoard.component.facts.motherboardSpecifications.value.supportedCpuSeries=[];
  assert.equal(String(f.run(f.base+6000).parts.find(p=>p.category==='Процессоры').skuOver),stronger.skuOver);
});

test('costlier identical CPUs are not upgrades and the requested brand stays mandatory',()=>{
  const f=budgetFixture();const cpu=f.rows.find(r=>r.category==='Процессоры');
  const duplicate=structuredClone(cpu);duplicate.skuOver=duplicate.product.skuOver='900000010';duplicate.offer.price=10000;
  f.rows.unshift(duplicate);
  assert.equal(String(f.run(100000).parts.find(p=>p.category==='Процессоры').skuOver),cpu.skuOver);
  const response=buildPc({localData:{getBuildCandidates:()=>f.rows},city:'Павлодар',budget:100000,cpu:'Intel',purpose:'Для игр'});
  assert.equal(response.ok,false);
});

test('1440p pilot uses source measurements to distinguish 8 GB and 16 GB GPUs',()=>{
  const rows=createLocalData().getBuildCandidates('Алматы').filter(row=>
    row.category!=='Видеокарты'||row.component.facts.graphicsCardSpecifications.value.gpu==='GeForce RTX 5060');
  const eight=rows.find(row=>row.category==='Видеокарты');
  eight.component.facts.graphicsCardSpecifications.value.gpu='GeForce RTX 5060 Ti';
  eight.product.name='RTX 5060 Ti 8 GB';
  const sixteen=structuredClone(eight);
  sixteen.skuOver=sixteen.product.skuOver='999';
  sixteen.component.facts.graphicsCardSpecifications.value.memoryGB=16;
  sixteen.product.name='RTX 5060 Ti 16 GB';
  rows.push(sixteen);
  const request=(tasks,partPreferences)=>buildPc({localData:{getBuildCandidates:()=>rows},city:'Алматы',
    budget:500000,cpu:'AMD',purpose:'Для игр',tasks,partPreferences}).build;
  const ordinary=request('Игры');
  const measured=request('Игры в 1440p');
  assert.equal(ordinary.parts.find(part=>part.category==='Видеокарты').skuOver,sixteen.skuOver);
  assert.equal(measured.parts.find(part=>part.category==='Видеокарты').skuOver,sixteen.skuOver);
  assert.equal(measured.performanceEvidence.referenceFps,56.1);
  assert.equal(measured.performanceEvidence.source,'ComputerBase');
  const selected=request('Игры',{coolerType:null,skus:{},gamingResolution:'1440p'});
  assert.equal(selected.parts.find(part=>part.category==='Видеокарты').skuOver,sixteen.skuOver);
  assert.equal(ordinary.performanceEvidence.source,'ComputerBase');
});

test('CPU evidence matches an exact catalog model and verified socket and cores',()=>{
  const fixture=createLocalData();
  const request=buildPc({localData:fixture,city:'Алматы',budget:550000,cpu:'AMD',
    purpose:'Для игр',tasks:'Игры в 1440p'});
  assert.equal(request.ok,true);
  assert.equal(request.build.processorEvidence.model,'AMD Ryzen 5 7600');
  assert.equal(request.build.processorEvidence.referenceOnePercentLow,65);
  assert.equal(cpuEvidence({manufacturer:'AMD',name:'Процессор AMD Ryzen 5 7600X 4.7 GHz'},
    {socket:'AM5',cores:6}).model,'AMD Ryzen 5 7600X');
  assert.equal(cpuEvidence({manufacturer:'AMD',name:'Процессор AMD Ryzen 5 7600X 4.7 GHz'},
    {socket:'AM4',cores:6}),null);
});

test('CPU ranking accepts a measured Intel model without an editorial model rule',()=>{
  const {cpuEvidence,cpuUtilityFromEvidence}=require('../tools/performance-evidence.cjs');
  const evidence=cpuEvidence({name:'Core Ultra 9 285K',manufacturer:'Intel'},
    {socket:'LGA1851',cores:24},'Intel Core Ultra 9 285K');
  assert.equal(evidence.source,'ComputerBase');
  assert.ok(cpuUtilityFromEvidence(evidence)>24);
});
