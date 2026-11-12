'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {buildDataFromCorelab,calculateBuildResponse}=require('./preview-app.cjs');
const {setPopularGames}=require('./game-context.cjs');
const {setBenchmarkData}=require('./performance-evidence.cjs');

(async()=>{
  setPopularGames(workerData.popularGames);
  if(workerData.benchmarkData)setBenchmarkData(workerData.benchmarkData);
  const catalog=await buildDataFromCorelab(workerData.organizationId);
  parentPort.postMessage({type:'progress',phase:'inventory',
    candidates:catalog.getBuildCandidates(workerData.body.city).length});
  const output=calculateBuildResponse(workerData.body,catalog,progress=>
    parentPort.postMessage({type:'progress',...progress}));
  parentPort.postMessage({type:'result',...output});
})().catch(error=>{
  parentPort.postMessage({type:'result',status:503,
    payload:{error:error?.message==='request_too_large'?'request_too_large':'corelab_catalog_unavailable'}});
});
