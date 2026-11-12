'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildPc}=require('../tools/pc-builder.cjs');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
const run=(mode,budget=1000000,minVramGB=0)=>buildPc({localData:createBuildFixture(),city:'Алматы',
  purpose:'Для работы и творчества',cpu:'AMD',budget,partPreferences:{skus:{},
    workloadGpu:{mode,minVramGB,technology:null}}});
const gpu=result=>result.build.parts.find(p=>p.category==='Видеокарты');
test('creative GPU requirement depends on workload and persists even over budget',()=>{
  assert.equal(gpu(run('not_required')),undefined);
  assert.ok(gpu(run('required')));
  const tight=run('required',100000);
  assert.equal(tight.build.overBudget,true);
  assert.ok(gpu(tight));
  assert.match(gpu(run('required',1000000,12)).name,/5070/);
  assert.equal(run('required',1000000,24).ok,false);
});
test('preferred GPU is selected in budget and falls back with an explicit warning',()=>{
  assert.ok(gpu(run('preferred')));
  const fallback=run('preferred',260000);
  assert.equal(fallback.ok,true);
  assert.equal(gpu(fallback),undefined);
  assert.ok(fallback.build.warnings.some(w=>w.includes('не вошла в бюджет')));
});
