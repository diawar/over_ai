const test=require('node:test'),assert=require('node:assert/strict');
const {qualityComparisons}=require('../tools/ai-quality-comparison.cjs');
const {validatedQualityAlternatives}=require('../tools/ai-quality-comparison.cjs');

test('full alternatives preserve every quantity, validate failures and cache without choosing',()=>{
 const baseline={total:100,parts:[{category:'board',skuOver:'old',quantity:1},{category:'ram',skuOver:'kit',quantity:2}]};
 const cards=[{category:'board',skuOver:'cheap'},{category:'board',skuOver:'bad'},{category:'gpu',skuOver:'extra'},{category:'board',skuOver:'unread',detailsUnavailable:true}];
 const before=JSON.stringify({baseline,cards}),calls=[];
 const catalog={snapshotId:'s',validate:query=>{calls.push(query);return {ok:query.parts[0].skuOver==='cheap',total:80,warnings:['USB unknown'],violations:query.parts[0].skuOver==='bad'?[{code:'socket'}]:[]};}};
 const cache=new Map();const results=validatedQualityAlternatives(catalog,baseline,cards,cache);
 assert.equal(results.length,2);assert.equal(calls.length,2);
 assert.deepEqual(results[0].parts,[{skuOver:'cheap',quantity:1},{skuOver:'kit',quantity:2}]);
 assert.equal(results[0].priceDifference,-20);assert.equal(results[0].ok,true);
 assert.equal(results[1].ok,false);assert.equal(results[1].violations[0].code,'socket');
 assert.equal(calls[0].snapshotId,'s');results[0].warnings.length=0;
 assert.deepEqual(validatedQualityAlternatives(catalog,baseline,cards,cache)[0].warnings,['USB unknown']);
 assert.equal(calls.length,2);assert.equal(JSON.stringify({baseline,cards}),before);
});

test('full comparison sample is bounded and a different snapshot is revalidated',()=>{
 let calls=0;const baseline={total:10,parts:[{skuOver:'old',category:'board',quantity:1}]};
 const cards=Array.from({length:30},(_,i)=>({skuOver:String(i),category:'board'}));
 const catalog={snapshotId:'s',validate:()=>{calls++;return {ok:false,unknowns:[{code:'missing'}]};}},cache=new Map();
 const results=validatedQualityAlternatives(catalog,baseline,cards,cache);
 assert.equal(results.length,8);assert.equal(results[0].alternativeSku,'22');assert.equal(results[0].total,null);assert.equal(results[0].priceDifference,null);
 validatedQualityAlternatives({...catalog,snapshotId:'other'},baseline,cards,cache);assert.equal(calls,16);
});
test('RAM comparison exposes premium and latency tradeoff without scoring performance',()=>{
 const baseline={total:452390,parts:[{category:'Оперативная память',skuOver:'old',price:29658,quantity:1}]};
 const comparisons=qualityComparisons(baseline,[{skuOver:'old',category:'Оперативная память',price:29658,specifications:{capacityGB:16,speedMTs:2400,timings:'15',profiles:[]}},{skuOver:'new',category:'Оперативная память',price:71641,specifications:{capacityGB:16,speedMTs:3200,timings:'22',profiles:[]}}]);
 const c=comparisons[0];assert.equal(c.extraCost,41983);assert.equal(c.totalWithReplacement,494373);assert.equal(c.memory.before.casLatencyNs,12.5);assert.equal(c.memory.after.casLatencyNs,13.75);assert.equal(c.priceIncreasePercent,141.6);assert.equal(c.score,undefined);
});
test('missing baseline facts remain unknown and quantity affects premium',()=>{
 const c=qualityComparisons({total:100,parts:[{category:'Оперативная память',skuOver:'old',price:20,quantity:2}]},[{category:'Оперативная память',skuOver:'new',price:20,specifications:{speedMTs:3200}}])[0];
 assert.equal(c.extraCost,20);assert.equal(c.baselineDetailsAvailable,false);assert.equal(c.memory.before.casLatencyNs,null);assert.equal(c.memory.after.casLatencyNs,null);
});
