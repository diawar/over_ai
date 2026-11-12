'use strict';
function memoryProfileSupport(spec,board={}){
  const normalize=values=>new Set((Array.isArray(values)?values:[]).map(v=>String(v).trim().toUpperCase())
    .filter(v=>['EXPO','XMP','XMP 2.0','XMP 3.0'].includes(v)));
  const memory=normalize(spec.profiles),supported=normalize(board.memoryProfiles);
  const common=[...memory].filter(v=>supported.has(v)||v.startsWith('XMP')&&supported.has('XMP'));
  const confirmedJedec=Array.isArray(spec.profiles)&&spec.profiles.length===0;
  return {advertised:memory.size>0,confirmedJedec,common,tuningAllowed:confirmedJedec||common.length>0,utility:common.length?0.5:0};
}
function timings(spec){
  const raw=String(spec.timings??'').trim();
  const match=/^(?:CL\s*)?(\d{1,3})(?:\s*[-–]\s*(\d{1,3})\s*[-–]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?)?$/i.exec(raw);
  if(!match||!Number.isFinite(spec.speedMTs)||spec.speedMTs<=0)return {ns:null,utility:0};
  const cycles=match.slice(1).map(v=>v===undefined?null:Number(v));
  if(cycles.some(v=>v!==null&&(v<1||v>200)))return {ns:null,utility:0};
  const ns=cycles.map(v=>v===null?null:v*2000/spec.speedMTs);
  // Bounded selection preference, not measured application performance.
  const ceilings=[20,25,25,60],weights=[0.7,0.1,0.1,0.1];
  const utility=Math.round(15*ns.reduce((sum,v,i)=>sum+(v===null?0:weights[i]*Math.max(0,1-v/ceilings[i])),0))/10;
  return {ns,utility};
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function referencePrices(rows,specFor){
  const groups=new Map(),keys=new Map();
  for(const row of rows){
    const key=JSON.stringify([row.category,canonical(specFor(row))]);keys.set(row.skuOver,key);
    groups.set(key,Math.min(groups.get(key)??Infinity,row.offer.price));
  }
  return new Map(rows.map(row=>[row.skuOver,groups.get(keys.get(row.skuOver))]));
}
function balanceBonus(referencePrice,budget,share,capability){
  return 1.5*Math.min(1,referencePrice/(budget*share))*Math.max(0,Math.min(1,capability));
}
function caseCapability(spec,gpu,cooler){
  const layout=String(spec.preinstalledFans||'');
  const ventilation=/front|side|bottom/i.test(layout)&&/rear|top/i.test(layout)?0.5:0;
  const gpuReserve=gpu&&Number.isFinite(spec.maxGpuLengthMm)?Math.min(1,Math.max(0,spec.maxGpuLengthMm-gpu.dimensions.lengthMm)/50)*0.25:0;
  const coolerReserve=Number.isFinite(spec.maxCpuCoolerHeightMm)&&Number.isFinite(cooler.dimensionsMm?.heightMm)?
    Math.min(1,Math.max(0,spec.maxCpuCoolerHeightMm-cooler.dimensionsMm.heightMm)/20)*0.25:0;
  return ventilation+gpuReserve+coolerReserve;
}
module.exports={timings,referencePrices,balanceBonus,caseCapability,memoryProfileSupport};
