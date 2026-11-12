'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
// Shared by standalone experimental runs; stores only organization ID and expiry.
function createPlannerCooldown(directory=path.join(os.tmpdir(),'corelab-planner-cooldown'),now=Date.now){
  const file=(id,provider)=>{if(!Number.isSafeInteger(id)||id<1)throw Error('invalid_organization');if(provider&&!['openai','kimi','openrouter'].includes(provider))throw Error('invalid_provider');return path.join(directory,`${id}${provider?'-'+provider:''}.json`);};
  function until(id,provider){try{const value=JSON.parse(fs.readFileSync(file(id,provider),'utf8')).until;return Number.isFinite(value)?value:0;}catch{return 0;}}
  // Legacy cooldowns were created during Kimi trials; preserve them for Kimi only.
  const expiry=(id,provider)=>Math.max(until(id,provider),provider==='kimi'?until(id):0);
  return {
    remainingMs:(id,provider)=>Math.max(0,expiry(id,provider)-now()),
    defer(id,seconds,provider){
      if(!Number.isInteger(seconds)||seconds<0||seconds>86400)return;
      const target=file(id,provider),nextExpiry=Math.max(expiry(id,provider),now()+seconds*1000);
      fs.mkdirSync(directory,{recursive:true});
      const temp=`${target}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temp,JSON.stringify({until:nextExpiry}));fs.renameSync(temp,target);
    },
  };
}
module.exports={createPlannerCooldown};
