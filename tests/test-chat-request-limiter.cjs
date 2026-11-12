const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createChatRequestLimiter,clientAddress}=require('../tools/chat-request-limiter.cjs');
const {createServer}=require('../tools/preview-app.cjs');
const {AIError,callCorelabAI}=require('../tools/corelab-ai.cjs');

test('new sessions cannot bypass client rate and creation limits',()=>{
  let now=1700000000000;
  const limiter=createChatRequestLimiter({now:()=>now,perMinute:2,newSessionsPerHour:3});
  assert.equal(limiter.acquire('client',{newSession:true}).allowed,true);
  assert.equal(limiter.acquire('client',{newSession:true}).allowed,true);
  assert.equal(limiter.acquire('client',{newSession:true}).allowed,false);
  now+=60000;
  assert.equal(limiter.acquire('client',{newSession:true}).allowed,true);
  assert.equal(limiter.acquire('client',{newSession:true}).allowed,false);
  assert.equal(limiter.acquire('other',{newSession:true}).allowed,true);
  now+=3600000;
  assert.equal(limiter.acquire('client',{newSession:true}).allowed,true);
});

test('hourly totals and bounded memory do not evict active limits',()=>{
  let now=1700000000000;
  const limiter=createChatRequestLimiter({now:()=>now,perMinute:10,perHour:2,maxClients:1});
  limiter.acquire('a');now+=60000;limiter.acquire('a');
  assert.equal(limiter.acquire('a').allowed,false);
  assert.equal(limiter.acquire('b').allowed,false);
  now+=3600000;
  assert.equal(limiter.acquire('b').allowed,true);
});

test('spoofed and stale forwarded identities cannot change the client address',()=>{
  const now=1700000000000,secret='private-proxy-key';
  const req={headers:{'x-forwarded-for':'198.51.100.99','x-corelab-client-address':'198.51.100.42',
    'x-corelab-client-timestamp':String(now),'x-corelab-client-signature':'0'.repeat(64)},socket:{remoteAddress:'::ffff:127.0.0.1'}};
  assert.equal(clientAddress(req,secret,()=>now),'127.0.0.1');
  req.headers['x-corelab-client-signature']=crypto.createHmac('sha256',secret).update(`${now}:198.51.100.42`).digest('hex');
  assert.equal(clientAddress(req,secret,()=>now),'198.51.100.42');
  assert.equal(clientAddress(req,secret,()=>now+61000),'127.0.0.1');
});

test('HTTP rejects repeated fresh sessions before calling chat service',async t=>{
  let calls=0;
  const server=createServer({chatService:{chat:async()=>({sessionId:String(++calls)})},
    chatRequestLimiter:createChatRequestLimiter({perMinute:2})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  for(let i=0;i<3;i++){
    const response=await fetch(base+'/api/chat',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',
      'X-Forwarded-For':`198.51.100.${i}`,'X-CoreLab-Client-Address':`198.51.100.${i}`},
      body:JSON.stringify({message:'test',requestId:String(i)})});
    assert.equal(response.status,i===2?429:200);
    if(i===2)assert.ok(Number(response.headers.get('retry-after'))>0);
  }
  assert.equal(calls,2);
});

test('organization Retry-After reaches the browser and cannot inject a header',async t=>{
  const server=createServer({chatService:{chat:async()=>{throw new AIError('ai_rate_limited',429,3600);}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/chat',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,429);
  assert.equal(response.headers.get('retry-after'),'3600');
  assert.equal(new AIError('x',429,'1\r\nX-Injected: yes').retryAfter,undefined);
});

test('internal organization quota returns a bounded retry delay',async t=>{
  const savedBase=process.env.CORELAB_INTERNAL_API,savedSecret=process.env.SESSION_SECRET;
  process.env.CORELAB_INTERNAL_API='http://internal';process.env.SESSION_SECRET='test';
  t.after(()=>{if(savedBase===undefined)delete process.env.CORELAB_INTERNAL_API;else process.env.CORELAB_INTERNAL_API=savedBase;
    if(savedSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=savedSecret;});
  await assert.rejects(callCorelabAI({provider:'corelab',organizationId:1},{},async()=>({ok:false,status:429,
    headers:{get:()=> '3600'}})),error=>error.code==='ai_rate_limited'&&error.retryAfter===3600);
});
