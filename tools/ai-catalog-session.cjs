'use strict';
// Experimental, server-owned session. The model cannot supply tenant or branch.
const {createExactBuildValidator}=require('./exact-build-validator.cjs');
const {CATEGORY_FACT}=require('./pc-builder.cjs');
const {profileFor,assessWorkload}=require('./workload-profile.cjs');
const {cpuModel}=require('./model-identity.cjs');
const {cpuEvidence,gpuEvidence}=require('./performance-evidence.cjs');
const cohorts=require('./performance-models.json').workloadObservations;
const {validatePartPreferences}=require('./part-preferences.cjs');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const clean=v=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,512);
// Observed prices, not performance tiers or recommended allocations.
function priceStats(items){
  const prices=items.map(r=>r.offer.price).sort((a,b)=>a-b);
  if(!prices.length)return null;
  const at=p=>prices[Math.floor((prices.length-1)*p)];
  return {count:prices.length,min:prices[0],p25:at(.25),median:at(.5),p75:at(.75),max:prices.at(-1)};
}
function keys(value,allowed){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('invalid_catalog_query');}
function createAiCatalogSession({localData,organizationId,city,pickupBranch,request}){
  if(!Number.isSafeInteger(organizationId)||organizationId<1||typeof city!=='string'||!city.trim())throw Error('invalid_scope');
  const branches=localData.getBranches?structuredClone(localData.getBranches(city)):null;
  if(branches&&!branches.some(b=>b.code===pickupBranch))throw Error('exact_destination_required');
  // Capture once. Search, details and validation must see the exact same offers.
  const rows=structuredClone(localData.getBuildCandidates(city,pickupBranch));
  const rules=structuredClone(localData.getRules?.()||[]),operations=structuredClone(localData.getOperations?.()||{});
  const rulesVersion=localData.getRulesVersion?.()||null;
  request=structuredClone(request);
  const snapshotData={getBuildCandidates:()=>rows,getRules:()=>rules,getOperations:()=>operations,getRulesVersion:()=>rulesVersion,
    ...(branches?{getBranches:()=>branches}:{})};
  const validator=createExactBuildValidator({localData:snapshotData,organizationId,city,pickupBranch,request});
  const profile=profileFor(request.purpose,validatePartPreferences(request.partPreferences));
  const eligible=rows.filter(r=>Object.hasOwn(CATEGORY_FACT,r.category)&&Number.isFinite(r.offer?.price)&&r.offer.price>0&&
    Number.isSafeInteger(r.offer.quantity)&&r.offer.quantity>0);
  const bySku=new Map(eligible.map(r=>[r.skuOver,r]));
  const context={snapshotId:validator.snapshotId,organizationId,city,pickupBranch,rulesVersion,
    catalogTextIsUntrustedData:true,pricesArePerCatalogUnit:true};
  const spec=r=>r.component?.facts?.[CATEGORY_FACT[r.category]]?.value||{};
  // Search metadata only: recorded header evidence is not a compatibility verdict.
  const searchableSpec=r=>{
    const s=spec(r);
    if(r.category==='Блоки питания'){
      const cables=kind=>{
        if(!Array.isArray(s.pcieConnectors)||!s.pcieConnectors.length||s.pcieConnectors.some(row=>!row||typeof row!=='object'))return null;
        const rows=s.pcieConnectors.filter(row=>row.kind===kind);
        if(!rows.length||rows.some(row=>!Number.isInteger(row.cables)||row.cables<0))return null;
        return rows.reduce((sum,row)=>sum+row.cables,0);
      };
      return {...s,recordedPcie8CableCount:cables('pcie_8'),recordedPcie16CableCount:cables('pcie_16')};
    }
    if(r.category!=='Материнские платы')return s;
    return {...s,hasRecordedCpuFanHeader:Array.isArray(s.coolingHeaders)&&s.coolingHeaders.some(h=>
      h&&Number.isInteger(h.count)&&h.count>0&&
      (['cpu_fan_header','cpu_opt_header'].includes(h.kind)||h.roles?.some(role=>['cpu_fan','cpu_opt'].includes(role)))&&
      [3,4].includes(h.pins)&&Array.isArray(h.control)&&h.control.some(mode=>['pwm','dc'].includes(mode))&&
      Number.isFinite(h.max_current_a)&&h.max_current_a>0)};
  };
  const brief=r=>({skuOver:r.skuOver,category:r.category,name:clean(r.product?.name),manufacturer:clean(r.product?.manufacturer),
    price:r.offer.price,stock:r.offer.quantity,transferBusinessDays:r.offer.days});
  function summary(){
    const categories=[...new Set(eligible.map(r=>r.category))].sort().map(category=>{
      const items=eligible.filter(r=>r.category===category),prices=items.map(r=>r.offer.price);
      const fields={};for(const item of items)for(const [key,value] of Object.entries(searchableSpec(item))){if(value!=null&&!['object'].includes(typeof value))fields[key]=typeof value;else if(Array.isArray(value)&&value.every(v=>typeof v==='string'))fields[key]='string[]';}
      const filterValues={};
      for(const field of ['socket','formFactor','memoryType']){
        const values=[...new Set(items.map(item=>spec(item)[field]).filter(v=>typeof v==='string'))];
        if(values.length&&values.length<=16)filterValues[field]=values;
      }
      return {category,count:items.length,minPrice:Math.min(...prices),maxPrice:Math.max(...prices),priceDistribution:priceStats(items),filterFields:fields,filterValues};
    });
    return {...context,total:eligible.length,categories};
  }
  function search(query={}){
    keys(query,['category','text','minPrice','maxPrice','minStock','filters','sort','offset','limit']);
    const {category,text='',minPrice=0,maxPrice=Number.MAX_SAFE_INTEGER,minStock=1,filters=[],sort='sku',offset=0,limit=20}=query;
    if(category!==undefined&&!Object.hasOwn(CATEGORY_FACT,category)||typeof text!=='string'||text.length>160||
      ![minPrice,maxPrice].every(v=>Number.isFinite(v)&&v>=0)||minPrice>maxPrice||
      !Number.isSafeInteger(minStock)||minStock<1||!Number.isSafeInteger(offset)||offset<0||
      !Number.isSafeInteger(limit)||limit<1||limit>40||!['sku','price_asc','price_desc'].includes(sort)||
      !Array.isArray(filters)||filters.length>8)throw Error('invalid_catalog_query');
    for(const f of filters){
      keys(f,['field','op','value']);
      if(typeof f.field!=='string'||!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(f.field)||
        ['constructor','prototype','__proto__'].includes(f.field)||!['eq','gte','lte','contains'].includes(f.op)||
        !['string','number','boolean'].includes(typeof f.value)||typeof f.value==='string'&&f.value.length>160||
        typeof f.value==='number'&&!Number.isFinite(f.value)||['gte','lte'].includes(f.op)&&typeof f.value!=='number')throw Error('invalid_catalog_query');
    }
    const norm=v=>String(v).toLocaleLowerCase('ru-RU');
    const tokens=norm(text).trim().split(/\s+/).filter(Boolean);
    const matchingRequirements=eligible.filter(r=>(!category||r.category===category)&&
      r.offer.quantity>=minStock&&tokens.every(token=>norm([r.skuOver,r.product?.name,r.product?.article,r.product?.manufacturer,...Object.values(spec(r)).flatMap(v=>typeof v==='string'||typeof v==='number'?[v]:Array.isArray(v)?v.filter(x=>typeof x==='string'||typeof x==='number'):[])].join(' ')).includes(token))&&
      filters.every(f=>{
        const s=searchableSpec(r);if(!Object.hasOwn(s,f.field)||s[f.field]==null)return false;
        const value=s[f.field];
        if(f.op==='gte'||f.op==='lte')return typeof value==='number'&&(f.op==='gte'?value>=f.value:value<=f.value);
        if(f.op==='contains')return Array.isArray(value)?value.some(v=>typeof v!=='object'&&norm(v)===norm(f.value)):
          typeof value==='string'&&norm(value).includes(norm(f.value));
        return typeof value===typeof f.value&&(typeof value==='string'?norm(value)===norm(f.value):value===f.value);
      }));
    const matched=matchingRequirements.filter(r=>r.offer.price>=minPrice&&r.offer.price<=maxPrice).sort((a,b)=>(sort==='price_asc'?a.offer.price-b.offer.price:sort==='price_desc'?b.offer.price-a.offer.price:0)||a.skuOver.localeCompare(b.skuOver));
    const availableFields=new Set(eligible.filter(r=>!category||r.category===category).flatMap(r=>Object.keys(searchableSpec(r))));
    const unknownFilterFields=filters.filter(f=>!availableFields.has(f.field)).map(f=>f.field);
    const items=matched.slice(offset,offset+limit).map(brief);
    const withoutText=!matched.length&&tokens.length?search({...query,text:'',offset:0,limit:1}):null;
    return {...context,total:matched.length,offset,items,nextOffset:offset+items.length<matched.length?offset+items.length:null,
      matchingPriceDistribution:priceStats(matchingRequirements),
      ...(withoutText?.total?{textRestriction:{tokens,matchingAllTokens:true,matchesWithoutText:withoutText.total,suggestedQuery:{...query,text:'',offset:0},note:'Suggestion only; these products do not necessarily match the requested text. Structured filters, stock and price constraints are unchanged.'}}:{}),
      ...(!matched.length?{hint:'No matches. Remove optional preferences you introduced (for example ATX-only form factor) before relaxing required socket or recorded evidence. A prior candidate is NOT proven to match this query.'}:{}),
      ...(unknownFilterFields.length?{unknownFilterFields}:{}),
      ...(!matched.length&&matchingRequirements.length?{outsidePriceRange:{count:matchingRequirements.length,minPrice:Math.min(...matchingRequirements.map(r=>r.offer.price)),maxPrice:Math.max(...matchingRequirements.map(r=>r.offer.price))}}:{})};
  }
  function details(query){
    keys(query,['skus']);
    if(!Array.isArray(query.skus)||!query.skus.length||query.skus.length>8||query.skus.some(s=>typeof s!=='string'||s.length>120))throw Error('invalid_catalog_query');
    const items=[],missing=[];
    for(const sku of [...new Set(query.skus)]){
      const row=bySku.get(sku);if(!row){missing.push(sku);continue;}
      const specifications=structuredClone(spec(row));
      if(JSON.stringify(specifications).length>16000){items.push({...brief(row),detailsUnavailable:'specifications_too_large'});continue;}
      let performance=null;
      if(row.category==='Процессоры')performance={workload:assessWorkload(profile,'cpu',cpuModel(row.component.officialModel||row.product.name,row.product.manufacturer),null,cohorts),
        gaming:cpuEvidence(row.product,specifications,row.component.officialModel)};
      if(row.category==='Видеокарты')performance={workload:assessWorkload(profile,'gpu',specifications.gpu,specifications.memoryGB,cohorts),
        gaming:gpuEvidence(specifications,request.tasks||'',request.partPreferences?.gamingResolution)};
      items.push({...brief(row),specifications,performance,missingValuesAreUnknown:true,
        ...(row.category==='Блоки питания'?{searchMetadata:{recordedPcie8CableCount:searchableSpec(row).recordedPcie8CableCount,recordedPcie16CableCount:searchableSpec(row).recordedPcie16CableCount}}:{}),
        ...(row.category==='Материнские платы'?{searchMetadata:{hasRecordedCpuFanHeader:searchableSpec(row).hasRecordedCpuFanHeader}}:{})});
    }
    return {...context,items,missing};
  }
  function validate(proposal){return validator.validate(proposal);}
  return Object.freeze({snapshotId:validator.snapshotId,customerRequest:()=>structuredClone(request),summary,search,details,validate});
}
module.exports={createAiCatalogSession};
