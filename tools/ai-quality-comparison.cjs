'use strict';
const {timings}=require('./component-budget.cjs');
// Observed differences only. No hand-written performance score or price threshold.
function qualityComparisons(baseline,details){
 const bySku=new Map(details.map(item=>[item.skuOver,item]));
 const parts=new Map((baseline.parts||[]).map(part=>[part.category,part]));
 return details.filter(item=>parts.has(item.category)&&parts.get(item.category).skuOver!==item.skuOver).slice(-12).map(item=>{
  const part=parts.get(item.category),old=bySku.get(part.skuOver),before=old?.specifications||{},after=item.specifications||{};
  const fields=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>{
   const simple=v=>v==null||['string','number','boolean'].includes(typeof v)||Array.isArray(v)&&v.every(x=>['string','number'].includes(typeof x));
   return simple(before[key])&&simple(after[key])&&JSON.stringify(before[key])!==JSON.stringify(after[key]);
  });
  const quantity=part.quantity||1,baselineUnitPrice=part.price/quantity,extraCost=item.price*quantity-part.price;
  return {category:item.category,baselineSku:part.skuOver,alternativeSku:item.skuOver,quantity,
   baselinePrice:baselineUnitPrice,alternativePrice:item.price,extraCost,totalWithReplacement:baseline.total+extraCost,
   priceIncreasePercent:baselineUnitPrice>0?Math.round((item.price/baselineUnitPrice-1)*1000)/10:null,
   baselineDetailsAvailable:Boolean(old),changedSpecifications:Object.fromEntries(fields.slice(0,20).map(key=>[key,{before:before[key]??null,after:after[key]??null}])),
   ...(item.category==='Оперативная память'?{memory:{before:{capacityGB:before.capacityGB??null,speedMTs:before.speedMTs??null,timings:before.timings??null,profiles:before.profiles??null,casLatencyNs:timings(before).ns?.[0]??null},after:{capacityGB:after.capacityGB??null,speedMTs:after.speedMTs??null,timings:after.timings??null,profiles:after.profiles??null,casLatencyNs:timings(after).ns?.[0]??null},note:'CAS delay is calculated from recorded CL and MT/s, not total system latency or an FPS forecast.'}}:{})};
 });
}
// Check complete compositions, not just a component's price delta. The sample
// contains inspected single replacements only; it is not an optimizer.
function validatedQualityAlternatives(catalog,baseline,details,cache=new Map()){
 const parts=baseline.parts||[];
 const candidates=[...new Map(details.filter(item=>!item.detailsUnavailable).map(item=>[item.skuOver,item])).values()]
  .filter(item=>item.category&&parts.filter(p=>p.category===item.category).length===1&&
   !parts.some(p=>p.skuOver===item.skuOver)).slice(-8);
 return candidates.map(item=>{
  const original=parts.find(p=>p.category===item.category);
  const proposal=parts.map(p=>({skuOver:p===original?item.skuOver:p.skuOver,quantity:p.quantity??1}));
  const key=JSON.stringify([catalog.snapshotId,proposal]);
  if(!cache.has(key)){
   const checked=catalog.validate({snapshotId:catalog.snapshotId,parts:proposal});
   cache.set(key,{baselineSku:original.skuOver,alternativeSku:item.skuOver,parts:proposal,
    ok:checked.ok===true,total:checked.total??null,
    priceDifference:Number.isFinite(checked.total)?checked.total-baseline.total:null,
    violations:checked.violations||[],unknowns:checked.unknowns||[],warnings:checked.warnings||[]});
  }
  return structuredClone(cache.get(key));
 });
}
module.exports={qualityComparisons,validatedQualityAlternatives};
