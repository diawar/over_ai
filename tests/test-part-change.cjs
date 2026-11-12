'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
const {buildPc}=require('../tools/pc-builder.cjs');
const {resolvePartChange,AIR,AIO}=require('../tools/part-preferences.cjs');
const {createServer}=require('../tools/preview-app.cjs');

function catalog(){
  const fixture=createBuildFixture();
  const rows=fixture.getBuildCandidates('Алматы');
  const air=rows.find(row=>row.category===AIR);
  air.skuOver=air.product.skuOver='88930001';
  air.component.officialModel='DeepCool AK620 G2';
  air.component.facts.cpuCoolerSpecifications.value.noiseDba=20;
  const aio=structuredClone(air);
  aio.skuOver=aio.product.skuOver='88930002';
  aio.category=AIO;
  aio.product.name='Corsair TITAN 240';
  aio.component.officialModel='Corsair TITAN 240';
  aio.component.facts.cpuCoolerSpecifications.value={
    fanConnectors:[{kind:'fan_pwm_4pin',count:1,current_a:0.3}],
    pumpConnectors:[{kind:'fan_pwm_4pin',count:1,current_a:0.4}],
    lightingConnectors:[{kind:'none',count:0}],
    mountingSockets:['AM5'],radiatorSizeMm:240,tdpW:150,type:'aio',noiseDba:30};
  aio.offer.price=5000;
  rows.find(row=>row.category==='Корпуса').component.facts.caseSpecifications.value.radiatorSupport=['top 240 mm'];
  rows.push(aio);
  return {rows,localData:{getBuildCandidates:()=>structuredClone(rows)}};
}

test('white PC request becomes a persistent white color preference',()=>{
  const preferences=resolvePartChange('Соберите белый ПК',[],null);
  assert.equal(preferences.colorPreference,'white');
  assert.equal(resolvePartChange('Нужен white PC',[],preferences).colorPreference,'white');
});
const profile={city:'Алматы',budget:500000,cpu:'AMD',purpose:'Для офиса'};
const cooler=result=>result.build.parts.find(part=>part.category===AIR||part.category===AIO);

test('a request for air cooling replaces an AIO without bypassing compatibility',()=>{
  const {rows,localData}=catalog();
  assert.equal(cooler(buildPc({localData,...profile})).category,AIO);
  const preferences=resolvePartChange('Замените СЖО на воздушный кулер',rows,null);
  assert.equal(preferences.coolerType,'air');
  const exact=resolvePartChange('Замените СЖО на воздушный кулер DeepCool AK620 G2',rows,null);
  assert.equal(exact.skus[AIR],'88930001');
  assert.equal(resolvePartChange('Не хочу СЖО',rows,null).coolerType,'air');
  assert.equal(cooler(buildPc({localData,...profile,partPreferences:preferences})).category,AIR);
  const incompatible=structuredClone(rows);
  incompatible.find(row=>row.category===AIR).component.facts.cpuCoolerSpecifications.value.mountingSockets=['LGA1700'];
  const rejected=buildPc({localData:{getBuildCandidates:()=>incompatible},...profile,partPreferences:preferences});
  assert.equal(rejected.code,'requested_part_no_build');
});

test('exact model replacement is pinned and unavailable SKU never falls back',()=>{
  const {rows,localData}=catalog();
  const preferences=resolvePartChange('Поставьте кулер DeepCool AK620 G2',rows,null);
  assert.equal(preferences.skus[AIR],'88930001');
  assert.equal(cooler(buildPc({localData,...profile,partPreferences:preferences})).skuOver,'88930001');
  const unavailable=buildPc({localData,...profile,partPreferences:{coolerType:'air',skus:{[AIR]:'99999999'}}});
  assert.equal(unavailable.code,'requested_part_unavailable');
  const unsupported=buildPc({localData,...profile,partPreferences:{coolerType:null,
    skus:{'Видеокарты':rows.find(row=>row.category==='Видеокарты').skuOver}}});
  assert.equal(unsupported.ok,true);
  assert.equal(unsupported.build.parts.find(row=>row.category==='Видеокарты')?.skuOver,
    rows.find(row=>row.category==='Видеокарты').skuOver);
});

test('unclear replacement is rejected instead of silently changing the build',()=>{
  const {rows}=catalog();
  assert.throws(()=>resolvePartChange('Замените кулер',rows,null),/cooler_type_required/);
  assert.throws(()=>resolvePartChange('Замените видеокарту на DeepCool AK620 G2',rows,null),
    /part_request_category_mismatch/);
});

test('generic RAM, HDD and fan requests become mandatory build constraints',()=>{
  const {rows}=catalog();
  const hdd=structuredClone(rows.find(row=>row.category==='Твердотельные диски (SSD)'));
  hdd.category='Жесткие диски 3.5" (для ПК)';hdd.skuOver=hdd.product.skuOver='88930003';
  hdd.component.facts={hardDriveSpecifications:{value:{capacityGB:2000,formFactor:'3.5',interface:'SATA',connection:'SATA'}}};
  const fan=structuredClone(rows.find(row=>row.category===AIR));
  fan.category='Охлаждение для корпусов ПК';fan.skuOver=fan.product.skuOver='88930004';
  fan.component.facts={caseFanSpecifications:{value:{size:'120 mm',connector:[{kind:'fan_pwm_4pin',count:1,current_a:0.2}]}}};
  rows.find(row=>row.category==='Корпуса').component.facts.caseSpecifications.value.fanMounts=['front 120 mm','rear 120 mm'];
  rows.find(row=>row.category==='Материнские платы').component.facts.motherboardSpecifications.value.fanHeaders=2;
  rows.push(hdd,fan);
  const localData={getBuildCandidates:()=>structuredClone(rows)};
  let preferences=resolvePartChange('Хочу больше оперативной памяти',rows,null);
  assert.equal(preferences.minMemoryGB,32);
  assert.equal(resolvePartChange('Нужно 64 ГБ оперативной памяти',rows,null).minMemoryGB,64);
  preferences=resolvePartChange('Добавьте HDD',rows,preferences);
  preferences=resolvePartChange('Поставьте корпусные вентиляторы',rows,preferences);
  assert.equal(preferences.includeHdd,true);
  assert.equal(preferences.includeCaseFans,true);
  const built=buildPc({localData,...profile,partPreferences:preferences});
  assert.equal(built.ok,true,JSON.stringify(built));
  assert.equal(built.build.parts.find(row=>row.category==='Оперативная память').quantity,2);
  assert.ok(built.build.parts.some(row=>row.category===hdd.category));
  assert.ok(built.build.parts.some(row=>row.category===fan.category));
  assert.equal(buildPc({localData:{getBuildCandidates:()=>rows.filter(row=>row.category!==hdd.category)},
    ...profile,partPreferences:preferences}).code,'requested_part_no_build');
});

test('an office customer can request a GPU without naming its model',()=>{
  const {rows,localData}=catalog();
  const preferences=resolvePartChange('Добавьте видеокарту',rows,null);
  assert.equal(preferences.includeGpu,true);
  const built=buildPc({localData,...profile,partPreferences:preferences});
  assert.equal(built.ok,true,JSON.stringify(built));
  assert.ok(built.build.parts.some(row=>row.category==='Видеокарты'));
  const absent=buildPc({localData:{getBuildCandidates:()=>rows.filter(row=>row.category!=='Видеокарты')},
    ...profile,partPreferences:preferences});
  assert.equal(absent.code,'requested_part_no_build');
});

test('quiet request compares the current cooler and enforces a lower confirmed fan noise',()=>{
  const {rows,localData}=catalog();
  const before=buildPc({localData,...profile});
  assert.equal(cooler(before).category,AIO);
  const prefs=resolvePartChange('Сделайте кулер тише',rows,null,before.build);
  assert.equal(prefs.maxCoolerNoiseDba,30);
  const after=buildPc({localData,...profile,partPreferences:prefs});
  assert.equal(cooler(after).category,AIR);
  assert.throws(()=>resolvePartChange('Сделайте компьютер тише',rows,null),/quiet_build_unavailable/);
  const missing=structuredClone(rows);
  delete missing.find(row=>row.category===AIO).component.facts.cpuCoolerSpecifications.value.noiseDba;
  assert.throws(()=>resolvePartChange('Сделайте кулер тише',missing,null,before.build),/quiet_baseline_unknown/);
});

test('quiet request compares a selected case fan against a quieter compatible case fan',()=>{
  const {rows}=catalog();
  const board=rows.find(row=>row.category==='Материнские платы');
  board.component.facts.motherboardSpecifications.value.fanHeaders=2;
  const enclosure=rows.find(row=>row.category==='Корпуса');
  enclosure.component.facts.caseSpecifications.value.fanMounts=['front 120 mm','rear 120 mm'];
  const oldFan=structuredClone(rows.find(row=>row.category===AIR));
  oldFan.category='Охлаждение для корпусов ПК';oldFan.skuOver=oldFan.product.skuOver='88930006';
  oldFan.component.facts={caseFanSpecifications:{value:{size:'120 mm',connector:[{kind:'fan_pwm_4pin',count:1,current_a:0.2}],noiseDba:32}}};
  const newFan=structuredClone(oldFan);
  newFan.skuOver=newFan.product.skuOver='88930007';
  newFan.component.facts.caseFanSpecifications.value.noiseDba=24;
  rows.push(oldFan,newFan);
  const localData={getBuildCandidates:()=>structuredClone(rows)};
  const pinned={coolerType:null,skus:{'Охлаждение для корпусов ПК':oldFan.skuOver}};
  const before=buildPc({localData,...profile,partPreferences:pinned});
  assert.equal(before.ok,true);
  const prefs=resolvePartChange('Сделайте корпусные вентиляторы тише',rows,pinned,before.build);
  assert.equal(prefs.maxFanNoiseDba,32);
  const after=buildPc({localData,...profile,partPreferences:prefs});
  assert.equal(after.build.parts.find(part=>part.category===oldFan.category)?.skuOver,newFan.skuOver);
});

test('a cheaper part request uses the current verified price and lowers the total',()=>{
  const {rows}=catalog();
  const original=rows.find(row=>row.category==='Корпуса');
  const expensive=structuredClone(original);
  expensive.skuOver=expensive.product.skuOver='88930005';
  expensive.product.name='Costly case';expensive.offer.price=original.offer.price+20000;
  rows.push(expensive);
  const localData={getBuildCandidates:()=>structuredClone(rows)};
  const current={coolerType:null,skus:{Корпуса:expensive.skuOver}};
  const before=buildPc({localData,...profile,partPreferences:current});
  assert.equal(before.ok,true);
  const preferences=resolvePartChange('Поставьте корпус дешевле',rows,current,before.build);
  assert.equal(preferences.skus['Корпуса'],undefined);
  assert.equal(preferences.cheaperThan['Корпуса'],expensive.offer.price);
  const after=buildPc({localData,...profile,partPreferences:preferences});
  assert.equal(after.ok,true,JSON.stringify(after));
  assert.equal(after.build.parts.find(part=>part.category==='Корпуса').skuOver,original.skuOver);
  assert.ok(after.build.total<before.build.total);
  assert.throws(()=>resolvePartChange('Сделайте дешевле',rows,current,before.build),/cheaper_category_required/);
});

test('HTTP change request returns a recalculated build and keeps rejected changes separate',async()=>{
  const {localData}=catalog();
  const server=createServer({buildDataProvider:async()=>localData,chatService:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const send=async changeRequest=>{
    const response=await fetch(`${base}/api/pc-build`,{method:'POST',
      headers:{Origin:base,'Content-Type':'application/json'},
      body:JSON.stringify({...profile,changeRequest})});
    return {status:response.status,body:await response.json()};
  };
  try{
    const changed=await send('Замените СЖО на воздушный кулер');
    assert.equal(changed.status,200);
    assert.equal(changed.body.partPreferences.coolerType,'air');
    assert.equal(changed.body.build.parts.find(part=>part.category===AIR)?.skuOver,'88930001');
    const rejected=await send('Замените кулер');
    assert.equal(rejected.status,422);
    assert.equal(rejected.body.error,'cooler_type_required');
    const quieter=await send('Сделайте кулер тише');
    assert.equal(quieter.status,200);
    assert.deepEqual([quieter.body.noiseComparison.previousDba,quieter.body.noiseComparison.selectedDba],[30,20]);
    const unspecified=await send('Сделайте дешевле');
    assert.equal(unspecified.status,422);
    assert.equal(unspecified.body.error,'cheaper_category_required');
    const noCheaper=await send('Поставьте корпус дешевле');
    assert.equal(noCheaper.status,422);
    assert.equal(noCheaper.body.error,'cheaper_part_no_build');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
