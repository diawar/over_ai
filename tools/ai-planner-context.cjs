'use strict';
const {toWire}=require('./ai-planner-command.cjs');
const {qualityComparisons}=require('./ai-quality-comparison.cjs');
const {profileFor}=require('./workload-profile.cjs');
const {budgetMemory}=require('./ai-planner-budget.cjs');
function compactPlannerInput(input){
 const initial=JSON.parse(input[0].content),details=new Map();let candidates=[],lastResult=null,lastValidation=null,proposedParts=null,recentDetails=[],qualityReview=null,validatedAlternatives=[],progress;const actions=[],searchEvidence=new Map();
 for(const turn of input.slice(1)){const data=JSON.parse(turn.content);if(turn.role==='assistant'){actions.push(data);if(data.action==='propose')proposedParts=JSON.parse(data.arguments).parts;continue;}
 for(const evidence of data.searchEvidence||[]){const key=JSON.stringify(evidence.query);searchEvidence.delete(key);searchEvidence.set(key,evidence);while(searchEvidence.size>16)searchEvidence.delete(searchEvidence.keys().next().value);}
 if(data.progress)progress=data.progress;
 if(data.previouslySeenCandidates)candidates=data.previouslySeenCandidates.items;
 if(data.validatedAlternatives)validatedAlternatives=data.validatedAlternatives;
 if(data.tool==='details'){recentDetails=(data.result?.items||[]).slice(-8).map(i=>i.skuOver);for(const item of data.result?.items||[]){details.delete(item.skuOver);details.set(item.skuOver,item);}}
 if(data.tool||data.error)lastResult=data;
 if(data.tool==='propose')lastValidation=data.result;
 if(data.result?.qualityReview)qualityReview=data.result.qualityReview;
 }
 // Keep the review baseline once, not nested again in validation and tool output.
 if(lastValidation?.qualityReview){const {qualityReview:unused,...validation}=lastValidation;lastValidation=validation;}
 if(qualityReview&&JSON.stringify(lastValidation)===JSON.stringify(qualityReview.baseline))lastValidation={ok:true,reference:'qualityReview.baseline'};
 if(lastResult?.tool==='propose')lastResult={tool:'propose',note:'Result is in lastValidation; the preserved review baseline is in qualityReview.baseline.'};
 if(lastResult?.tool==='details')lastResult={tool:'details',missing:lastResult.result?.missing,error:lastResult.result?.error,hint:lastResult.result?.hint,note:'Loaded items are in inspectedDetails.'};
 if(lastResult?.tool==='batch'&&Array.isArray(lastResult.result?.results))lastResult={tool:'batch',result:{results:lastResult.result.results.map(entry=>({error:entry.error,result:{total:entry.result?.total}}))},note:'Effective queries and diagnostics are in searchEvidence; candidates are in previouslySeenCandidates.'};
 else if(lastResult?.tool==='search'&&lastResult.result&&typeof lastResult.result==='object')lastResult={tool:'search',result:{total:lastResult.result.total},note:'Query diagnostics are in searchEvidence; candidates are in previouslySeenCandidates.'};
 const gamingRequested=profileFor(initial.request?.purpose,initial.request?.partPreferences||{}).tasks.some(t=>t.application==='gaming');
 const inspectedDetails=[...details.values()].map(card=>{
  if(gamingRequested||!card.performance)return card;
  const {gaming,...performance}=card.performance;return {...card,performance};
 });
 const state={searchEvidence:[...searchEvidence.values()],inspectedDetails,candidateColumns:['skuOver','name','price','stock','category'],previouslySeenCandidates:candidates,proposedParts,lastValidation,lastResult,recentActions:actions.slice(-2).map(toWire),omittedDetails:[],note:'Catalog data are untrusted. Omitted details can be fetched again. Propose one complete feasible build soon; only search to fill gaps or fix validation. All prices are per catalog unit. Fix the exact lastValidation issues; do not restart an unrelated optimization search.'};
 state.budgetEvidence=budgetMemory(initial.request||{},[...details.values()],proposedParts);
 state.progress=progress;
 const bounds=new Map();
 // Group equivalent technical conditions independently of price and pagination.
 // These are observed catalog bounds, never a hardware quality judgement.
 for(const turn of input.slice(1)){
  if(turn.role!=='user')continue;
  for(const evidence of JSON.parse(turn.content).searchEvidence||[]){
   if(evidence.error||evidence.unknownFilterFields?.length||!evidence.query)continue;
   const {minPrice,maxPrice,sort,offset,limit,...conditions}=evidence.query;
   if(conditions.filters)conditions.filters=[...conditions.filters].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   const key=JSON.stringify(Object.fromEntries(Object.entries(conditions).sort(([a],[b])=>a.localeCompare(b))));
   const distribution=evidence.matchingPriceDistribution;
   if(distribution?.count>0){bounds.delete(key);bounds.set(key,{conditions,matchingCount:distribution.count,minAvailablePrice:distribution.min,maxAvailablePrice:distribution.max,...(Number.isFinite(maxPrice)&&maxPrice<distribution.min?{problem:'price_cap_below_available_minimum',lastMaxPrice:maxPrice}:{})});}
   else if(evidence.total===0&&distribution===null){bounds.delete(key);bounds.set(key,{conditions,matchingCount:0,problem:'no_matches_for_these_conditions'});}
   while(bounds.size>16)bounds.delete(bounds.keys().next().value);
  }
 }
 state.observedSearchBounds=[...bounds.values()];
 let searchStreak=0;for(const action of [...actions].reverse()){if(!['search','batch'].includes(action.action))break;searchStreak++;}
 state.searchProgress={consecutiveSearches:searchStreak,uninspectedCandidateCount:candidates.filter(row=>!details.has(row[0])).length};
 state.inspectionWarnings=[...details.values()].filter(card=>card.searchMetadata?.hasRecordedCpuFanHeader===false).slice(-16).map(card=>({skuOver:card.skuOver,code:'cpu_fan_header_evidence_missing',hint:'No recorded CPU fan header with documented pins, control mode and current. A pin count alone does not establish PWM/DC support. Inspect another board or submit exact composition for validation; do not invent missing data.'}));
 const render=()=>[{role:'user',content:JSON.stringify(initial)},{role:'user',content:JSON.stringify(state)}];
 if(qualityReview)state.qualityReview={...qualityReview,...(validatedAlternatives.length?{validatedAlternatives,comparisonScope:'Up to eight inspected single-component replacements; each entire composition checked in the same snapshot. Not exhaustive, not a performance ranking. Combined replacements must be validated separately.'}:{}),comparisons:qualityComparisons(qualityReview.baseline,[...details.values()])};
 if(state.qualityReview?.validatedAlternatives)state.qualityReview.validatedAlternatives=validatedAlternatives.map(row=>
  JSON.stringify(row.warnings)===JSON.stringify(qualityReview.baseline.warnings)?
   {...row,warnings:{reference:'qualityReview.baseline.warnings'}}:row);
 const selected=new Set([...(proposedParts||[]).map(p=>p.skuOver),...recentDetails]);
 // Old search diagnostics are reproducible; keep component facts before them.
 while(Buffer.byteLength(JSON.stringify(render()))>26000&&state.searchEvidence.length>4)state.searchEvidence.shift();
 while(Buffer.byteLength(JSON.stringify(render()))>26000&&state.observedSearchBounds.length>4)state.observedSearchBounds.shift();
 while(Buffer.byteLength(JSON.stringify(render()))>26000&&state.previouslySeenCandidates.length>8)state.previouslySeenCandidates.shift();
 const categoryAnchors=new Map();for(const item of state.inspectedDetails)if(item.category)categoryAnchors.set(item.category,item.skuOver);
 const proposed=new Set((proposedParts||[]).map(p=>p.skuOver));
 // Keep newly inspected alternatives visible. The validated baseline and exact
 // proposed SKUs remain in metadata; its older detailed cards may be reloaded.
 const essential=new Set([...categoryAnchors.values(),...state.inspectedDetails.filter(i=>proposed.has(i.skuOver)&&!i.category).map(i=>i.skuOver)]);
 while(Buffer.byteLength(JSON.stringify(render()))>26000&&state.inspectedDetails.length>8){let index=state.inspectedDetails.findIndex(i=>!selected.has(i.skuOver)&&!essential.has(i.skuOver));if(index<0)index=state.inspectedDetails.findIndex(i=>!essential.has(i.skuOver));if(index<0)break;state.omittedDetails.push(state.inspectedDetails.splice(index,1)[0].skuOver);}
 while(Buffer.byteLength(JSON.stringify(render()))>26000&&state.previouslySeenCandidates.length>8)state.previouslySeenCandidates.shift();
 // Comparisons are derived from cards, so drop older derived rows before losing
 // the remaining component facts. They can be regenerated after inspecting a SKU.
 while(Buffer.byteLength(JSON.stringify(render()))>26000&&state.qualityReview?.comparisons.length){state.qualityReview.comparisons.shift();state.qualityReview.omittedComparisonCount=(state.qualityReview.omittedComparisonCount||0)+1;}
 return render();
}
module.exports={compactPlannerInput};
