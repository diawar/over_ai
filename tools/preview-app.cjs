'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createBuildQueue} = require('./build-queue.cjs');
const {createSessionStore}=require('./chat-session-store.cjs');
const {createChatService, corelabAIStatus, AIError} = require('./corelab-ai.cjs');
const {createCorelabData} = require('./corelab-data.cjs');
const {buildPc} = require('./pc-builder.cjs');
const {getPopularGames,refreshPopularGames}=require('./game-context.cjs');
const {getBenchmarkData}=require('./performance-evidence.cjs');
const {resolvePartChange,validatePartPreferences,isCheaperRequest,isQuietRequest,AIR,AIO} = require('./part-preferences.cjs');
const files = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/style.css', ['style.css','text/css; charset=utf-8']],
  ['/mobile.css', ['mobile.css','text/css; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
  ['/branding-init.js', ['branding-init.js','text/javascript; charset=utf-8']],
  ['/lucide-icons.js', ['lucide-icons.js','text/javascript; charset=utf-8']],
  ['/corelab-logo.png', ['corelab-logo.png','image/png']],
]);
async function buildDataFromCorelab(organizationId=1) {
  const base=process.env.CORELAB_INTERNAL_API;
  const secret=process.env.SESSION_SECRET;
  if(!base||!secret)throw new Error('corelab_catalog_unavailable');
  try{
    const signedValue=organizationId===1?'corelab-builder-products-v1':`corelab-builder-products-v1:${organizationId}`;
    const signature=crypto.createHmac('sha256',secret).update(signedValue).digest('hex');
    const response=await fetch(`${base}/api/v1/internal/builder/products?organization_id=${organizationId}`,{
      headers:{'X-CoreLab-Builder-Auth':signature},signal:AbortSignal.timeout(5000),cache:'no-store'});
    if(!response.ok)throw new Error('corelab_catalog_unavailable');
    const data=await response.json();
    return createCorelabData(data.items, undefined, {rules:data.rules, rulesVersion:data.rulesVersion, operations:data.operations});
  }catch{throw new Error('corelab_catalog_unavailable');}
}
function calculateBuildResponse(body,localData,onProgress=()=>{}) {
  let partPreferences;let referenceBuild=null;
  try{
    partPreferences=validatePartPreferences(body.partPreferences);
    if(body.changeRequest!==undefined){
      if(typeof body.changeRequest!=='string')throw Error('invalid_part_request');
      const baseline=isCheaperRequest(body.changeRequest)||isQuietRequest(body.changeRequest)
        ?buildPc({...body,localData,partPreferences,
          onProgress:progress=>onProgress({phase:'baseline',...progress})}):null;
      referenceBuild=baseline?.ok?baseline.build:null;
      partPreferences=resolvePartChange(body.changeRequest,
        localData.getBuildCandidates(body.city),partPreferences,referenceBuild);
    }
  }catch(error){return {status:422,payload:{error:error.message}};}
  const result=buildPc({...body,localData,partPreferences,
    onProgress:progress=>onProgress({phase:'compare',...progress})});
  if(!result.ok){
    const code=result.code==='requested_part_no_build'
      ? isCheaperRequest(body.changeRequest)?'cheaper_part_no_build'
        : isQuietRequest(body.changeRequest)?'quiet_part_no_build':result.code
      : result.code;
    return {status:result.code==='invalid_build_request'?400:422,payload:{error:code,city:result.city,
      reasons:result.reasons,rulesVersion:result.rulesVersion,
      resolution:result.resolution,minimumReferenceFps:result.minimumReferenceFps,
      minimumVramGB:result.minimumVramGB,minimumTotal:result.minimumTotal,
      budgetLimit:result.budgetLimit,
      referenceNoiseDba:isQuietRequest(body.changeRequest)
        ? partPreferences.maxFanNoiseDba??partPreferences.maxCoolerNoiseDba:undefined}};
  }
  const build=result.build;
  let noiseComparison;
  if(isQuietRequest(body.changeRequest)&&referenceBuild){
    const chosenPart=part=>partPreferences.maxFanNoiseDba!==undefined
      ? part.category==='Охлаждение для корпусов ПК'
      : part.category===AIR||part.category===AIO;
    const previous=referenceBuild.parts.find(chosenPart);
    const selected=build.parts.find(chosenPart);
    const row=selected&&localData.getBuildCandidates(body.city).find(item=>item.skuOver===selected.skuOver);
    const noiseDba=row?.component?.facts?.[selected?.category==='Охлаждение для корпусов ПК'
      ? 'caseFanSpecifications':'cpuCoolerSpecifications']?.value?.noiseDba;
    if(previous&&selected&&Number.isFinite(noiseDba))noiseComparison={
      previousName:previous.name,previousDba:partPreferences.maxFanNoiseDba??partPreferences.maxCoolerNoiseDba,
      selectedName:selected.name,selectedDba:noiseDba};
  }
  return {status:200,payload:{partPreferences,noiseComparison,
    build:{...build,parts:build.parts.map(({skuOver,category,name,productUrl,quantity,price,transferBusinessDays})=>
      ({skuOver,category,name,productUrl:typeof productUrl==='string'&&/^https:\/\//i.test(productUrl)?productUrl:null,
        quantity,price,transferBusinessDays}))}}};
}
function createServer({chatService:providedChatService,buildDataProvider:providedBuildDataProvider,buildQueue:providedBuildQueue}={}) {
const buildDataProvider=providedBuildDataProvider || buildDataFromCorelab;
const chatServices=new Map();
const serviceUse=new Map();
const buildQueue=providedBuildQueue||createBuildQueue();
async function queuedBuild(body,organizationId,options={}){
  if(providedBuildDataProvider)return calculateBuildResponse(body,await buildDataProvider(organizationId));
  return buildQueue.run({body,organizationId,popularGames:getPopularGames(),benchmarkData:getBenchmarkData()},options);
}
function serviceFor(organizationId){
  if(providedChatService)return providedChatService;
  for(const [id,service] of chatServices)if(Date.now()-(serviceUse.get(id)||0)>3600000&&!service.isBusy()){
    chatServices.delete(id);serviceUse.delete(id);
  }
  if(!chatServices.has(organizationId)&&chatServices.size>=100)throw new Error('server_busy');
  if(!chatServices.has(organizationId))chatServices.set(organizationId,createChatService({
    config:()=>({provider:'corelab',organizationId}),
    sessionStore:process.env.CHAT_SESSION_DIRECTORY?createSessionStore(process.env.CHAT_SESSION_DIRECTORY,organizationId):null,
    buildProvider:async (profile,options)=>{
      const result=await queuedBuild(profile,organizationId,options);
      return result.status===200?{ok:true,build:result.payload.build}:{ok:false,...result.payload};
    }}));
  serviceUse.set(organizationId,Date.now());
  return chatServices.get(organizationId);
}
async function organizationAvailable(organizationId){
  if(providedChatService||providedBuildDataProvider||providedBuildQueue)return true;
  const base=process.env.CORELAB_INTERNAL_API,secret=process.env.SESSION_SECRET;
  if(!base||!secret)return false;
  const value=organizationId===1?'corelab-builder-products-v1':`corelab-builder-products-v1:${organizationId}`;
  const signature=crypto.createHmac('sha256',secret).update(value).digest('hex');
  const response=await fetch(`${base}/api/v1/internal/builder/availability?organization_id=${organizationId}`,{
    headers:{'X-CoreLab-Builder-Auth':signature},signal:AbortSignal.timeout(5000)});
  return response.ok&&(await response.json()).available===true;
}
const server=http.createServer(async (req,res)=>{
  const controller=new AbortController();
  res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  const requestedRoute=(req.url||'/').split('?')[0];
  const route=requestedRoute==='/mini-app' ? '/' : requestedRoute.startsWith('/mini-app/') ? requestedRoute.slice('/mini-app'.length) : requestedRoute;
  const host=req.headers.host||'';
  if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host)){res.writeHead(403);res.end('Forbidden');return;}
  if(requestedRoute==='/mini-app') {res.writeHead(308,{Location:'/mini-app/'});res.end();return;}
  function json(status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
  if(route==='/healthz'&&req.method==='GET'){json(200,{ok:true});return;}
  const rawOrganizationId=new URL(req.url||'/',`http://${host}`).searchParams.get('organization_id')||'1';
  const organizationId=Number(rawOrganizationId);
  if(!Number.isSafeInteger(organizationId)||organizationId<1){json(400,{error:'invalid_organization'});return;}
  let chatService;
  if(['/api/status','/api/chat','/api/pc-build'].includes(route)){
    try{
      if(!await organizationAvailable(organizationId)){json(404,{error:'organization_unavailable'});return;}
      chatService=serviceFor(organizationId);
    }catch{json(503,{error:'server_busy'});return;}
  }
  if(route==='/api/branding'&&req.method==='GET'){
    try{
      const base=process.env.CORELAB_INTERNAL_API;
      if(!base)throw new Error('branding_unavailable');
      const response=await fetch(`${base}/api/v1/organizations/${organizationId}/branding`,{signal:AbortSignal.timeout(5000),cache:'no-store'});
      if(!response.ok){json(response.status===404?404:503,{error:'branding_unavailable'});return;}
      json(200,await response.json());
    }catch{json(503,{error:'branding_unavailable'});}
    return;
  }
  if(route==='/api/branding/logo'&&req.method==='GET'){
    try{
      const base=process.env.CORELAB_INTERNAL_API;
      if(!base)throw new Error('branding_unavailable');
      const response=await fetch(`${base}/api/v1/organizations/${organizationId}/branding/logo`,{signal:AbortSignal.timeout(5000),cache:'no-store'});
      if(!response.ok){res.writeHead(response.status===404?404:503);res.end();return;}
      res.writeHead(200,{'Content-Type':response.headers.get('content-type')||'image/png','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(503);res.end();}
    return;
  }
  if(route==='/api/status'&&req.method==='GET'){
    let builderAvailable=false;
    let catalogLoaded=false;
    let cities=[];
    try{
      const data=await buildDataProvider(organizationId);
      catalogLoaded=data.status().catalogLoaded===true;
      const branches=data.getBranches?.() || [];
      cities=[...new Set(branches.map(branch=>branch.city))];
      const targets=branches.length?branches:[{city:'Алматы'}];
      builderAvailable=data.status().buildEngineReady&&targets.some(branch=>{
      const categories=new Set(data.getBuildCandidates(branch.city,branch.code).map(row=>row.category));
      return [
        'Процессоры','Материнские платы','Оперативная память','Блоки питания',
        'Корпуса','Твердотельные диски (SSD)'
      ].every(category=>categories.has(category))&&[
        'Кулеры для процессоров','Системы водяного / жидкостного охлаждения (СЖО)'
      ].some(category=>categories.has(category));
      });
    }catch{}
    const aiStatus=chatService.status();
    if(!providedChatService)aiStatus.ready=await corelabAIStatus(organizationId);
    json(200,{...aiStatus,builderAvailable,catalogLoaded,cities});return;
  }
  if(route==='/api/catalog/status'&&req.method==='GET'){
    try{json(200,(await buildDataProvider(organizationId)).status());}
    catch{json(503,{catalogLoaded:false,catalogSource:'corelab',buildsReady:false});}
    return;
  }
  if(route==='/api/pc-build'&&req.method==='POST'){
    if(req.headers.origin!==`http://${host}`||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){json(403,{error:'forbidden'});return;}
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>8192)throw new Error('request_too_large');chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{json(400,{error:'invalid_request'});return;}
      const streaming=(req.headers.accept||'').includes('application/x-ndjson')&&!providedBuildDataProvider;
      if(streaming){
        res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8',
          'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        res.write(JSON.stringify({type:'progress',phase:'queued'})+'\n');
      }
      let output;
      try{
        output=await queuedBuild(body,organizationId,{signal:controller.signal,
          onProgress:event=>{if(streaming&&!res.destroyed)res.write(JSON.stringify(event)+'\n');}});
      }catch(error){
        output={status:503,payload:{error:['build_queue_full','build_timeout'].includes(error.code)?error.code:'corelab_catalog_unavailable'}};
      }
      if(controller.signal.aborted)return;
      if(output.status===200&&output.payload?.build)
        chatService.recordBuild?.(body.sessionId,body,output.payload.build);
      if(output.status>=400)
        chatService.recordBuildError?.(body.sessionId,body,output.payload);
      if(streaming)res.end(JSON.stringify({type:'result',...output})+'\n');
      else json(output.status,output.payload);
    }catch(error){json(error?.message==='request_too_large'?413:503,
      {error:error?.message==='request_too_large'?'request_too_large':'corelab_catalog_unavailable'});}
    return;
  }
  if(route==='/api/chat'&&req.method==='POST'){
    if(req.headers.origin!==`http://${host}`||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){json(403,{error:'forbidden'});return;}
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>16384)throw new AIError('request_too_large',413);chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AIError('invalid_request');}
      json(200,await chatService.chat(body,{signal:controller.signal}));
    }catch(error){json(error instanceof AIError?error.status:500,{error:error instanceof AIError?error.code:'internal_error'});}
    return;
  }
  const file=files.get(route);
  if(!file || !['GET','HEAD'].includes(req.method)) {res.writeHead(404);res.end('Not found');return;}
  fs.readFile(path.join(__dirname,'..','app',file[0]),(error,body)=>{
    if(error){res.writeHead(500);res.end('Preview unavailable');return;}
    res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(req.method==='HEAD'?undefined:body);
  });
});
server.on('close',()=>void buildQueue.close());
return server;
}
if(require.main===module){
const updateGames=()=>refreshPopularGames().then(count=>console.log(`Steam chart games: ${count}`))
  .catch(error=>console.warn(`Steam chart refresh skipped: ${error.message}`));
void updateGames();
setInterval(updateGames,24*60*60*1000).unref();
// Reviewed local observations are shared with the admin model queue. Do not
// silently replace them with an in-memory scrape invisible to administrators.
const server=createServer();
server.requestTimeout=150000;
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
const port=Number(process.env.PORT)||8000;
const host=process.env.HOST||'127.0.0.1';
server.listen(port,host,()=>console.log(`CoreLab preview: http://${host}:${port} (Ctrl+C to stop)`));
}
module.exports={createServer,buildDataFromCorelab,calculateBuildResponse};
