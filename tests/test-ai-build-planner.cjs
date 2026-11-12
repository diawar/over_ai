const test=require('node:test'),assert=require('node:assert/strict');
const {createAiBuildPlanner}=require('../tools/ai-build-planner.cjs');
const catalog={snapshotId:'s',customerRequest:()=>({budget:100}),summary:()=>({total:1}),details:()=>({items:[{skuOver:'cpu'}]}),search:()=>({items:[],total:0}),validate:p=>({ok:p.snapshotId==='s',total:99})};
const action=(action,args)=>({action,arguments:JSON.stringify(args),explanation:'Проверка'});
test('review gives AI checked complete alternatives without selecting one for it',async()=>{
 const {compactPlannerInput}=require('../tools/ai-planner-context.cjs');let calls=0;
 const c={...catalog,details:({skus})=>({items:skus.map(skuOver=>({skuOver,category:'CPU'}))}),
  validate:({parts})=>({ok:true,total:parts[0].skuOver==='cheap'?70:99,parts:parts.map(p=>({...p,category:'CPU'})),warnings:['check USB']})};
 const p=createAiBuildPlanner({catalog:c,reviewFirstBuild:true,provider:async({input})=>{
  calls++;if(calls===1)return action('details',{skus:['cpu','cheap']});
  if(calls===2)return action('propose',{parts:[{skuOver:'cpu',quantity:1}]});
  const state=JSON.parse(compactPlannerInput(input)[1].content);
  assert.equal(state.qualityReview.validatedAlternatives[0].total,70);
  assert.deepEqual(state.qualityReview.validatedAlternatives[0].parts,[{skuOver:'cheap',quantity:1}]);
  assert.equal(state.qualityReview.baseline.total,99);return action('stop',{});
 }});const result=await p.run({requestId:'compare'});
 assert.equal(result.validation.total,99);assert.equal(result.qualityReviewDecision,'kept');
});
for(const [label,parts,decision] of [
 ['reordered',[{skuOver:'ram',quantity:1},{skuOver:'cpu',quantity:1}],'kept'],
 ['quantity changed',[{skuOver:'cpu',quantity:1},{skuOver:'ram',quantity:2}],'revised'],
 ['SKU changed',[{skuOver:'cpu2',quantity:1},{skuOver:'ram',quantity:1}],'revised'],
])test(`quality review reports ${label} composition accurately`,async()=>{
 const c={...catalog,details:({skus})=>({items:skus.map(skuOver=>({skuOver}))}),validate:({parts})=>({ok:true,total:99,parts})};
 const script=[action('details',{skus:['cpu','cpu2','ram']}),action('propose',{parts:[{skuOver:'cpu',quantity:1},{skuOver:'ram',quantity:1}]}),action('propose',{parts})];
 const result=await createAiBuildPlanner({catalog:c,reviewFirstBuild:true,provider:async()=>script.shift()}).run({requestId:label});
 assert.equal(result.qualityReviewDecision,decision);assert.equal(result.ok,true);
});
test('optional AI quality review keeps a validated baseline and revalidates replacements',async()=>{
 let calls=0;const p=createAiBuildPlanner({catalog,reviewFirstBuild:true,provider:async({input})=>{
  calls++;if(calls===1)return action('details',{skus:['cpu']});
  if(calls===2)return action('propose',{parts:[{skuOver:'cpu',quantity:1}]});
  assert.ok(input.some(t=>t.content.includes('qualityReview')));
  return action('stop',{});
 }});const result=await p.run({requestId:'review'});
 assert.equal(result.ok,true);assert.equal(result.qualityReviewDecision,'kept');assert.equal(result.validation.total,99);assert.equal(calls,3);
});
test('failed quality review cannot overwrite baseline or claim completion',async()=>{
 let calls=0;const p=createAiBuildPlanner({catalog,reviewFirstBuild:true,provider:async()=>{
  if(++calls===1)return action('details',{skus:['cpu']});
  if(calls===2)return action('propose',{parts:[{skuOver:'cpu',quantity:1}]});
  throw Error('ai_http_429');
 }});const result=await p.run({requestId:'review-failed'});
 assert.equal(result.ok,false);assert.equal(result.qualityReviewComplete,false);assert.equal(result.validatedFallback.total,99);
});
test('quality replacement must be inspected and validated, not automatically accepted',async()=>{
 let calls=0,validations=0;const c={...catalog,details:args=>({items:args.skus.map(skuOver=>({skuOver}))}),validate:()=>({ok:++validations===1,total:99,violations:[{code:'cooling_mismatch'}]})};
 const script=[action('details',{skus:['cpu']}),action('propose',{parts:[{skuOver:'cpu',quantity:1}]}),action('details',{skus:['new']}),action('propose',{parts:[{skuOver:'new',quantity:1}]}),action('stop',{})];
 const result=await createAiBuildPlanner({catalog:c,reviewFirstBuild:true,provider:async()=>script[calls++]}).run({requestId:'rejected-upgrade'});
 assert.equal(validations,2);assert.equal(result.ok,true);assert.equal(result.qualityReviewDecision,'kept');assert.equal(result.validation.total,99);
 assert.ok(result.trace.some(t=>t.codes?.includes('cooling_mismatch')));
});
test('repeated detail reads replace earlier copies before the raw context limit',async()=>{
 let calls=0;const c={...catalog,details:()=>({items:[{skuOver:'cpu',specifications:{raw:'x'.repeat(8000)}}]})};
 const p=createAiBuildPlanner({catalog:c,maxInputChars:14000,provider:async({input})=>{
  calls++;
  if(calls===1||calls===3)return action('details',{skus:['cpu']});
  if(calls===2)return action('search',{});
  const copies=input.filter(t=>t.role==='user').flatMap(t=>JSON.parse(t.content).result?.items||[]).filter(i=>i.skuOver==='cpu');
  assert.equal(copies.length,1);assert.equal(copies[0].specifications.raw.length,8000);
  return action('propose',{parts:[{skuOver:'cpu',quantity:1}]});
 }});
 assert.equal((await p.run({requestId:'dedup'})).ok,true);assert.equal(calls,4);
});
test('details precede proposal and repeated request does not charge again',async()=>{
 let calls=0;const p=createAiBuildPlanner({catalog,provider:async()=>++calls===1?action('details',{skus:['cpu']}):action('propose',{parts:[{skuOver:'cpu',quantity:1}]})});
 const a=p.run({requestId:'1'});assert.equal(a,p.run({requestId:'1'}));const r=await a;assert.equal(r.ok,true);assert.equal(calls,2);assert.equal(r.validation.total,99);await assert.rejects(p.run({requestId:'2'}));
});
test('uninspected proposal rejected with bounded corrections',async()=>{const p=createAiBuildPlanner({catalog,maxProposals:1,provider:async()=>action('propose',{parts:[{skuOver:'cpu'}]})});assert.equal((await p.run({requestId:'1'})).code,'proposal_limit');});
test('provider errors never retried',async()=>{let calls=0;const p=createAiBuildPlanner({catalog,provider:async()=>{calls++;throw Error('ai_http_429')}});const r=await p.run({requestId:'1'});assert.equal(calls,1);assert.equal(r.providerError,'ai_http_429');});
test('timeout ignores late provider answer',async()=>{const p=createAiBuildPlanner({catalog,timeoutMs:5,provider:()=>new Promise(resolve=>setTimeout(()=>resolve(action('stop',{})),30))});assert.equal((await p.run({requestId:'1'})).code,'timeout');});
test('cancel before start incurs no request',async()=>{const c=new AbortController();c.abort();const p=createAiBuildPlanner({catalog,provider:()=>assert.fail()});const r=await p.run({requestId:'1',signal:c.signal});assert.equal(r.calls,0);assert.equal(r.code,'cancelled');});
test('call limit bounds search loop',async()=>{let page=0;const p=createAiBuildPlanner({catalog,maxCalls:2,provider:async()=>action('search',{offset:page++})});assert.equal((await p.run({requestId:'1'})).code,'call_limit');});

test('batch queries compact results and old pages are not resent',async()=>{
 let calls=0;const p=createAiBuildPlanner({catalog,provider:async({input})=>{calls++;if(calls===1)return action('batch',{queries:[{limit:4},{limit:4}]});if(calls===2){assert.equal(JSON.parse(input.filter(t=>t.content.includes('"tool"')).at(-1).content).result.results.length,2);return action('details',{skus:['cpu']});}assert.match(input[2].content,/Previous page omitted/);return action('propose',{parts:[{skuOver:'cpu',quantity:1}]});}});assert.equal((await p.run({requestId:'batch'})).ok,true);
});
test('one invalid batch query does not discard successful searches',async()=>{let calls=0;const strict={...catalog,search:q=>{if(q.category==='bad')throw Error('invalid');return {total:1,items:[{skuOver:'cpu',name:'CPU',price:10,stock:1}]}}};const p=createAiBuildPlanner({catalog:strict,provider:async({input})=>{if(++calls===1)return action('batch',{queries:[{category:'bad'},{category:'good'}]});const r=JSON.parse(input.filter(t=>t.content.includes('"tool"')).at(-1).content).result.results;assert.equal(r[0].error,'invalid_catalog_query');assert.equal(r[1].result.total,1);return action('stop',{});}});assert.equal((await p.run({requestId:'mixed'})).code,'no_proposal');});

test('compact memory preserves exact candidates after a search page is omitted',async()=>{let calls=0;const c={...catalog,search:()=>({total:1,items:[{skuOver:'cpu',name:'Exact CPU',price:99,stock:2}]})};const p=createAiBuildPlanner({catalog:c,provider:async({input})=>{calls++;if(calls===1)return action('search',{});if(calls===2){const memory=JSON.parse(input.at(-1).content).previouslySeenCandidates;assert.deepEqual(memory.items,[['cpu','Exact CPU',99,2]]);return action('details',{skus:['cpu']});}assert.equal(JSON.parse(input.at(-1).content).result.items[0].skuOver,'cpu');assert.ok(input.some(t=>t.content.includes('Previous page omitted')));return action('propose',{parts:[{skuOver:'cpu',quantity:1}]});}});assert.equal((await p.run({requestId:'memory'})).ok,true);});

test('schema failure is corrected within the shared call budget',async()=>{let calls=0;const p=createAiBuildPlanner({catalog,maxCalls:3,provider:async()=>{if(++calls===1)throw Error('ai_invalid_response');return calls===2?action('details',{skus:['cpu']}):action('propose',{parts:[{skuOver:'cpu',quantity:1}]});}});const r=await p.run({requestId:'repair'});assert.equal(r.ok,true);assert.equal(r.calls,3);assert.equal(r.trace[0].action,'format_error');});
test('persistent malformed responses stop at call cap',async()=>{const p=createAiBuildPlanner({catalog,maxCalls:2,provider:async()=>{throw Error('ai_invalid_response')}});assert.equal((await p.run({requestId:'malformed'})).code,'call_limit');});

test('empty search diagnostic reaches the model through compact batch results',async()=>{
 let calls=0;const c={...catalog,search:()=>({total:0,items:[],hint:'Remove optional filters; old candidates are not matches.'})};
 const p=createAiBuildPlanner({catalog:c,provider:async({input})=>{
  if(++calls===1)return action('batch',{queries:[{}]});
  const response=JSON.parse(input.at(-1).content);
  assert.match(response.result.results[0].result.hint,/old candidates are not matches/);
  return action('stop',{});
 }});assert.equal((await p.run({requestId:'empty-hint'})).code,'no_proposal');
});

test('empty search evidence survives details and omission of old result pages',async()=>{
 let calls=0;const c={...catalog,search:()=>({total:0,items:[],outsidePriceRange:{count:5,minPrice:225324,maxPrice:400000},matchingPriceDistribution:{count:5,min:225324,median:300000,max:400000}})};
 const {compactPlannerInput}=require('../tools/ai-planner-context.cjs');
 const p=createAiBuildPlanner({catalog:c,provider:async({input})=>{
  if(++calls===1)return action('batch',{queries:[{category:'RAM',maxPrice:70000}]});
  if(calls===2)return action('details',{skus:['cpu']});
  const state=JSON.parse(compactPlannerInput(input)[1].content);
  assert.equal(state.lastResult.tool,'details');
  assert.equal(state.searchEvidence[0].query.maxPrice,70000);
  assert.equal(state.searchEvidence[0].outsidePriceRange.minPrice,225324);assert.equal(state.searchEvidence[0].matchingPriceDistribution.median,300000);
  return action('stop',{});
 }});assert.equal((await p.run({requestId:'persistent-search-evidence'})).code,'no_proposal');
});

test('batch caps pages transparently without dropping queries or skipping pagination',async()=>{
 let calls=0;const observed=[];const c={...catalog,search:q=>{observed.push(q);return {total:100,nextOffset:(q.offset||0)+q.limit,items:Array.from({length:q.limit},(_,i)=>({skuOver:q.category+i,name:'item',price:10,stock:1}))}}};
 const p=createAiBuildPlanner({catalog:c,provider:async({input})=>{
  if(++calls===1)return action('batch',{queries:Array.from({length:6},(_,i)=>({category:String(i),limit:12,offset:24}))});
  const results=JSON.parse(input.filter(t=>t.content.includes('"tool"')).at(-1).content).result.results;
  assert.equal(results.length,6);assert.equal(results.reduce((n,r)=>n+r.query.limit,0),48);
  for(const r of results){assert.equal(r.requestedLimit,12);assert.equal(r.query.limit,8);assert.equal(r.result.nextOffset,32);}
  return action('stop',{});
 }});assert.equal((await p.run({requestId:'capped-batch'})).code,'no_proposal');assert.equal(observed.length,6);
});




test('same consecutive tool command stops before paying for a third model response',async()=>{
 let calls=0;const p=createAiBuildPlanner({catalog,maxCalls:10,provider:async()=>{calls++;return action('batch',{queries:[calls===1?{limit:4,category:'CPU'}:{category:'CPU',limit:4}]});}});
 const result=await p.run({requestId:'repeat'});assert.equal(result.code,'no_progress');assert.equal(calls,2);
 assert.equal(result.trace.at(-1).error,'repeated_action');
});
test('optional explanation is charged once and failures preserve the validated build',async()=>{
 const c={...catalog,details:()=>({items:[{skuOver:'cpu',specifications:{cores:8}}]}),validate:p=>({ok:true,snapshotId:'s',parts:p.parts,total:99,warnings:[]})};
 for(const fail of [false,true]){
  let commands=0,reports=0;
  const planner=createAiBuildPlanner({catalog:c,provider:async()=>++commands===1?action('details',{skus:['cpu']}):action('propose',{parts:[{skuOver:'cpu',quantity:1}]}),explanationProvider:async()=>{reports++;if(fail)throw Error('provider down');return {summary:'Выбор.',reasons:[{text:'Ядра.',evidence:[{skuOver:'cpu',field:'specifications.cores'}]}],tradeoffs:[],alternatives:[],limitations:[]};}});
  const pending=planner.run({requestId:'report'});assert.equal(pending,planner.run({requestId:'report'}));const result=await pending;
  assert.equal(result.ok,true);assert.equal(result.validation.total,99);assert.equal(result.explanationComplete,!fail);assert.equal(reports,1);
 }
});
for(const cancelled of [false,true])test(`explanation ${cancelled?'cancellation':'deadline'} preserves build even when provider ignores abort`,async()=>{
 const c={...catalog,details:()=>({items:[{skuOver:'cpu',specifications:{cores:8}}]}),validate:p=>({ok:true,snapshotId:'s',parts:p.parts,total:99,warnings:[]})};
 let commands=0,reports=0;const controller=new AbortController();
 const planner=createAiBuildPlanner({catalog:c,explanationTimeoutMs:20,provider:async()=>++commands===1?action('details',{skus:['cpu']}):action('propose',{parts:[{skuOver:'cpu',quantity:1}]}),explanationProvider:async({onReceipt})=>{reports++;onReceipt('a'.repeat(64));if(cancelled)controller.abort();return new Promise(()=>{});}});
 const result=await planner.run({requestId:'deadline',signal:controller.signal});
 assert.equal(result.ok,true);assert.equal(result.validation.total,99);assert.equal(result.explanationComplete,false);assert.equal(reports,1);
 assert.equal(result.explanationError,cancelled?'explanation_cancelled':'explanation_timeout');
 assert.equal(result.explanationRequestId,'a'.repeat(64));
});

test('alternating search/detail loop warns then stops without exhausting paid call budget',async()=>{
 let calls=0,warned=false;
 const p=createAiBuildPlanner({catalog,maxCalls:16,provider:async({input})=>{
  calls++;const s=JSON.parse(require('../tools/ai-planner-context.cjs').compactPlannerInput(input)[1].content);
  if(s.progress?.stalled)warned=true;
  return calls%2?action('search',{category:'CPU'}):action('details',{skus:['cpu']});
 }});
 const result=await p.run({requestId:'alternating-loop'});
 assert.equal(result.code,'no_progress');assert.equal(calls,6);assert.equal(warned,true);
});
test('AI can recover after a stagnant cycle by proposing an inspected composition',async()=>{
 let calls=0;const p=createAiBuildPlanner({catalog,maxCalls:16,provider:async()=>{
  calls++;if(calls===5)return action('propose',{parts:[{skuOver:'cpu',quantity:1}]});
  return calls%2?action('search',{}):action('details',{skus:['cpu']});
 }});const r=await p.run({requestId:'recover-cycle'});assert.equal(r.ok,true);assert.equal(calls,5);
});

test('malformed proposal entries survive context compaction and AI can correct them',async()=>{
 let calls=0;
 const planner=createAiBuildPlanner({catalog,provider:async({input})=>{
  calls++;
  if(calls===1)return action('details',{skus:['cpu']});
  if(calls===2)return action('propose',{parts:[null]});
  const state=JSON.parse(require('../tools/ai-planner-context.cjs').compactPlannerInput(input)[1].content);
  assert.equal(state.lastValidation.violations[0].code,'inspect_selected_parts');
  assert.equal(state.budgetEvidence.proposal.completePrices,false);
  return action('propose',{parts:[{skuOver:'cpu',quantity:1}]});
 }});
 const result=await planner.run({requestId:'repair-null-part'});
 assert.equal(result.ok,true);assert.equal(result.calls,3);
});

test('quality review remaining budget respects a cheaper-build ceiling',async()=>{
 let calls=0;
 const capped={...catalog,customerRequest:()=>({budget:1000,partPreferences:{maxTotal:100}})};
 const planner=createAiBuildPlanner({catalog:capped,reviewFirstBuild:true,provider:async({input})=>{
  if(++calls===1)return action('details',{skus:['cpu']});
  if(calls===2)return action('propose',{parts:[{skuOver:'cpu',quantity:1}]});
  const state=JSON.parse(require('../tools/ai-planner-context.cjs').compactPlannerInput(input)[1].content);
  assert.equal(state.qualityReview.remainingBudget,1);
  assert.equal(state.budgetEvidence.budget,100);
  return action('stop',{});
 }});
 assert.equal((await planner.run({requestId:'review-effective-ceiling'})).ok,true);
});
