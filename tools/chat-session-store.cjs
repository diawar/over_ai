'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

// Local single-process store. Server-side context is never accepted from the browser.
function createSessionStore(directory,organizationId,{now=Date.now,ttlMs=3600000}={}){
  if(!Number.isSafeInteger(organizationId)||organizationId<1)throw new Error('invalid_organization');
  const folder=path.join(directory,String(organizationId));
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const fileFor=id=>{
    if(!/^[a-f0-9]{48}$/.test(id))throw new Error('invalid_session');
    return path.join(folder,id+'.json');
  };
  function remove(id){try{fs.unlinkSync(fileFor(id));}catch(error){if(error.code!=='ENOENT')throw error;}}
  function load(){
    const sessions=new Map();
    for(const name of fs.readdirSync(folder)){
      if(!/^[a-f0-9]{48}\.json$/.test(name))continue;
      const id=name.slice(0,-5),file=fileFor(id);
      let saved;
      try{
        if(fs.statSync(file).size>2*1024*1024)throw new Error('oversized_session');
        saved=JSON.parse(fs.readFileSync(file,'utf8'));
      }catch{remove(id);continue;}
      const session=saved.session;
      if(saved.version!==1||saved.organizationId!==organizationId||!session||
         !session.profile||!Array.isArray(session.history)||session.history.length>60||
         !Number.isFinite(session.touched)||session.touched>now()||now()-session.touched>=ttlMs){
        remove(id);continue;
      }
      if(sessions.size>=100)continue;
      sessions.set(id,{...session,busy:false,lastCall:Number.isFinite(session.lastCall)?session.lastCall:-Infinity});
    }
    return sessions;
  }
  function save(id,session){
    const target=fileFor(id),temporary=target+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
    const content=JSON.stringify({version:1,organizationId,session:{...session,busy:false}});
    if(Buffer.byteLength(content)>2*1024*1024)throw new Error('oversized_session');
    try{
      fs.writeFileSync(temporary,content,{mode:0o600,flag:'wx'});
      fs.renameSync(temporary,target);
    }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  return {load,save,remove};
}
module.exports={createSessionStore};
