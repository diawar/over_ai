'use strict';
// These applications support non-CUDA paths. Unknown plug-ins/engines remain
// outside this rule; do not extrapolate from a program name to every workload.
const portableApplications=new Set(['gaming','office','photoshop','lightroom','blender','twinmotion','premiere']);
function applyWorkloadPolicy(action,userMessages){
  const tasks=action.workloadProfile?.tasks;
  if(!tasks?.length||tasks.some(t=>!portableApplications.has(t.application)))return false;
  const text=userMessages.join('\n');
  if(/octane|redshift|v[- ]?ray|плагин|plugin/iu.test(text))return false;
  if(action.workloadGpu?.technology==='cuda'&&!/\b(?:cuda|optix)\b/iu.test(text)){
    action.workloadGpu={...action.workloadGpu,technology:null};return true;
  }
  return false;
}
function redundantTaskQuestion(reply,workload){
  if(!workload?.tasks?.length||workload.tasks.some(t=>t.application==='other'))return false;
  const questions=reply.match(/[^.!?\n]*[?？]/gu)||[];
  return questions.length>0&&questions.every(q=>
    /бюджет/iu.test(q)||/ещ[её][^?？]{0,60}(?:программ|задач|игр)/iu.test(q));
}
function taskAcknowledgement(tasks,gpu){
  const description=String(tasks||'').replace(/[.!?\s]+$/u,'');
  const graphics=gpu?.mode==='required'?'Для подбора нужна дискретная видеокарта.':
    gpu?.mode==='preferred'?'При подборе сравним варианты со встроенной и дискретной графикой.':
    gpu?.mode==='not_required'?'Дискретная видеокарта не является обязательным условием подбора.':'';
  return `Учёл Ваши задачи: ${description}.${graphics?' '+graphics:''}`;
}
function taskClarification(reply,tasks,gpu,workload){
  const questions=reply.match(/[^.!?\n]*[?？]/gu)||[];
  const question=questions.find(q=>!redundantTaskQuestion(q,workload));
  if(question&&question.trim()===reply.trim())return reply;
  return question?taskAcknowledgement(tasks,gpu)+' '+question.trim():reply;
}
module.exports={applyWorkloadPolicy,redundantTaskQuestion,taskAcknowledgement,taskClarification};
