'use strict';
const crypto=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const command=require('./ai-planner-command.cjs');
const {compactPlannerInput}=require('./ai-planner-context.cjs');
const {createPlannerCooldown}=require('./planner-cooldown.cjs');
function signedHeaders(secret,organizationId,body){
  const timestamp=String(Math.floor(Date.now()/1000));
  const digest=crypto.createHash('sha256').update(body).digest('hex');
  return {'X-CoreLab-AI-Timestamp':timestamp,'X-CoreLab-AI-Auth':crypto.createHmac('sha256',secret).update(`${timestamp}:${organizationId}:${digest}`).digest('hex')};
}
async function awaitExplanation({organizationId,requestId,fetcher,signal,receipt}){
  if(!/^[a-f0-9]{64}$/.test(requestId))throw Error('invalid_explanation_id');
  const base=process.env.CORELAB_INTERNAL_API,secret=process.env.SESSION_SECRET;
  if(!base||!secret)throw Error('ai_not_configured');
  signal=signal||AbortSignal.timeout(180000);
  try{
    for(;;){
      signal.throwIfAborted();
      if(receipt){
        if(receipt.request_id!==requestId)throw Error('ai_invalid_response');
        if(receipt.status==='completed')return receipt.result;
        if(receipt.status==='failed')throw Error(/^(ai_http_\d{3}|ai_invalid_response|ai_explanation_(failed|expired|interrupted))$/.test(receipt.error)?receipt.error:'ai_explanation_failed');
        if(receipt.status!=='running')throw Error('ai_invalid_response');
        await delay(1000,undefined,{signal});
      }
      const response=await fetcher(`${base}/api/v1/internal/ai/explanations/${requestId}?organization_id=${organizationId}`,{
        signal,redirect:'error',headers:signedHeaders(secret,organizationId,`explanation:${requestId}`)});
      if(!response.ok)throw Error(`ai_http_${response.status}`);
      receipt=await response.json();
    }
  }catch(error){error.requestId=requestId;throw error;}
}
// Uses the existing internal provider selection; never reads/logs provider keys.
function createPlannerProvider({organizationId,fetcher=fetch,minIntervalMs=0,structuredCommands=false,reasoningMode='off',explanationMode=false,openaiEffort='medium',cooldownStore=fetcher===fetch?createPlannerCooldown():null}){
  if(!['medium','low'].includes(openaiEffort)||openaiEffort==='low'&&!structuredCommands)throw Error('invalid_openai_effort');
  if(explanationMode&&structuredCommands)throw Error('invalid_explanation_mode');
  if(!['off','adaptive','on'].includes(reasoningMode))throw Error('invalid_reasoning_mode');
  if(!Number.isSafeInteger(organizationId)||organizationId<1)throw Error('invalid_organization');
  if(!Number.isFinite(minIntervalMs)||minIntervalMs<0||minIntervalMs>60000)throw Error('invalid_interval');
  let nextStart=0;
  const perform=async ({instructions,schema,input,signal,onReceipt})=>{
    let provider;
    if(fetcher===fetch&&cooldownStore){
      const base=process.env.CORELAB_INTERNAL_API,secret=process.env.SESSION_SECRET;
      if(!base||!secret)throw Error('ai_not_configured');
      const timestamp=String(Math.floor(Date.now()/1000));
      const digest=crypto.createHash('sha256').update('').digest('hex');
      const signature=crypto.createHmac('sha256',secret).update(`${timestamp}:${organizationId}:${digest}`).digest('hex');
      const status=await fetcher(`${base}/api/v1/internal/ai/status?organization_id=${organizationId}`,{signal,redirect:'error',headers:{'X-CoreLab-AI-Timestamp':timestamp,'X-CoreLab-AI-Auth':signature}});
      if(!status.ok)throw Error(`ai_http_${status.status}`);
      const data=await status.json();
      if(!data.ready||!['openai','kimi','openrouter'].includes(data.provider))throw Error('ai_not_configured');
      provider=data.provider;
    }
    if(cooldownStore?.remainingMs(organizationId,provider)>0)throw Error('ai_cooldown');
    let reasoning=false;
    if(structuredCommands){
      input=compactPlannerInput(input);
      const state=JSON.parse(input[1].content),categories=new Set(state.inspectedDetails.map(i=>i.category));
      const lastSearchFound=state.lastResult?.tool==='search'?state.lastResult.result?.total>0:
        state.lastResult?.tool==='batch'&&state.lastResult.result?.results?.some(entry=>entry.result?.total>0);
      reasoning=reasoningMode==='on'||reasoningMode==='adaptive'&&state.inspectedDetails.length>=6;
      instructions=command.instructions;schema=structuredClone(command.schema);
      instructions+='\nBUDGET MEMORY: budgetEvidence retains inspected unit/kit prices even when full cards were omitted, plus exact arithmetic for your last proposed quantities. Use its price ledger to plan the complete total before further searches. These are observed alternatives, not server recommendations or proof of compatibility. Do not mistake an old expensive proposal for a fixed allocation. If it exceeds budget, change the allocation or optional search constraints; do not repeat it. progress.stalled means repeated tools produced no new information: inspect a new option, change a meaningful constraint, or propose a complete inspected composition for validation.';
      instructions+='\nCONNECTION EVIDENCE: Before choosing a motherboard, inspect its recorded CPU cooling connections as well as socket/chipset. The catalog filter hasRecordedCpuFanHeader eq true locates boards with recorded pins, control and current; it does not certify the full build. inspectionWarnings lists inspected boards missing this evidence, even when their detailed card was omitted. Do not repeatedly choose a flagged board expecting a different cooler to fill missing board data. Unknown does not mean physically incompatible; prefer a documented alternative when feasible and validate the exact composition. Never invent or modify connector data.';
      if(state.observedSearchBounds?.some(b=>b.problem))instructions+='\nSEARCH MEMORY: observedSearchBounds groups prior searches by the same technical conditions, independent of price caps and pagination. minAvailablePrice is observed before the price cap. Repeating a lower cap cannot reveal a cheaper matching part in this immutable snapshot. Choose a feasible price range, change an optional technical condition, or allocate budget across another platform. matchingCount=0 applies ONLY to the listed conditions, not the entire category. Never infer compatibility or performance from these bounds. Inspect promising candidates and submit a complete provisional composition for validation rather than repeatedly searching the same impossible allocations. A partial supportedCpuSeries list is not exhaustive: do not require that text in motherboard searches unless explicitly requested by the customer; socket/chipset compatibility is validated by the server.';
      if(state.qualityReview)instructions+='\nQUALITY REVIEW: A compatible baseline has been validated and preserved in qualityReview.baseline. Compare useful improvements for the actual requested tasks within the original total budget. Search and inspect concrete alternatives, considering CPU/GPU evidence, RAM capacity, speed and CAS latency, supported XMP/EXPO profiles, storage, cooling and balanced case/PSU choices. Spend only for a justified benefit; price alone proves no quality. Do not weaken compatibility or invent performance. Return propose with the complete revised composition for validation, or stop to retain the baseline if no justified improvement was found. This review shares the remaining call budget.';
      if(structuredCommands==='kimi')schema.properties.queries.items.required=[];
      if(state.qualityReview?.validatedAlternatives?.length)instructions+='\nVALIDATED ALTERNATIVES: qualityReview.validatedAlternatives contains server-checked COMPLETE compositions for inspected single replacements, with exact totals, failures and warnings. Compare feasible cheaper compositions against the baseline before keeping a premium component. A missing application benchmark is not evidence that a motherboard is slower; examine the recorded functional differences and actual customer needs without inventing a Wi-Fi, port or size requirement. Passing compatibility alone is not evidence of equal performance or suitability. Do not automatically choose the cheapest. Failed compositions are not available choices; changing multiple parts requires a new full validation. Prefer a supplied feasible alternative if the premium has no justified benefit, or keep the baseline if its recorded benefit matters to the request. Submit the complete chosen composition with propose; do not claim optimality from this limited sample.';
      if(state.qualityReview)instructions+='\nWHOLE-BUILD REVIEW: The effective total ceiling is budgetEvidence.budget = min(request.budget, request.partPreferences.maxTotal when present); preserve this ceiling during every replacement. The original customer budget alone does not override a cheaper-build request for reallocating across components; remainingBudget is NOT a cap on an alternative component. Before deciding to keep the baseline, investigate a materially different allocation appropriate to the requested workloads, using recorded evidence. For example, a less expensive CPU/platform may fund a more suitable GPU, or GPU savings may fund CPU/RAM for CPU-heavy tasks. Neither direction is mandatory: compare actual workload tradeoffs, including VRAM, supported software technologies, and preserved user requirements. Search paired alternatives in one batch where possible, inspect them, and compare complete totals including affected motherboard, cooling and PSU costs. Do not restrict searches to components priced at baseline component price plus remainingBudget or assume a higher model number is better. Retain the baseline when alternatives lack evidence of worthwhile benefit or cannot meet constraints; do not force a change or exceed the call budget. Single-component comparisons do not prove whole-build optimality.';
      if(state.qualityReview)instructions+='\nMARGINAL VALUE: qualityReview.comparisons gives server-calculated price differences and recorded specification changes, NOT recommendations. Compare extraCost against the concrete benefit for the requested workload and the baseline, including tradeoffs. A higher memory data rate with unchanged capacity and worse calculated CAS delay is not an unconditional upgrade. Profiles require board support; unknown support is not evidence. Do not claim an FPS gain without measured evidence. Do not spend the remainder merely because it fits. If the benefit is weak, uncertain or disproportionate to the premium, retain the validated baseline with stop; a lower total is acceptable. Consider useful improvements to the whole build, but do not replace components solely to raise spending.';
      const request=JSON.parse(input[0].content).request;
      const gpuRequired=request?.purpose==='Для игр'||request?.partPreferences?.workloadGpu?.mode==='required';
      const ready=(!gpuRequired||categories.has('Видеокарты'))&&['Процессоры','Материнские платы','Оперативная память','Твердотельные диски (SSD)','Блоки питания','Корпуса'].every(c=>categories.has(c))&&(categories.has('Кулеры для процессоров')||categories.has('Системы водяного / жидкостного охлаждения (СЖО)'));
      if(ready&&state.lastResult?.tool==='details'&&state.lastValidation?.ok!==false){
        instructions+='\nCURRENT PHASE: You have inspected candidates in all core categories. Prefer a complete provisional proposal using inspected SKUs if feasible. Check the sum against budget. Coverage of all categories does not mean these candidates form a compatible affordable build. If they do not, use a targeted search or inspect an alternative for the specific gap. All search and detail tools remain available. Include a GPU for required GPU workloads. Do not stop merely because the currently inspected combination is unsuitable; distinguish it from an exhausted catalog.';
      }else if(!state.inspectedDetails.length&&state.previouslySeenCandidates.length>=8&&(!state.lastResult||lastSearchFound)||state.lastValidation?.ok===false&&lastSearchFound){
        schema.properties.action.enum=['details','stop'];
        instructions+='\nCURRENT PHASE: Candidates were found. Inspect up to 8 promising SKUs, preferably one per required component category, before further searching. Do not repeat searches before checking these candidates. Read their prices and choose a sensible provisional combination within the total budget.';
      }
      if(lastSearchFound&&state.searchProgress?.consecutiveSearches>=2&&state.searchProgress.uninspectedCandidateCount>0){
        schema.properties.action.enum=['details','propose','stop'];
        instructions+='\nINSPECTION PHASE: At least two consecutive searches were made. The latest search returned products, and uninspected candidates remain in memory. Inspect promising candidates before another search, or propose an already inspected complete composition for validation. The next response cannot be another batch. No SKU is automatically selected; stop only when there is no justified way to continue, not merely because one page or allocation was unsuitable. Search remains available after inspection and when searches are empty.';
      }
    }
    const base=process.env.CORELAB_INTERNAL_API,secret=process.env.SESSION_SECRET;
    if(!base||!secret)throw Error('ai_not_configured');
    const turns=input.flatMap(turn=>{const chunks=[];for(let i=0;i<turn.content.length;i+=9000)chunks.push({role:turn.role,content:turn.content.slice(i,i+9000)});return chunks;});
    const explanationId=explanationMode?crypto.createHash('sha256').update(JSON.stringify({instructions,input:turns,schema})).digest('hex'):null;
    const body=JSON.stringify({instructions,input:turns,schema,...(provider?{expected_provider:provider}:{}),...(explanationMode?{mode:'explanation',request_id:explanationId}:structuredCommands?{mode:openaiEffort==='low'?'planner_fast':reasoning?'planner':'dialogue'}:{})});
    if(Buffer.byteLength(body)>40000||turns.length>61)throw Error('ai_context_limit');
    if(explanationId)onReceipt?.(explanationId);
    const wait=Math.max(0,nextStart-Date.now());nextStart=Date.now()+wait+minIntervalMs;
    if(wait)await delay(wait,undefined,{signal});
    signal?.throwIfAborted();
    if(cooldownStore?.remainingMs(organizationId,provider)>0)throw Error('ai_cooldown');
    const timestamp=String(Math.floor(Date.now()/1000));
    const digest=crypto.createHash('sha256').update(body).digest('hex');
    const signature=crypto.createHmac('sha256',secret).update(`${timestamp}:${organizationId}:${digest}`).digest('hex');
    const response=await fetcher(`${base}/api/v1/internal/ai/dialogue?organization_id=${organizationId}`,{
      method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json','X-CoreLab-AI-Timestamp':timestamp,'X-CoreLab-AI-Auth':signature},body});
    if(!response.ok){
      if(response.status===429){
        const retry=response.headers?.get('Retry-After');
        if(typeof retry==='string'&&/^[0-9]{1,5}$/.test(retry)&&Number(retry)<=86400)cooldownStore?.defer(organizationId,Number(retry),provider);
      }
      let error;try{error=await response.json();}catch{}
      if(error?.detail?.code==='ai_invalid_response')throw Error('ai_invalid_response');
      throw Error(`ai_http_${response.status}`);
    }
    const data=await response.json();
    if(explanationMode)return awaitExplanation({organizationId,requestId:explanationId,fetcher,signal,receipt:data});
    return structuredCommands?command.decode(data):data;
  };
  // Reading an existing receipt never starts a generation, even after provider switch.
  perform.resumeExplanation=({requestId,signal})=>awaitExplanation({organizationId,requestId,fetcher,signal});
  return perform;
}
module.exports={createPlannerProvider};
