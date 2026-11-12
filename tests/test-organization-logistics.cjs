const test=require('node:test');
const assert=require('node:assert/strict');
const {createCorelabData}=require('../tools/corelab-data.cjs');
const {organizationWarehouses}=require('../tools/organization-logistics.cjs');
const base={branches:[{code:'ALP',source_label:'OVER ALP',city:'Алматы',kind:'branch',active:true},
  {code:'AS',source_label:'OVER AS',city:'Астана',kind:'branch',active:true},
  {code:'SUP',source_label:'SUP',city:'Алматы',kind:'supplier_warehouse',active:true},
  {code:'OFF',source_label:'VENDER_P_S',city:'Алматы',kind:'supplier_warehouse',active:false}],
  routes:[{from_branch:'ALP',to_branch:'AS',workdays:5},{from_branch:'SUP',to_branch:'AS',workdays:10}]};
test('directed routes, local stock and exclusions come from organization settings',()=>{
  const warehouses=organizationWarehouses(base);
  assert.deepEqual(warehouses.get('OVER ALP').deliveries,{'Алматы':0,'Астана':5});
  assert.deepEqual(warehouses.get('OVER AS').deliveries,{'Астана':0});
  assert.equal(warehouses.has('VENDER_P_S'),false);
  assert.equal(warehouses.get('SUP').deliveries['Астана'],10);
  assert.equal(organizationWarehouses(null).size,0);
});
test('next catalog calculation follows changed timing without local files',()=>{
  const items=[{skuOver:'1',name:'CPU',category:'Процессоры',attributes:{socket:'AM5'},offers:[{price:1000,dealersData:['SUP (1)']}]}];
  const run=operations=>createCorelabData(items,'/nonexistent',{operations}).getBuildCandidates('Астана');
  assert.equal(run(base)[0].offer.days,10);
  const updated=structuredClone(base); updated.routes[1].workdays=3;
  assert.equal(run(updated)[0].offer.days,3);
  updated.routes.splice(1,1);
  assert.equal(run(updated).length,0);
  assert.equal(run(null).length,0);
});
test('two branches in one destination city do not silently select the faster branch',()=>{
  const settings=structuredClone(base);
  settings.branches.push({code:'AS2',city:'Астана',kind:'branch',active:true});
  assert.equal(organizationWarehouses(settings).get('OVER ALP').deliveries['Астана'],undefined);
});

test('explicit branch uses intracity routes without adding transit or inventing a reverse route',()=>{
  const settings={branches:[{code:'A',city:'Город',active:true,kind:'branch'},{code:'B',city:'Город',active:true,kind:'branch'}],
    routes:[{from_branch:'A',to_branch:'B',workdays:2}]};
  assert.equal(organizationWarehouses(settings,'B').get('A').deliveries['Город'],2);
  assert.equal(organizationWarehouses(settings,'B').get('B').deliveries['Город'],0);
  assert.equal(organizationWarehouses(settings,'A').get('B').deliveries['Город'],undefined);
  settings.branches[1].active=false;
  assert.equal(organizationWarehouses(settings,'B').get('A').deliveries['Город'],undefined);
});
