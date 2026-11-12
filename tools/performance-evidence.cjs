'use strict';
const {normalizeModel,cpuModel,identifyGpu}=require('./model-identity.cjs');

// Model names identify observations; they are not eligibility rules.
let GPU_DATA=require('./benchmark-observations.json');
function getBenchmarkData(){return GPU_DATA;}
function setBenchmarkData(data){
  if(!data?.computerbase?.resolutions?.['1440p']?.observations?.length||
     !data?.computerbase?.resolutions?.['4K']?.observations?.length)
    throw Error('invalid_benchmark_data');
  GPU_DATA=data;
}
const CPU_GAMING = require('./performance-models.json').cpuGamingLegacy;

function requests1440p(tasks,resolution){
  return resolution==='1440p'||(resolution==null||resolution==='unknown')&&
    /\b1440p\b|\b(?:wqhd|qhd|2k)\b|2560\s*[x×]\s*1440|1440\s*[рp]/iu.test(String(tasks||''));
}

function gpuEvidence(spec,_tasks,resolution){
  // The 1440p cohort also provides a relative GPU ranking for unspecified/1080p builds.
  const selectedResolution=resolution==='4K'?'4K':'1440p';
  const reference=GPU_DATA.computerbase.resolutions[selectedResolution];
  if(!reference||!spec?.gpu||!Number.isFinite(spec.memoryGB))return null;
  const key=row=>`${normalizeModel(identifyGpu(row).model)}|${row.memoryGB}`;
  const computerbase=reference.observations.find(row=>key(row)===key(spec));
  if(!computerbase)return null;
  return {source:'ComputerBase',url:GPU_DATA.computerbase.url,
    metric:`${selectedResolution} ${GPU_DATA.computerbase.metric}`,
    reviewedAt:GPU_DATA.computerbase.checkedAt,gpu:spec.gpu,memoryGB:spec.memoryGB,
    referenceFps:computerbase.fps,rankingFps:computerbase.fps,baseFps:reference.baseFps,
    baseScore:reference.baseScore,
    scope:'Сравнение видеокарт на тестовой системе источника; не прогноз FPS этой сборки.'};
}

function gpuUtilityFromEvidence(evidence){
  return evidence?Math.round(evidence.baseScore*evidence.rankingFps/evidence.baseFps*10)/10:null;
}

function gpuAssessment(spec, evidence=null){
  return {...identifyGpu(spec),
    status:evidence?'measured':'not_evaluated',
    label:evidence?'Производительность оценена':'Производительность не оценена',
    score:gpuUtilityFromEvidence(evidence)};
}

function cpuEvidence(product,spec,officialModel=''){
  if(typeof product?.name!=='string')return null;
  const identity=cpuModel(officialModel?.trim()||product.name,product.manufacturer);
  if(!identity)return null;
  const cpuData=GPU_DATA.computerbase.cpu;
  const match=cpuData?.observations?.find(row=>normalizeModel(row.model)===normalizeModel(identity));
  if(match){
    const brand=match.model.split(' ')[0];
    if(String(product.manufacturer).toLowerCase()===brand.toLowerCase())
      return {source:'ComputerBase',url:cpuData.url,metric:cpuData.metric,
        reviewedAt:GPU_DATA.computerbase.checkedAt,model:match.model,
        referenceFps:match.fps,baseFps:cpuData.baseFps,baseScore:cpuData.baseScore,
        scope:'CPU comparison on the source test system; not a predicted frame rate for this build.'};
  }
  if(product.manufacturer!=='AMD')return null;
  const model=Object.keys(CPU_GAMING.observations).find(value=>normalizeModel(value)===normalizeModel(identity));
  if(!model)return null;
  const observation=CPU_GAMING.observations[model];
  if(spec?.socket!==observation.socket||spec?.cores!==observation.cores)return null;
  return {source:CPU_GAMING.source,url:CPU_GAMING.url,metric:CPU_GAMING.metric,
    reviewedAt:CPU_GAMING.reviewedAt,model,referenceFps:observation.average,
    referenceOnePercentLow:observation.onePercentLow,
    scope:'Тест процессоров с RTX 4090 при 720p; не прогноз FPS выбранной сборки.'};
}

function cpuUtilityFromEvidence(evidence){
  return evidence?Math.round((evidence.baseScore||24)*evidence.referenceFps/
    (evidence.baseFps||CPU_GAMING.observations['AMD Ryzen 5 7600'].average)*10)/10:null;
}

module.exports={CPU_GAMING,gpuAssessment,gpuEvidence,gpuUtilityFromEvidence,cpuEvidence,cpuUtilityFromEvidence,
  requests1440p,getBenchmarkData,setBenchmarkData};
