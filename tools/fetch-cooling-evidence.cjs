'use strict';
// Downloads public specification pages only; no model/API calls or credentials.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.join(__dirname,'..','data','cooling-source-cache-20261028');
fs.mkdirSync(root,{recursive:true});
const products=JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','cooling-recovery-20261028.json'),'utf8')).products;
const extra=path.join(__dirname,'..','data','cooling-extra-sources-20261028.json');
const urls=[...new Set([...products.flatMap(p=>[...p.sources,...p.received.flatMap(x=>(x.values||[]).map(v=>v.source_url))]),
  ...(fs.existsSync(extra)?JSON.parse(fs.readFileSync(extra,'utf8')):[])].filter(url=>!url.includes('ProductCompatibility')))];
const indexFile=path.join(root,'index.json');
const index=fs.existsSync(indexFile)?JSON.parse(fs.readFileSync(indexFile,'utf8')):{};
for(const item of Object.values(index)){
  if(item.status!==200||!item.file.endsWith('.html'))continue;
  const raw=fs.readFileSync(path.join(root,item.file),'utf8');
  for(const match of raw.matchAll(/https?:\/\/[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?/gi)){
    const url=match[0].replace(/&amp;/g,'&');
    if(!urls.includes(url))urls.push(url);
  }
  for(const match of raw.matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)){
    const url=new URL(match[1].replace(/&amp;/g,'&'),item.finalUrl).href;
    if(!urls.includes(url))urls.push(url);
  }
}
let next=0;
if(process.argv[2])urls.splice(0,urls.length,...urls.filter(url=>url.includes(process.argv[2])));
async function work(){
  while(next<urls.length){
    const url=urls[next++];
    if(index[url]?.status===200)continue;
    try{
      const response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(35000)});
      const data=Buffer.from(await response.arrayBuffer());
      const pdf=data.subarray(0,4).toString()==='%PDF';
      const isImage=response.headers.get('content-type')?.startsWith('image/');
      const name=crypto.createHash('sha256').update(url).digest('hex').slice(0,20)+(pdf?'.pdf':isImage?'.webp':'.html');
      index[url]={status:response.status,file:name,finalUrl:response.url};
      fs.writeFileSync(path.join(root,name),data);
      if(!pdf&&!isImage){
        const text=data.toString('utf8').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
          .replace(/<\/(?:tr|p|div|li|h[1-6]|table)>|<br\s*\/?>/gi,'\n')
          .replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&')
          .replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n');
        fs.writeFileSync(path.join(root,name+'.txt'),text);
      }
      console.log(`${response.status} ${url}`);
    }catch(error){index[url]={status:0,error:error.name};console.log(`FAILED ${url}`);}
    fs.writeFileSync(indexFile,JSON.stringify(index,null,2));
  }
}
Promise.all([work(),work(),work(),work()]).then(()=>console.log(`FINISHED ${urls.length} public sources; no API calls`));
