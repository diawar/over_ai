'use strict';
const registry=require('./performance-models.json');
function normalizeModel(value){
  return String(value||'').replace(/[®™]/g,'').replace(/\s+/g,' ').trim()
    .replace(/^(AMD|NVIDIA)\s+(?=Radeon|GeForce)/i,'')
    .replace(/\bi([3579])-\s*(?=\d)/ig,'i$1 ').toLowerCase();
}
function cpuModel(name,manufacturer=''){
  const text=normalizeModel(name);
  const registered=registry.models.filter(row=>row.type==='cpu'&&[row.name,...(row.aliases||[])].some(alias=>{
    const escaped=normalizeModel(alias).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9-])`,'i').test(text);
  }));
  if(registered.length===1){
    const row=registered[0];
    return !manufacturer||normalizeModel(manufacturer)===normalizeModel(row.manufacturer||row.name.split(' ')[0])?row.name:null;
  }
  if(registered.length>1)return null;
  const matches=[...String(name||'').replace(/[®™]/g,'').matchAll(new RegExp(registry.cpuPattern,'gi'))];
  if(matches.length!==1)return null;
  let model=matches[0][0];
  if(!/^(AMD|Intel)\s/i.test(model))model=(/^Ryzen/i.test(model)?'AMD ':'Intel ')+model;
  if(manufacturer&&normalizeModel(manufacturer)!==model.split(' ')[0].toLowerCase())return null;
  return model.replace(/\bi([3579])-\s*(?=\d)/ig,'i$1 ').replace(/\s+/g,' ').trim();
}
function identifyGpu(spec){
  const name=String(spec?.gpu||'').trim();
  const registered=registry.models.find(row=>row.type==='gpu'&&row.memoryGB===spec?.memoryGB&&
    [row.name,...(row.aliases||[])].some(alias=>normalizeModel(alias)===normalizeModel(name)));
  return {model:registered?.name||name,family:registered?.family||null,memoryGB:spec?.memoryGB??null};
}
module.exports={normalizeModel,cpuModel,identifyGpu,registry};
