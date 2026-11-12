'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {coolingConnectionFit:fit}=require('../tools/cooling-connectors.cjs');
const {buildPc}=require('../tools/pc-builder.cjs');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
const motor={kind:'fan_pwm_4pin',count:1,current_a:0.3};
const none=[{kind:'none',count:0}];
const cooler=()=>({fanConnectors:[{...motor}],pumpConnectors:[{...motor}],lightingConnectors:none});
const header=(roles,count=1)=>({kind:roles.length>1?'combo_fan_header':roles[0]+'_header',
  roles,count,pins:4,control:['pwm'],max_current_a:1});
const board=()=>({coolingHeaders:[header(['cpu_fan']),header(['pump','system_fan'])],lightingHeaders:none});

test('AIO and case fan cannot both consume the same pump/system header',()=>{
  const b=board();
  assert.equal(fit(b,cooler(),{liquid:true}).fit,'yes');
  assert.equal(fit(b,cooler(),{liquid:true,caseFan:{connector:[motor]}}).fit,'no');
  b.coolingHeaders.push(header(['system_fan']));
  assert.equal(fit(b,cooler(),{liquid:true,caseFan:{connector:[motor]}}).fit,'yes');
});
test('unknown current is review; excessive current and unsupported PWM/DC are rejected',()=>{
  const c=cooler(),b=board();
  delete c.fanConnectors[0].current_a;
  assert.equal(fit(b,c).fit,'review');
  c.fanConnectors[0].current_a=2;
  assert.equal(fit(b,c).fit,'no');
  c.fanConnectors[0]={kind:'fan_dc_3pin',count:1,current_a:0.2};
  assert.equal(fit(b,c).fit,'no');
  b.coolingHeaders[0].control.push('dc');
  assert.equal(fit(b,c).fit,'yes');
});
test('ARGB is never satisfied by RGB; insufficient lighting warns without rejecting cooling',()=>{
  const c=cooler(),b=board();
  c.lightingConnectors=[{kind:'argb_3pin_5v',count:1}];
  b.lightingHeaders=[{kind:'rgb_4pin_12v',count:3}];
  assert.equal(fit(b,c).fit,'yes');
  assert.match(fit(b,c).warnings.join(' '),/ARGB 3-pin 5V/);
  b.lightingHeaders=[{kind:'argb_3pin_5v',count:1}];
  assert.deepEqual(fit(b,c).warnings,[]);
  assert.equal(fit(b,c,{caseFan:{connector:[motor,{kind:'argb_3pin_5v',count:1}]}}).warnings.length,1);
});
test('external controller and unconfirmed connectors require review',()=>{
  const c=cooler();
  c.pumpConnectors=[{kind:'sata_power',count:1}];
  assert.equal(fit(board(),c,{liquid:true}).fit,'review');
  assert.equal(fit({},cooler()).fit,'review');
});
test('build fails closed when CPU fan connections are absent, even without a required rule',()=>{
  const rows=createBuildFixture().getBuildCandidates();
  delete rows.find(row=>row.category==='Кулеры для процессоров').component.facts.cpuCoolerSpecifications.value.fanConnectors;
  const result=buildPc({localData:{getBuildCandidates:()=>rows},city:'Алматы',budget:700000,cpu:'AMD',purpose:'Для игр'});
  assert.equal(result.ok,false);
  assert.equal(result.code,'needs_review');
  assert.match(result.reasons.join(' '),/разъёмов вентиляторов CPU/);
});
