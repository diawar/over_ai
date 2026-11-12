'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createExactBuildValidator}=require('../tools/exact-build-validator.cjs');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
const defaultRequest={budget:1000000,cpu:'На усмотрение специалиста',purpose:'Для офиса'};
test('unknown GPU cable count gives AI exact missing connection evidence',()=>{
 const gpu=structuredClone(createBuildFixture().getBuildCandidates().find(r=>r.category==='Видеокарты'));
 gpu.component.facts.graphicsCardSpecifications.value.powerConnectors=[{kind:'pcie_8',count:2}];
 const {validator,proposal}=setup(rows=>{
  rows.push(gpu);rows.find(r=>r.category==='Блоки питания').component.facts.powerSupplySpecifications.value.pcieConnectors=[{kind:'pcie_8',count:4,cables:null}];
 });
 const report=validator.validate(proposal),finding=report.unknowns.find(v=>v.code==='gpu_power_connectors');
 assert.ok(finding);assert.equal(finding.context.psuPcieConnectors[0].cables,null);
 assert.equal(finding.context.gpuPowerConnectors[0].count,2);assert.match(finding.context.hint,/cables:null/);assert.equal(report.ok,false);
});
function setup(mutate=()=>{},org=1,request=defaultRequest){
  const rows=createBuildFixture().getBuildCandidates().filter(r=>r.category!=='Видеокарты');mutate(rows);
  const data={getBuildCandidates:()=>rows};
  const validator=createExactBuildValidator({localData:data,organizationId:org,city:'Алматы',request});
  const proposal={snapshotId:validator.snapshotId,parts:rows.map(r=>({skuOver:r.skuOver,quantity:1}))};
  return {rows,data,validator,proposal};
}
test('exact validation keeps SKU and quantity, uses server prices and does not require benchmarks',()=>{
  const {validator,proposal}=setup();proposal.parts[0].price=1;
  const report=validator.validate(proposal);
  assert.equal(report.ok,true,JSON.stringify(report));
  assert.equal(report.total,240000);
  assert.deepEqual(report.parts.map(p=>({skuOver:p.skuOver,quantity:p.quantity})),proposal.parts.map(({skuOver,quantity})=>({skuOver,quantity})));
});
test('unknown and duplicate SKU, invalid quantities and missing parts are rejected without substitution',()=>{
  for(const mutate of [p=>p.parts[0].skuOver='foreign',p=>p.parts.push({...p.parts[0]}),p=>p.parts[0].quantity=0,p=>p.parts.pop()]){
    const {validator,proposal}=setup();mutate(proposal);assert.equal(validator.validate(proposal).ok,false);
  }
});
test('snapshot is scoped and detached from mutable catalog; new price needs new snapshot',()=>{
  const a=setup(),b=setup(()=>{},2);
  assert.equal(b.validator.validate(a.proposal).violations[0].code,'snapshot_mismatch');
  a.rows[0].offer.price+=50000;
  assert.equal(a.validator.validate(a.proposal).total,240000);
  const fresh=createExactBuildValidator({localData:a.data,organizationId:1,city:'Алматы',request:defaultRequest});
  assert.equal(fresh.validate(a.proposal).violations[0].code,'snapshot_mismatch');
});
test('budget and quantity stock are mandatory constraints',()=>{
  const {validator,proposal}=setup(()=>{},1,{...defaultRequest,budget:1000});
  assert.ok(validator.validate(proposal).violations.some(x=>x.code==='budget_exceeded'));
  proposal.parts[2].quantity=11;
  assert.ok(validator.validate(proposal).violations.some(x=>x.code==='offer_unavailable'));
});
test('socket mismatch differs from unknown socket',()=>{
  for(const [value,key] of [['AM4','violations'],[null,'unknowns']]){
    const {validator,proposal}=setup(rows=>rows[0].component.facts.processorSpecifications.value.socket=value);
    const result=validator.validate(proposal);assert.equal(result.ok,false);
    assert.ok(result[key].some(x=>x.code.startsWith('platform_')));
  }
});
test('underpowered cooler and excessive RAM are rejected without selecting alternatives',()=>{
  const {validator,proposal}=setup(rows=>rows.at(-1).component.facts.cpuCoolerSpecifications.value.tdpW=10);
  proposal.parts[2].quantity=5;
  const report=validator.validate(proposal);
  assert.ok(report.violations.some(x=>x.code==='cooling_mismatch'));
  assert.ok(report.violations.some(x=>x.code==='memory_capacity_exceeded'));
});
test('multi-branch catalogs require an exact destination and preserve scoped inventory',()=>{
  const {data}=setup();data.getBranches=()=>[{code:'A'},{code:'B'}];
  assert.throws(()=>createExactBuildValidator({localData:data,organizationId:1,city:'Алматы',request:defaultRequest}),/exact_destination/);
  data.getBuildCandidates=(city,branch)=>{assert.equal(branch,'B');return [];};
  const validator=createExactBuildValidator({localData:data,organizationId:1,city:'Алматы',pickupBranch:'B',request:defaultRequest});
  assert.equal(validator.pickupBranch,'B');
});

test('GPU dimensions and power connectors use the existing compatibility checks',()=>{
  const fixture=createBuildFixture().getBuildCandidates().find(r=>r.category==='Видеокарты');
  const {validator,proposal}=setup(rows=>{
    const gpu=structuredClone(fixture);gpu.component.facts.graphicsCardSpecifications.value.dimensions.lengthMm=900;
    gpu.component.facts.graphicsCardSpecifications.value.powerConnectors='3 x 8-pin';rows.push(gpu);
  });
  const report=validator.validate(proposal);
  assert.ok(report.violations.some(x=>x.code==='gpu_too_long'));
  assert.ok(report.violations.some(x=>x.code==='gpu_power_connectors'));
});

test('missing critical headers and unsupported mandatory attributes are unknown, not certified',()=>{
  const {rows,proposal}=setup(rows=>delete rows[1].component.facts.motherboardSpecifications.value.coolingHeaders);
  const validator=createExactBuildValidator({organizationId:1,city:'Алматы',request:defaultRequest,localData:{getBuildCandidates:()=>rows,
    getRules:()=>[{category:'Процессоры',attributes:['unimplemented_requirement']}]}});
  const report=validator.validate({...proposal,snapshotId:validator.snapshotId});
  assert.equal(report.ok,false);
  assert.ok(report.unknowns.some(x=>x.code==='cooling_wiring'));
  assert.ok(report.unknowns.some(x=>x.code==='unchecked_required_rule'));
});

test('customer budget and pinned requirements cannot be overridden by an AI proposal',()=>{
  const {validator,proposal}=setup();proposal.budget=2000000;
  assert.equal(validator.validate(proposal).violations[0].code,'customer_budget_mismatch');
  const pinned=setup(()=>{},1,{...defaultRequest,cpu:'Intel',partPreferences:{skus:{Процессоры:'unavailable'},minMemoryGB:32,includeHdd:true,coolerType:'aio'}});
  const codes=pinned.validator.validate(pinned.proposal).violations.map(v=>v.code);
  for(const code of ['cpu_brand_mismatch','pinned_part_mismatch','requested_memory_insufficient','required_optional_part','cooler_preference_mismatch'])assert.ok(codes.includes(code),code);
});

test('HDD checks distinguish SATA, unsupported SAS and missing data; no hidden substitution',()=>{
  for(const [connection,expected] of [['SATA',true],['SAS',false],[null,false]]){
    const {validator,proposal}=setup(rows=>rows.push({skuOver:'hdd',category:'Жесткие диски 3.5" (для ПК)',
      product:{skuOver:'hdd',name:'HDD'},offer:{price:10000,quantity:1,days:0,supplier:'OVER PAV'},
      component:{facts:{hardDriveSpecifications:{value:{capacityGB:1000,formFactor:'3.5',interface:connection,connection}}}}}));
    const report=validator.validate(proposal);assert.equal(report.ok,expected,JSON.stringify(report));
    if(expected)assert.ok(report.parts.some(p=>p.skuOver==='hdd'));
    else assert.ok((connection?report.violations:report.unknowns).some(v=>v.code.startsWith('hdd_')));
  }
});

test('workload GPU and known memory floors are enforced without benchmark ranking',()=>{
  const {validator,proposal}=setup(()=>{},1,{...defaultRequest,purpose:'Для работы и творчества',partPreferences:{skus:{},
    workloadProfile:{version:1,tasks:[{application:'twinmotion',operation:'interactive',priority:'primary',complexity:'heavy'}]}}});
  const codes=validator.validate(proposal).violations.map(v=>v.code);
  assert.ok(codes.includes('workload_gpu_required'));assert.ok(codes.includes('requested_memory_insufficient'));
});

test('unconfirmed white color and noise do not pass explicit preferences',()=>{
  const {validator,proposal}=setup(()=>{},1,{...defaultRequest,partPreferences:{skus:{},colorPreference:'white',maxCoolerNoiseDba:30}});
  const codes=validator.validate(proposal).unknowns.map(v=>v.code);
  assert.ok(codes.includes('color_unknown'));assert.ok(codes.includes('noise_unknown'));
});

test('explicit 4K floor is enforced while ordinary 1080p is not assigned a fabricated floor',()=>{
  const gpu=createBuildFixture().getBuildCandidates().find(r=>r.category==='Видеокарты');
  for(const resolution of ['1080p','4K']){
    const {validator,proposal}=setup(rows=>rows.push(structuredClone(gpu)),1,{...defaultRequest,purpose:'Для игр',
      partPreferences:{skus:{},gamingResolution:resolution}});
    const report=validator.validate(proposal);
    if(resolution==='4K')assert.ok(report.violations.some(v=>v.code==='resolution_requirement_unmet'));
    else assert.equal(report.ok,true,JSON.stringify(report));
  }
});
test('wiring unknown points to missing motherboard control evidence',()=>{const {validator,proposal}=setup(rows=>{const board=rows.find(r=>r.category==='Материнские платы');for(const header of board.component.facts.motherboardSpecifications.value.coolingHeaders)delete header.control;});const result=validator.validate(proposal);assert.equal(result.ok,false);const finding=result.unknowns.find(v=>v.code==='cooling_wiring');assert.ok(finding.context.missingEvidence.some(p=>p.endsWith('.control')));assert.ok(finding.context.boardSku);});

test('incomplete cooler evidence does not direct AI to replace a documented motherboard',()=>{
  const {validator,proposal}=setup(rows=>{
    const cooler=rows.find(r=>r.category==='Кулеры для процессоров');
    cooler.component.facts.cpuCoolerSpecifications.value.fanConnectors=[{kind:'fan_4pin',count:1,raw:'1 x 4-pin fan'}];
  });
  const finding=validator.validate(proposal).unknowns.find(v=>v.code==='cooling_wiring');
  assert.ok(finding);
  assert.ok(finding.context.missingEvidence.includes('cooler.fanConnectors[0].kind'));
  assert.ok(finding.context.missingEvidence.includes('cooler.fanConnectors[0].current_a'));
  assert.equal(finding.context.missingEvidence.some(p=>p.startsWith('board.')),false);
  assert.doesNotMatch(finding.context.hint,/Search motherboards/);
});
