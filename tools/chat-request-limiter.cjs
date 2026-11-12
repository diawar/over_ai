'use strict';
const crypto=require('node:crypto');
const net=require('node:net');

function clientAddress(req,secret=process.env.MINI_APP_PROXY_SECRET,now=Date.now){
  const address=req.headers['x-corelab-client-address'];
  const stamp=req.headers['x-corelab-client-timestamp'];
  const signature=req.headers['x-corelab-client-signature'];
  if(secret&&typeof address==='string'&&net.isIP(address)&&typeof stamp==='string'&&/^\d{13}$/.test(stamp)&&
     Math.abs(now()-Number(stamp))<=60000&&typeof signature==='string'&&/^[a-f0-9]{64}$/.test(signature)){
    const expected=crypto.createHmac('sha256',secret).update(`${stamp}:${address}`).digest('hex');
    if(crypto.timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))return address.replace(/^::ffff:/,'');
  }
  return (req.socket.remoteAddress||'unknown').replace(/^::ffff:/,'');
}

function createChatRequestLimiter({now=Date.now,perMinute=12,perHour=120,newSessionsPerHour=5,maxClients=4096}={}){
  const clients=new Map();
  function acquire(key,{newSession=false}={}){
    const stamp=now(),minute=Math.floor(stamp/60000),hour=Math.floor(stamp/3600000);
    for(const [id,row] of clients)if(row.hour!==hour)clients.delete(id);
    let row=clients.get(key);
    const deny=until=>({allowed:false,retryAfter:Math.max(1,Math.ceil((until-stamp)/1000))});
    if(!row){
      // Bound memory without evicting another client's active rate limit.
      if(clients.size>=maxClients)return deny((hour+1)*3600000);
      row={minute,hour,minuteCount:0,hourCount:0,newSessions:0};
    }
    if(row.minute!==minute){row.minute=minute;row.minuteCount=0;}
    if(row.hourCount>=perHour||newSession&&row.newSessions>=newSessionsPerHour)return deny((hour+1)*3600000);
    if(row.minuteCount>=perMinute)return deny((minute+1)*60000);
    row.minuteCount++;row.hourCount++;if(newSession)row.newSessions++;
    clients.set(key,row);
    return {allowed:true};
  }
  return {acquire};
}
module.exports={createChatRequestLimiter,clientAddress};
