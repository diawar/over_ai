'use strict';
const {normalizeModel}=require('./model-identity.cjs');
const APPLICATIONS=['gaming','office','photoshop','lightroom','blender','twinmotion','premiere','other'];
const OPERATIONS=['interactive','cpu_render','gpu_render'];
const workloadSchema={type:['object','null'],additionalProperties:false,properties:{
  version:{type:'integer',enum:[1]},
  tasks:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,properties:{
    application:{type:'string',enum:APPLICATIONS},operation:{type:'string',enum:OPERATIONS},
    priority:{type:'string',enum:['primary','secondary']},
    complexity:{type:'string',enum:['unknown','basic','heavy']}
  },required:['application','operation','priority','complexity']}}
},required:['version','tasks']};
function validateWorkload(value){
  if(value==null)return null;
  if(value.version!==1||!Array.isArray(value.tasks)||!value.tasks.length||value.tasks.length>8)
    throw Error('invalid_workload_profile');
  const seen=new Map();
  const tasks=value.tasks.map(task=>{
    if(!task||!APPLICATIONS.includes(task.application)||!OPERATIONS.includes(task.operation)||
      !['primary','secondary'].includes(task.priority)||!['unknown','basic','heavy'].includes(task.complexity))
      throw Error('invalid_workload_profile');
    const key=`${task.application}:${task.operation}`;
    if(seen.has(key)){
      const previous=seen.get(key);
      if(previous.priority===task.priority&&previous.complexity===task.complexity)return null;
      throw Error('invalid_workload_profile');
    }
    seen.set(key,task);
    return {application:task.application,operation:task.operation,priority:task.priority,complexity:task.complexity};
  }).filter(Boolean);
  if(!tasks.some(task=>task.priority==='primary'))throw Error('invalid_workload_profile');
  return {version:1,tasks};
}
function profileFor(purpose,preferences){
  return validateWorkload(preferences.workloadProfile)||{version:1,tasks:[{
    application:purpose==='Для игр'?'gaming':purpose==='Для офиса'?'office':'other',
    operation:'interactive',priority:'primary',complexity:'unknown'
  }]};
}
// An observation is comparable only within one versioned test cohort. Never
// substitute another application, render engine, GPU memory size or operation.
function assessWorkload(profile,kind,model,memoryGB,cohorts=[]){
  const tasks=profile.tasks.filter(task=>task.application!=='gaming').map(task=>{
    const cohort=cohorts.find(c=>!c.referenceOnly&&c.application===task.application&&c.operation===task.operation&&
      c.component===kind&&c.id&&c.version&&c.url&&c.date&&c.metric&&c.baseValue>0&&
      ['higher','lower'].includes(c.direction));
    const row=cohort?.observations?.find(r=>normalizeModel(r.model)===normalizeModel(model)&&
      (kind!=='gpu'||r.memoryGB===memoryGB)&&Number.isFinite(r.value)&&r.value>0);
    return {...task,status:row?'measured':'not_evaluated',score:row?
      100*(cohort.direction==='higher'?row.value/cohort.baseValue:cohort.baseValue/row.value):null,
      evidence:row?{cohort:cohort.id,version:cohort.version,url:cohort.url,date:cohort.date,
        metric:cohort.metric,value:row.value,scope:cohort.scope||null}:null};
  });
  const relevant=tasks.filter(t=>t.priority==='primary');
  // Owner policy: use known primary tests without claiming coverage of unknown
  // workloads. Missing tests remain null, never zero-performance observations.
  const measured=relevant.filter(t=>t.status==='measured');
  const score=measured.length?measured.reduce((sum,t)=>sum+t.score,0)/measured.length:null;
  return {status:score===null?'not_evaluated':measured.length===relevant.length?'measured':'partial',
    score,coverage:{measured:measured.length,total:relevant.length},tasks};
}
function workloadGaps(cpu,gpu){
  const names={photoshop:'Photoshop',lightroom:'Lightroom',blender:'Blender',twinmotion:'Twinmotion',
    premiere:'Premiere Pro',office:'офисные задачи',other:'другие задачи'};
  const operations={interactive:'работа в программе',cpu_render:'CPU-рендеринг',gpu_render:'GPU-рендеринг'};
  const gaps=[];
  for(const [label,assessment] of [['CPU',cpu],['GPU',gpu]]){
    const missing=assessment?.tasks.filter(t=>t.status!=='measured')||[];
    if(missing.length)gaps.push(`${label}: ${missing.map(t=>`${names[t.application]||t.application} (${operations[t.operation]||t.operation})`).join(', ')}`);
  }
  return gaps.length?[`Не оценено по тестам — ${gaps.join('; ')}. Известные результаты других задач не подтверждают производительность в этих программах.`]:[];
}
// Windows requirements. These are admission floors, not performance scores.
// Epic also specifies benchmark thresholds; VRAM alone does not certify them.
// https://dev.epicgames.com/documentation/en-us/twinmotion/hardware-and-software-specifications-for-twinmotion
function workloadRequirements(profile){
  const twinmotion=profile.tasks.filter(task=>task.application==='twinmotion');
  const heavy=twinmotion.some(task=>task.complexity==='heavy');
  return {requiresGpu:twinmotion.length>0,minVramGB:twinmotion.length?(heavy?12:6):0,
    minMemoryGB:twinmotion.length?(heavy?64:16):0};
}
module.exports={workloadSchema,validateWorkload,profileFor,assessWorkload,workloadRequirements,workloadGaps};
