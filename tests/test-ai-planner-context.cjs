const test=require('node:test'),assert=require('node:assert/strict');
const {compactPlannerInput}=require('../tools/ai-planner-context.cjs');
const t=data=>({role:'user',content:JSON.stringify(data)});
test('review keeps a changed validation instead of replacing it with baseline reference',()=>{
 const baseline={ok:true,total:90,parts:[{skuOver:'old'}],warnings:['old warning']};
 const changed={ok:true,total:95,parts:[{skuOver:'new'}],warnings:['new warning']};
 const state=JSON.parse(compactPlannerInput([t({request:{}}),t({tool:'propose',result:{...baseline,qualityReview:{baseline}}}),t({tool:'propose',result:changed})])[1].content);
 assert.deepEqual(state.lastValidation,changed);assert.deepEqual(state.qualityReview.baseline,baseline);
});
test('planner excludes gaming evidence only when no requested task is gaming',()=>{
 const card={skuOver:'cpu',performance:{gaming:{score:100},workload:{score:80,status:'partial'}}};
 for(const gaming of [false,true]){
  const request={purpose:'Для работы и творчества',partPreferences:{workloadProfile:{version:1,tasks:[{application:gaming?'gaming':'photoshop',operation:'interactive',priority:'primary',complexity:'unknown'}]}}};
  const state=JSON.parse(compactPlannerInput([t({request}),t({tool:'details',result:{items:[card]}})])[1].content);
  assert.equal(Object.hasOwn(state.inspectedDetails[0].performance,'gaming'),gaming);
  assert.deepEqual(state.inspectedDetails[0].performance.workload,card.performance.workload);
 }
 assert.deepEqual(card.performance.gaming,{score:100});
 const state=JSON.parse(compactPlannerInput([t({request:{purpose:'Для игр'}}),t({tool:'details',result:{items:[card]}})])[1].content);
 assert.deepEqual(state.inspectedDetails[0].performance.gaming,{score:100});
});
test('review alternatives are not discarded to keep every baseline detail card',()=>{
 const baseline=Array.from({length:8},(_,i)=>({skuOver:'old'+i,category:'c'+i,specifications:{raw:'x'.repeat(2200)}}));
 const alternatives=Array.from({length:7},(_,i)=>({skuOver:'new'+i,category:'c'+i,specifications:{raw:'y'.repeat(2200)}}));
 const parts=baseline.map(i=>({skuOver:i.skuOver,quantity:1}));
 const state=JSON.parse(compactPlannerInput([t({request:{}}),t({tool:'details',result:{items:baseline}}),{role:'assistant',content:JSON.stringify({action:'propose',arguments:JSON.stringify({parts})})},t({tool:'details',result:{items:alternatives}})])[1].content);
 for(const item of alternatives)assert.ok(state.inspectedDetails.some(i=>i.skuOver===item.skuOver));
 assert.deepEqual(state.proposedParts,parts);assert.equal(new Set(state.inspectedDetails.map(i=>i.category)).size,8);
});
test('quality baseline survives later search and rejected proposal',()=>{
 const qualityReview={baseline:{ok:true,total:90,parts:[{skuOver:'cpu'}]},remainingBudget:10};
 const state=JSON.parse(compactPlannerInput([t({request:{budget:100}}),t({tool:'propose',result:{ok:true,qualityReview}}),t({tool:'batch',result:{results:[]}}),t({tool:'propose',result:{ok:false}})])[1].content);
 assert.deepEqual(state.qualityReview,{...qualityReview,comparisons:[]});assert.equal(state.lastValidation.ok,false);
});
test('compaction preserves one inspected candidate in every category instead of alternating detail batches',()=>{
 const first=Array.from({length:8},(_,i)=>({skuOver:'a'+i,category:'category'+i,specifications:{raw:'x'.repeat(2200)}}));
 const later=Array.from({length:8},(_,i)=>({skuOver:'b'+i,category:'category'+(i%4),specifications:{raw:'y'.repeat(2200)}}));
 const state=JSON.parse(compactPlannerInput([t({request:{}}),t({tool:'details',result:{items:first}}),t({tool:'details',result:{items:later}})])[1].content);
 assert.equal(new Set(state.inspectedDetails.map(i=>i.category)).size,8);
 for(let i=4;i<8;i++)assert.ok(state.inspectedDetails.some(item=>item.skuOver==='a'+i));
 assert.ok(state.omittedDetails.length>0);
});
test('state retains exact details and latest validation, without duplicated dialogue',()=>{const input=[t({request:{budget:100},catalog:{total:20}}),t({tool:'details',result:{items:[{skuOver:'A',specifications:{tdpW:100},price:50}]}}),t({tool:'propose',result:{ok:false,violations:[{code:'budget_exceeded'}]}}),t({previouslySeenCandidates:{items:[['B','CPU',30,2]]}})];const out=compactPlannerInput(input);assert.equal(out.length,2);const state=JSON.parse(out[1].content);assert.equal(state.inspectedDetails[0].specifications.tdpW,100);assert.equal(state.lastValidation.violations[0].code,'budget_exceeded');assert.equal(state.previouslySeenCandidates[0][2],30);});
test('large state explicitly lists omitted details and keeps recent eight intact',()=>{const items=Array.from({length:20},(_,i)=>({skuOver:String(i),specifications:{raw:'x'.repeat(2200)}}));const out=compactPlannerInput([t({request:{}}),t({tool:'details',result:{items}})]);const s=JSON.parse(out[1].content);assert.ok(s.omittedDetails.length);assert.equal(s.inspectedDetails.at(-1).skuOver,'19');assert.ok(s.inspectedDetails.length>=8);assert.equal(s.inspectedDetails.at(-1).specifications.raw.length,2200);});
test('validation failures and selected parts survive later searches',()=>{const parts=[{skuOver:'A',quantity:1}];const state=JSON.parse(compactPlannerInput([t({request:{}}),{role:'assistant',content:JSON.stringify({action:'propose',arguments:JSON.stringify({parts})})},t({tool:'propose',result:{ok:false,violations:[{code:'cooling_mismatch'}]}}),t({tool:'batch',result:{results:[]}})])[1].content);assert.deepEqual(state.proposedParts,parts);assert.equal(state.lastValidation.violations[0].code,'cooling_mismatch');assert.equal(state.lastResult.tool,'batch');});
test('new search candidates survive compaction ahead of unused old details',()=>{const items=Array.from({length:20},(_,i)=>({skuOver:String(i),specifications:{raw:'x'.repeat(2200)}}));const parts=items.slice(0,8).map(i=>({skuOver:i.skuOver,quantity:1}));const candidates=Array.from({length:12},(_,i)=>['new'+i,'Cooler',100,1,'Кулеры для процессоров']);const input=[t({request:{}}),t({tool:'details',result:{items}}),{role:'assistant',content:JSON.stringify({action:'propose',arguments:JSON.stringify({parts})})},t({tool:'propose',result:{ok:false,violations:[{code:'cooling_mismatch'}]}}),t({previouslySeenCandidates:{items:candidates}})];const state=JSON.parse(compactPlannerInput(input)[1].content);assert.ok(state.previouslySeenCandidates.length>=8);for(const part of parts)assert.ok(state.inspectedDetails.some(i=>i.skuOver===part.skuOver));});


test('search evidence is bounded and repeated query keeps newest result',()=>{
 const entries=Array.from({length:20},(_,i)=>({query:{category:String(i)},total:0}));
 const state=JSON.parse(compactPlannerInput([t({request:{}}),t({searchEvidence:entries}),t({searchEvidence:[{query:{category:'19'},total:1}]})])[1].content);
 assert.equal(state.searchEvidence.length,16);assert.equal(state.searchEvidence.at(-1).total,1);
});

test('recent command examples use the same plain wire object as the response schema',()=>{
 const original={action:'search',arguments:JSON.stringify({category:'GPU',minPrice:0,filters:[]}),explanation:'unverified old prose'};
 const state=JSON.parse(compactPlannerInput([t({request:{}}),{role:'assistant',content:JSON.stringify(original)}])[1].content);
 assert.deepEqual(state.recentActions,[{action:'batch',queries:[{category:'GPU',minPrice:0,filters:[]}],skus:[],parts:[]}]);
 assert.equal(state.recentActions[0].arguments,undefined);assert.equal(state.recentActions[0].explanation,undefined);
});


test('review baseline is not duplicated inside validation and last tool result',()=>{
 const baseline={ok:true,total:90,parts:[{skuOver:'cpu',category:'CPU',price:90,quantity:1}],warnings:['retain warning']};
 const qualityReview={baseline,remainingBudget:10};
 const state=JSON.parse(compactPlannerInput([t({request:{budget:100}}),t({tool:'propose',result:{...baseline,qualityReview}})])[1].content);
 assert.deepEqual(state.qualityReview.baseline,baseline);
  assert.deepEqual(state.lastValidation,{ok:true,reference:'qualityReview.baseline'});
 assert.equal(state.lastValidation.qualityReview,undefined);
 assert.equal(state.lastResult.result,undefined);
 assert.equal(state.lastResult.tool,'propose');
});

test('complete comparison keeps failures and distinct warnings while deduplicating identical ones',()=>{
 const baseline={ok:true,total:100,parts:[{skuOver:'old'}],warnings:['USB unknown']};
 const rows=[{alternativeSku:'cheap',parts:[{skuOver:'cheap',quantity:1}],ok:true,total:80,warnings:['USB unknown']},
  {alternativeSku:'bad',parts:[{skuOver:'bad',quantity:1}],ok:false,total:120,violations:[{code:'budget_exceeded'}],warnings:['different warning']}];
 const input=[t({request:{budget:100}}),t({tool:'propose',result:{...baseline,qualityReview:{baseline}}}),t({validatedAlternatives:rows})];
 const before=JSON.stringify(input),state=JSON.parse(compactPlannerInput(input)[1].content);
 assert.deepEqual(state.qualityReview.validatedAlternatives[0].warnings,{reference:'qualityReview.baseline.warnings'});
 assert.deepEqual(state.qualityReview.validatedAlternatives[1],rows[1]);
 assert.deepEqual(state.qualityReview.validatedAlternatives[0].parts,rows[0].parts);
 assert.equal(JSON.stringify(input),before);
});
test('oversized derived comparisons yield to baseline and inspected component facts',()=>{
 const parts=Array.from({length:8},(_,i)=>({skuOver:'old'+i,category:'c'+i,quantity:1,price:10}));
 const items=parts.map(p=>({...p,specifications:{feature:'a'.repeat(1800)}})).concat(parts.map((p,i)=>({...p,skuOver:'new'+i,specifications:{feature:'b'.repeat(1800)}})));
 const baseline={ok:true,total:80,parts};
 const out=compactPlannerInput([t({request:{budget:100}}),t({tool:'details',result:{items}}),t({tool:'propose',result:{...baseline,qualityReview:{baseline,remainingBudget:20}}})]);
 const state=JSON.parse(out[1].content);
 assert.ok(state.qualityReview.omittedComparisonCount>0);
 assert.deepEqual(state.qualityReview.baseline,baseline);
 assert.equal(new Set(state.inspectedDetails.map(i=>i.category)).size,8);
 assert.ok(Buffer.byteLength(JSON.stringify(out))<=26000);
});
test('observed bounds survive price changes and history compaction without changing technical conditions',()=>{
 const filters=[{field:'capacityGB',op:'gte',value:8},{field:'memoryType',op:'eq',value:'DDR4'}];
 const first={query:{category:'RAM',maxPrice:18000,limit:4,filters},total:0,matchingPriceDistribution:{count:63,min:28458,max:367272}};
 const later={...first,query:{filters:[...filters].reverse(),category:'RAM',maxPrice:28000,offset:12,limit:8,sort:'price_asc'}};
 const input=[t({request:{}}),t({searchEvidence:[first,later]})],before=JSON.stringify(input);
 const state=JSON.parse(compactPlannerInput(input)[1].content);
 assert.equal(state.observedSearchBounds.length,1);
 assert.equal(state.observedSearchBounds[0].minAvailablePrice,28458);
 assert.equal(state.observedSearchBounds[0].lastMaxPrice,28000);
 assert.equal(state.observedSearchBounds[0].problem,'price_cap_below_available_minimum');
 assert.equal(state.observedSearchBounds[0].conditions.maxPrice,undefined);
 assert.equal(JSON.stringify(input),before);
});
test('unknown fields and failed queries never establish absence of products',()=>{
 const base={query:{category:'CPU',filters:[]},total:0,matchingPriceDistribution:null};
 const state=JSON.parse(compactPlannerInput([t({request:{}}),t({searchEvidence:[{...base,unknownFilterFields:['bad']},{...base,error:'invalid_catalog_query'}]})])[1].content);
 assert.deepEqual(state.observedSearchBounds,[]);
 const observed=JSON.parse(compactPlannerInput([t({request:{}}),t({searchEvidence:[base]})])[1].content);
 assert.equal(observed.observedSearchBounds[0].problem,'no_matches_for_these_conditions');
});
test('connection evidence warnings survive omitted cards and never certify complete compatibility',()=>{
 const items=Array.from({length:16},(_,i)=>({skuOver:String(i),category:'boards',searchMetadata:{hasRecordedCpuFanHeader:i!==0},specifications:{raw:'x'.repeat(3000)}}));
 const state=JSON.parse(compactPlannerInput([t({request:{}}),t({tool:'details',result:{items}})])[1].content);
 assert.deepEqual(state.inspectionWarnings.map(w=>w.skuOver),['0']);
 assert.ok(state.omittedDetails.includes('0'));
 assert.equal(state.inspectionWarnings[0].code,'cpu_fan_header_evidence_missing');
});
test('last batch does not duplicate candidate rows or query diagnostics',()=>{
 const evidence={query:{category:'RAM',maxPrice:10},total:0,outsidePriceRange:{count:2,minPrice:20,maxPrice:30}};
 const state=JSON.parse(compactPlannerInput([t({request:{}}),t({tool:'batch',result:{results:[{query:evidence.query,result:{total:0,items:[{skuOver:'a'}],outsidePriceRange:evidence.outsidePriceRange}},{query:{category:'CPU'},error:'invalid_catalog_query'}]},searchEvidence:[evidence]}),t({previouslySeenCandidates:{items:[['a','RAM',20,1,'RAM']]}})])[1].content);
 assert.equal(state.lastResult.result.results[0].result.total,0);
 assert.equal(state.lastResult.result.results[0].result.items,undefined);
 assert.equal(state.lastResult.result.results[1].error,'invalid_catalog_query');
 assert.equal(state.searchEvidence[0].outsidePriceRange.minPrice,20);
 assert.equal(state.previouslySeenCandidates[0][0],'a');
});
test('search phase counts only consecutive search commands and excludes already inspected candidates',()=>{
 const assistant=data=>({role:'assistant',content:JSON.stringify({action:data,arguments:'{}'})});
 const input=[t({request:{}}),t({tool:'details',result:{items:[{skuOver:'old'}]}}),assistant('details'),assistant('batch'),assistant('search'),t({previouslySeenCandidates:{items:[['old'],['new']]}})];
 const state=JSON.parse(compactPlannerInput(input)[1].content);
 assert.deepEqual(state.searchProgress,{consecutiveSearches:2,uninspectedCandidateCount:1});
 const reset=JSON.parse(compactPlannerInput([...input,assistant('details')])[1].content);
 assert.equal(reset.searchProgress.consecutiveSearches,0);
});

test('budget facts survive detail compaction and progress survives result rewriting',()=>{
 const cards=Array.from({length:20},(_,i)=>({skuOver:String(i),category:'RAM',price:100+i,specifications:{raw:'x'.repeat(2200)}}));
 const out=compactPlannerInput([t({request:{budget:200}}),t({tool:'details',result:{items:cards},progress:{stagnantSteps:2,stalled:true}}),{role:'assistant',content:JSON.stringify({action:'propose',arguments:JSON.stringify({parts:[{skuOver:'0',quantity:2}]})})}]);
 const s=JSON.parse(out[1].content);assert.equal(s.budgetEvidence.proposal.total,200);
 assert.ok(s.budgetEvidence.alternatives[0].items.some(i=>i.skuOver==='0'));
 assert.equal(s.progress.stalled,true);assert.ok(s.omittedDetails.length>0);
});
