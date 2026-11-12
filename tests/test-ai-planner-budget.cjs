const test=require('node:test'),assert=require('node:assert/strict');
const {budgetMemory}=require('../tools/ai-planner-budget.cjs');
test('price ledger multiplies kits and retains cheaper alternatives without certifying them',()=>{
 const cards=Array.from({length:9},(_,i)=>({skuOver:String(i),category:'RAM',price:(i+1)*100,specifications:{memoryType:'DDR4'}}));
 const r=budgetMemory({budget:500},cards,[{skuOver:'2',quantity:2}]);
 assert.equal(r.proposal.total,600);assert.equal(r.proposal.overBudgetBy,100);
 assert.deepEqual(r.alternatives[0].items.map(i=>i.skuOver),['0','1','2','7','8']);
 assert.equal(r.alternatives[0].items[0].memoryType,'DDR4');assert.equal(r.ok,undefined);
});
test('unknown prices or invalid quantities cannot produce a complete proposal total',()=>{
 for(const part of [{skuOver:'unknown',quantity:1},{skuOver:'a',quantity:0},{skuOver:'a',quantity:1.5}]){
  const r=budgetMemory({budget:100},[{skuOver:'a',price:10}], [part]);
  assert.equal(r.proposal.completePrices,false);assert.equal(r.proposal.total,undefined);
 }
});
