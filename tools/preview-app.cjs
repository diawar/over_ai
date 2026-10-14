'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createChatService, AIError} = require('./corelab-ai.cjs');
const {createLocalData, LocalDataError} = require('./local-data.cjs');
const {buildPc} = require('./pc-builder.cjs');
const files = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/style.css', ['style.css','text/css; charset=utf-8']],
  ['/mobile.css', ['mobile.css','text/css; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
]);
function createServer({chatService:providedChatService,localData:providedLocalData}={}) {
const local = providedLocalData || (()=>{try{return createLocalData();}catch(error){if(error instanceof LocalDataError)return null;throw error;}})();
const chatService=providedChatService || createChatService({buildProvider:profile=>local&&buildPc({localData:local,...profile})});
return http.createServer(async (req,res)=>{
  const route=(req.url||'/').split('?')[0];
  const host=req.headers.host||'';
  if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host)){res.writeHead(403);res.end('Forbidden');return;}
  function json(status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
  if(route==='/api/status'&&req.method==='GET'){
    json(200,{...chatService.status(),builderAvailable:!!local?.status().buildEngineReady});return;
  }
  if(route==='/api/catalog/status'&&req.method==='GET'){
    json(200,local?local.status():{catalogLoaded:false,evidenceDatabaseLoaded:false,buildsReady:false});return;
  }
  if(route==='/api/pc-build'&&req.method==='POST'){
    if(req.headers.origin!==`http://${host}`||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){json(403,{error:'forbidden'});return;}
    if(!local){json(503,{error:'local_data_unavailable'});return;}
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>8192)throw new Error('request_too_large');chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{json(400,{error:'invalid_request'});return;}
      const result=buildPc({localData:local,...body});
      if(!result.ok){json(result.code==='invalid_build_request'?400:422,{error:result.code,city:result.city});return;}
      const build=result.build;
      json(200,{build:{...build,parts:build.parts.map(({skuOver,category,name,quantity,price,transferBusinessDays})=>({skuOver,category,name,quantity,price,transferBusinessDays}))}});
    }catch(error){json(error?.message==='request_too_large'?413:500,{error:error?.message==='request_too_large'?'request_too_large':'internal_error'});}
    return;
  }
  if(route==='/api/chat'&&req.method==='POST'){
    if(req.headers.origin!==`http://${host}`||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){json(403,{error:'forbidden'});return;}
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>16384)throw new AIError('request_too_large',413);chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AIError('invalid_request');}
      json(200,await chatService.chat(body));
    }catch(error){json(error instanceof AIError?error.status:500,{error:error instanceof AIError?error.code:'internal_error'});}
    return;
  }
  const file=files.get((req.url || '/').split('?')[0]);
  if(!file || !['GET','HEAD'].includes(req.method)) {res.writeHead(404);res.end('Not found');return;}
  fs.readFile(path.join(__dirname,'..','app',file[0]),(error,body)=>{
    if(error){res.writeHead(500);res.end('Preview unavailable');return;}
    res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(req.method==='HEAD'?undefined:body);
  });
});
}
if(require.main===module){
const server=createServer();
server.requestTimeout=60000;
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
server.listen(8000,'127.0.0.1',()=>console.log('CoreLab preview: http://127.0.0.1:8000 (Ctrl+C to stop)'));
}
module.exports={createServer};
