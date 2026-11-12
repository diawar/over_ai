const test=require('node:test'),assert=require('node:assert/strict');
const {applyWorkloadPolicy,redundantTaskQuestion,taskClarification}=require('../tools/dialogue-workload-policy.cjs');
const action=(apps=['gaming','photoshop','blender'])=>({workloadGpu:{mode:'required',minVramGB:0,technology:'cuda'},workloadProfile:{version:1,tasks:apps.map(application=>({application,operation:'gpu_render',priority:'primary',complexity:'unknown'}))}});
test('mixed portable applications cannot invent a CUDA restriction',()=>{
 const a=action();assert.equal(applyWorkloadPolicy(a,['CS2, Photoshop, Blender GPU, любой бренд']),true);assert.equal(a.workloadGpu.technology,null);
});
test('explicit engines and unknown workloads are not silently relaxed',()=>{
 for(const [apps,text] of [[['blender'],'OptiX'],[['blender'],'CUDA'],[['blender'],'Blender Redshift'],[['other'],'специальный рендер']]){const a=action(apps);applyWorkloadPolicy(a,[text]);assert.equal(a.workloadGpu.technology,'cuda');}
});
test('budget and second-program questions yield to UI, scene questions remain',()=>{
 const w=action().workloadProfile;
 assert.equal(redundantTaskQuestion('Какой бюджет на ПК?',w),true);
 assert.equal(redundantTaskQuestion('Какие ещё программы используете?',w),true);
 assert.equal(redundantTaskQuestion('Используете ли Вы ещё какие-либо программы или игры?',w),true);
 assert.equal(redundantTaskQuestion('Сцены тяжёлые или небольшие?',w),false);
});
test('only one useful clarification survives',()=>{
 const reply=taskClarification('Какая сложность сцен? Какие ещё программы используете?', 'Blender', {mode:'required'},action().workloadProfile);
 assert.equal((reply.match(/\?/g)||[]).length,1);assert.match(reply,/сложность сцен/);assert.doesNotMatch(reply,/ещё программы/);
});
