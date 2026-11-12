// Interaction checks with a minimal DOM adapter; not a browser/layout test.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {createServer} = require('../tools/preview-app.cjs');
function prototype({search='?demo=1',fetcher,storage}={}) {
  class Element {
    constructor(){this.children=[];this.events={};this.attrs={};this.value='';this.className='';this.classList={add:name=>{this.className+=' '+name;}};}
    append(item){this.children.push(item);}
    insertAdjacentHTML(position,html){this.innerHTML+=html;}
    replaceChildren(){this.children=[];}
    addEventListener(event,handler){this.events[event]=handler;}
    querySelectorAll(){return this.children;}
    querySelector(){return this.button || (this.button=new Element());}
    setAttribute(key,value){this.attrs[key]=value;}
    removeAttribute(key){delete this.attrs[key];}
    focus(){} scrollIntoView(){} showModal(){} close(){}
    scrollTo(options){this.scrollTop=options.top;this.scrollBehavior=options.behavior;}
    get lastElementChild(){return this.children.at(-1);}
  }
  const elements = new Map();
  const context = vm.createContext({sessionStorage:storage,window:{location:{search}},URLSearchParams,fetch:fetcher,AbortController,setTimeout,clearTimeout,TextDecoder,Uint8Array,document:{title:'',documentElement:{style:{setProperty(){}},classList:{toggle(){}}},querySelectorAll:()=>[],querySelector:key=>{if(!elements.has(key))elements.set(key,new Element());return elements.get(key);},createElement:()=>new Element()},Intl,cancelAnimationFrame:()=>{},requestAnimationFrame:cb=>cb(),matchMedia:()=>({matches:false})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/lucide-icons.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/app.js'),'utf8'),context);
  const run = code=>vm.runInContext(code,context);
  function choose(label) {
    const group=elements.get('#messages').lastElementChild.lastElementChild;
    const button=group.children.find(b=>b.innerHTML.includes(`<span>${label}</span>`));
    assert.ok(button,`Button exists: ${label}`);assert.ok(!button.disabled);
    button.events.click();
  }
  function start(){elements.get('#messages').lastElementChild.lastElementChild.events.click();}
  return {run,choose,start,elements};
}
test('consecutive assistant replies merge, but calculations and user turns separate them',()=>{
  const p=prototype();
  p.run('messages.replaceChildren();bot("<p>Пояснение</p>");bot("<p>Вопрос</p>")');
  let rows=p.elements.get('#messages').children;
  assert.equal(rows.length,1);
  assert.ok(rows[0].innerHTML.includes('Пояснение</p><p>Вопрос'));
  p.run('bot(\'<div class="proposal">Расчёт</div>\');bot("<p>Обсуждение</p>");bot("<p>Уточнение</p>")');
  assert.equal(rows.length,3);
  p.run('user("Ответ");bot("<p>Следующий вопрос</p>")');
  assert.equal(rows.length,5);
  p.run('const loader=bot("Ожидание",true);removeMessage(loader);bot("<p>Продолжение</p>")');
  assert.equal(rows.length,5);
});

function toProposal(p, city='Другой город') {
  p.start();p.run('submit("Тестовый клиент")');
  p.choose(city);p.choose('Для игр');
  p.run('submit("Игры и работа")');p.choose('QHD · 1440p');p.run('submit("-1")');
  assert.equal(p.run('state.step'),'budget');
  assert.equal(p.run('state.partPreferences.gamingResolution'),'1440p');
  p.run('submit("500 000")');p.choose('На усмотрение специалиста');
  assert.equal(p.run('state.step'),'proposal');assert.equal(p.run('state.budget'),500000);
}

function chatStorage(){
  const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
}
test('reload restores conversation, draft and working CPU selection without replaying submissions',()=>{
  const storage=chatStorage();const p=prototype({storage});
  p.start();p.run('submit("Дима")');p.choose('Алматы');p.choose('Для офиса');
  p.run('submit("Word");submit("150000");input.value="Черновик";saveChat()');
  const next=prototype({storage});
  assert.equal(next.run('state.step'),'cpu');assert.equal(next.run('state.name'),'Дима');
  assert.equal(next.run('input.value'),'Черновик');assert.equal(next.run('state.budget'),150000);
  next.choose('AMD');assert.equal(next.run('state.step'),'proposal');
  assert.ok(next.run('transcript.some(row=>row.text==="Word")'));
});
test('reload keeps old quote as history but clears acceptance and requires recalculation',()=>{
  const storage=chatStorage();const p=prototype({storage});toProposal(p);
  p.run('state.step="payment";state.payment="Полная оплата";saveChat()');
  const next=prototype({storage});
  assert.equal(next.run('state.step'),'proposal');assert.equal(next.run('state.currentBuild'),null);
  assert.equal(next.run('state.payment'),undefined);
  next.choose('Обновить расчёт');assert.ok(next.run('state.currentBuild'));
});
test('snapshots isolate organization and mode, reset clears and malformed data is ignored',()=>{
  const storage=chatStorage();const p=prototype({storage});p.start();p.run('submit("Имя");saveChat()');
  assert.equal(prototype({storage,search:'?demo=1&organization_id=2'}).run('state.step'),'welcome');
  p.run('reset()');assert.equal(prototype({storage}).run('state.step'),'welcome');
  storage.setItem('corelab-chat-v1:1:demo','broken');assert.equal(prototype({storage}).run('state.step'),'welcome');
});
test('restored markup cannot execute handlers or unsafe links; safe product links survive',()=>{
  const p=prototype();
  const markup=p.run(`restoredMarkup('<img src=x onerror=alert(1)><p onclick="bad()">Hello</p><a href="javascript:bad()">bad</a><a href="https://example.com/a">product</a>')`);
  assert.doesNotMatch(markup,/onerror|onclick|javascript:|<img/);
  assert.match(markup,/href="https:\/\/example.com\/a"/);
});
test('interrupted request restores a retry draft without repeating a provider call',()=>{
  const storage=chatStorage();const p=prototype({storage});
  p.start();p.run('submit("Дима")');p.choose('Павлодар');p.choose('Для офиса');
  p.run('user("Photoshop");busy=true;input.value="";saveChat()');
  const next=prototype({storage});
  assert.equal(next.run('busy'),false);assert.equal(next.run('input.value'),'Photoshop');
  assert.ok(next.elements.get('#messages').children.some(row=>row.innerHTML?.includes('во время запроса')));
});
test('expired browser context starts clean and inaccessible storage does not break chat',()=>{
  const storage=chatStorage();const p=prototype({storage});p.start();p.run('saveChat()');
  const key='corelab-chat-v1:1:demo',saved=JSON.parse(storage.getItem(key));
  saved.savedAt=Date.now()-86400001;storage.setItem(key,JSON.stringify(saved));
  assert.equal(prototype({storage}).run('state.step'),'welcome');
  const blocked={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}};
  const next=prototype({storage:blocked});next.start();assert.equal(next.run('state.step'),'name');
});

test('pickup is chosen after consent and changed terms require confirmation before payment',async()=>{
  const option={code:'B',name:'Южный филиал',address:'Тестовая, 2',city:'Караганда',readyDate:'2026-11-05',total:490000,maxTransferBusinessDays:1};
  const original={city:'Караганда',budget:500000,total:490000,parts:[{skuOver:'1',category:'Процессоры',name:'CPU',quantity:1,price:490000,transferBusinessDays:1}],
    maxTransferBusinessDays:1,pickupOptions:[option],pickupBranch:null,expiresAt:new Date(Date.now()+86400000).toISOString()};
  const bodies=[];
  const p=prototype({search:'?no_ai=1',fetcher:async(url,init)=>{
    if(url.startsWith('api/status'))return {ok:true,json:async()=>({ready:false,cities:['Караганда']})};
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Тест'})};
    const body=JSON.parse(init.body);bodies.push(body);
    return {ok:true,json:async()=>({build:body.pickupBranch?{...original,total:495000,
      parts:original.parts.map(p=>({...p,price:495000})),pickupBranch:{...option,total:495000},
      pickupOptions:[{...option,total:495000}]}:original})};
  }});
  await new Promise(setImmediate);
  p.run(`Object.assign(state,${JSON.stringify({step:'proposal',city:'Караганда',purpose:'Для офиса',budget:500000,cpu:'AMD',currentBuild:original})})`);
  p.run('submit("Сборка устраивает")');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'pickup');
  assert.equal(p.run('state.currentBuild.pickupBranch'),null);
  p.choose('Южный филиал · Тестовая, 2 · готовность 05.11.2026 · 490\u00a0000 ₸');
  await new Promise(setImmediate);
  assert.equal(bodies.at(-1).pickupBranch,'B');
  assert.equal(bodies.at(-1).partPreferences.skus['Процессоры'],'1');
  assert.equal(p.run('state.step'),'pickup');
  p.choose('Подтвердить');
  assert.equal(p.run('state.step'),'payment');
  assert.equal(p.run('state.currentBuild.pickupBranch.code'),'B');
});

test('city buttons use the organization directory and do not substitute Almaty',async()=>{
  const p=prototype({search:'?no_ai=1',fetcher:async url=>({ok:true,json:async()=>url.startsWith('api/status')?
    {ready:false,cities:['Караганда']}:{short_name:'Тест'}})});
  p.start();p.run('submit("Клиент")');
  await new Promise(setImmediate);
  const buttons=p.elements.get('#messages').lastElementChild.lastElementChild.children;
  assert.equal(buttons.length,1);
  p.choose('Караганда');
  assert.equal(p.run('state.city'),'Караганда');
});

test('readiness checks branches outside Almaty and returns only configured cities',async()=>{
  const rows=['Процессоры','Материнские платы','Оперативная память','Блоки питания','Корпуса','Твердотельные диски (SSD)','Кулеры для процессоров'].map(category=>({category}));
  const server=createServer({chatService:{status:()=>({ready:false})},buildDataProvider:async()=>({
    status:()=>({buildEngineReady:true}),getBranches:()=>[{code:'K1',city:'Караганда'},{code:'K2',city:'Караганда'}],
    getBuildCandidates:(city,code)=>city==='Караганда'&&code==='K2'?rows:[],
  })});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const result=await (await fetch(`http://127.0.0.1:${server.address().port}/api/status`)).json();
    assert.equal(result.builderAvailable,true);
    assert.deepEqual(result.cities,['Караганда']);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('new build flow, budget validation and explicit consent',()=>{
  const p=prototype();toProposal(p);
  p.run('submit("Не согласен, замените корпус")');assert.equal(p.run('state.step'),'proposal');
  p.run('submit("всё устраивает, но поменяйте процессор")');assert.equal(p.run('state.step'),'proposal');
  p.run('submit("Сборка устраивает")');p.choose('Полная оплата');p.choose('Удалённая оплата картой');
  assert.equal(p.run('state.step'),'finished');assert.equal(p.run('state.method'),'Удалённая оплата картой');
});
test('installment automatically selects Kaspi and reset removes brief',()=>{
  const p=prototype();toProposal(p,'Алматы');p.run('submit("Согласна")');p.choose('В рассрочку');
  assert.equal(p.run('state.method'),'Рассрочка Kaspi');assert.equal(p.run('state.step'),'finished');
  p.run('reset()');assert.equal(p.run('state.step'),'welcome');assert.equal(p.run('state.name'),undefined);
});
test('full payment Kaspi branch and escaped name',()=>{
  const p=prototype();toProposal(p,'Павлодар');p.run('submit("согласен")');p.choose('Полная оплата');p.choose('Удалённая оплата Kaspi');
  assert.equal(p.run('state.method'),'Удалённая оплата Kaspi');
  p.run('reset()');p.start();p.run('submit("<img src=x onerror=alert(1)>")');
  const html=p.elements.get('#messages').lastElementChild.innerHTML;
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));
});
test('preview serves interface and denies repository files',async()=>{
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const target of ['/','/style.css','/mobile.css','/app.js','/lucide-icons.js'])assert.equal((await fetch(base+target)).status,200);
    for(const target of ['/data/p1-catalog.json','/.secrets/p1.credentials.json','/PROJECT.md'])assert.equal((await fetch(base+target)).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('AI asks clarification, proceeds only when ready, escapes response and keeps payment closed',async()=>{
  let turn=0;
  const p=prototype({search:'',fetcher:async(url,opts)=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One',primary_color:'#2563eb',logo_url:null})};
    if(url.startsWith('api/status'))return {json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:true})};
    if(url.startsWith('api/pc-build'))return {ok:true,json:async()=>({build:{city:'Астана',budget:500000,total:490000,overBudget:false,parts:[],maxTransferBusinessDays:0,assemblyCalendarDays:2,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),priceValidDays:1}})};
    const body=JSON.parse(opts.body);turn++;
    return {ok:true,json:async()=>({sessionId:'test-session',reply:'<img src=x> Уточним задачи.',tasksClear:turn>1,profile:{...body.profile,tasks:'CS2',...(body.selection||{})},buildsReady:false})};
  }});
  p.start();p.run('submit("Клиент")');await new Promise(setImmediate);p.choose('Астана');p.choose('Для игр');
  p.run('submit("Игры")');await new Promise(setImmediate);assert.equal(p.run('state.step'),'tasks');
  assert.ok(p.elements.get('#messages').lastElementChild.innerHTML.includes('&lt;img'));
  p.run('submit("CS2")');await new Promise(setImmediate);assert.equal(p.run('state.step'),'resolution');
  p.choose('Full HD · 1080p');assert.equal(p.run('state.step'),'budget');
  p.run('submit("500000")');p.choose('Intel');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'proposal');
  p.run('submit("Сборка устраивает")');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'proposal');assert.equal(p.run('state.method'),undefined);
});
test('requesting AM5 after a proposal sends the socket preference to one new build',async()=>{
  const builds=[];const chatBodies=[];
  const p=prototype({search:'',fetcher:async(url,opts)=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One'})};
    if(url.startsWith('api/status'))return {json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:true,builderAvailable:true})};
    if(url.startsWith('api/pc-build')){
      const body=JSON.parse(opts.body);builds.push(body);
      const socket=body.partPreferences?.platformPreference||'AM4';
      return {ok:true,json:async()=>({build:{city:'Алматы',budget:1200000,total:1100000,
        parts:[{category:'Процессоры',name:`CPU ${socket}`,skuOver:socket,quantity:1,price:100000,transferBusinessDays:0}],
        maxTransferBusinessDays:0,expiresAt:new Date(Date.now()+86400000).toISOString()}})};
    }
    const body=JSON.parse(opts.body);chatBodies.push(body);
    return {ok:true,json:async()=>({sessionId:'session',reply:'Условия изменены. Проверю комплектующие.',
      tasksClear:true,profile:{...body.profile,tasks:'Игры',...(body.selection||{}),cpu:'AMD'},
      action:{kind:body.stage==='discussion'?'rebuild':'answer',
        platformSocket:body.stage==='discussion'?'AM5':null,changeRequest:null},
      partPreferences:body.stage==='discussion'?
        {coolerType:null,skus:{},platformPreference:'AM5'}:body.partPreferences})};
  }});
  p.start();p.run('submit("Клиент")');
  await new Promise(setImmediate);p.choose('Алматы');p.choose('Для игр');p.run('submit("Игры")');await new Promise(setImmediate);p.choose('Пока не знаю');
  p.run('submit("1200000")');p.choose('AMD');
  for(let i=0;i<10&&p.run('busy');i++)await new Promise(setImmediate);
  assert.equal(builds.length,1);
  assert.equal(chatBodies.find(body=>body.stage==='initial_build').selection.budget,1200000);
  assert.ok(!chatBodies.some(body=>body.stage==='build_review'));
  p.run('submit("Подбери на AM5")');await new Promise(setImmediate);
  const followup=chatBodies.find(body=>body.stage==='discussion');
  assert.equal(followup.selection,undefined);
  assert.equal(followup.message,'Подбери на AM5');
  assert.equal(builds.length,2);
  assert.equal(builds[1].partPreferences.platformPreference,'AM5');
  assert.equal(p.run('state.currentBuild.parts[0].name'),'CPU AM5');
});
test('AI action routes a part replacement through the verified builder',async()=>{
  const builds=[];const chats=[];
  const p=prototype({search:'',fetcher:async(url,opts)=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One'})};
    if(url.startsWith('api/status'))return {json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:true,builderAvailable:true})};
    if(url.startsWith('api/pc-build')){
      const body=JSON.parse(opts.body);builds.push(body);
      return {ok:true,json:async()=>({build:{city:'Алматы',budget:500000,total:490000,
        parts:[],maxTransferBusinessDays:0,expiresAt:new Date(Date.now()+86400000).toISOString()}})};
    }
    const body=JSON.parse(opts.body);chats.push(body);
    return {ok:true,json:async()=>({sessionId:'session',reply:'Проверю замену',tasksClear:true,
      profile:{...body.profile,tasks:'Игры',...(body.selection||{})},
      partPreferences:body.partPreferences,
      action:{kind:body.stage==='discussion'?'change_part':'answer',platformSocket:null,
        changeRequest:body.stage==='discussion'?'Замените кулер на воздушный':null}})};
  }});
  p.start();p.run('submit("Клиент")');
  await new Promise(setImmediate);p.choose('Алматы');p.choose('Для игр');p.run('submit("Игры")');await new Promise(setImmediate);p.choose('Full HD · 1080p');
  p.run('submit("500000")');p.choose('AMD');await new Promise(setImmediate);
  p.run('submit("Замени кулер")');await new Promise(setImmediate);
  assert.equal(chats.findLast(body=>body.stage==='discussion').message,'Замени кулер');
  assert.equal(builds.at(-1).changeRequest,'Замените кулер на воздушный');
});
test('after a second build, a rejected part change is explained by AI instead of an article template',async()=>{
  const stages=[];let builds=0;
  const p=prototype({search:'',fetcher:async(url,opts)=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One'})};
    if(url.startsWith('api/status'))return {json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:true,builderAvailable:true})};
    if(url.startsWith('api/pc-build')){
      builds++;
      if(builds===2)return {ok:false,status:422,json:async()=>({error:'part_request_not_found'})};
      return {ok:true,json:async()=>({build:{city:'Алматы',budget:1200000,total:1100000,
        parts:[],maxTransferBusinessDays:0,expiresAt:new Date(Date.now()+86400000).toISOString()}})};
    }
    const body=JSON.parse(opts.body);stages.push(body.stage);
    return {ok:true,json:async()=>({sessionId:'session',reply:body.stage==='build_feedback'
      ?'Не удалось определить желаемую замену. Что хотите улучшить в работе ПК?':'Проверю изменение.',
      tasksClear:true,profile:body.profile||{city:'Алматы',purpose:'Для игр',tasks:'Игры',budget:1200000,cpu:'AMD'},
      action:{kind:body.stage==='build_feedback'?'answer':stages.filter(stage=>stage==='discussion').length===1?'rebuild':'change_part',
        platformSocket:null,changeRequest:stages.filter(stage=>stage==='discussion').length===2?'Замените процессор':null},
      partPreferences:body.partPreferences})};
  }});
  p.run("Object.assign(state,{step:'proposal',city:'Алматы',purpose:'Для игр',tasks:'Игры',budget:1200000,cpu:'AMD',sessionId:'session',aiSelectionSent:true,currentBuild:{total:1100000}})");
  p.run('state.buildCriteria=buildCriteriaKey()');
  p.run('submit("Пересчитай сборку")');
  for(let i=0;i<10&&p.run('busy');i++)await new Promise(setImmediate);
  p.run('submit("Хочу процессор мощнее")');
  for(let i=0;i<10&&p.run('busy');i++)await new Promise(setImmediate);
  assert.deepEqual(stages,['discussion','discussion','build_feedback']);
  assert.equal(builds,2);
  const messages=p.elements.get('#messages').children.map(item=>item.innerHTML).join(' ');
  assert.match(messages,/Что хотите улучшить в работе ПК/);
  assert.doesNotMatch(messages,/Укажите точное название или артикул/);
});
test('AI failure preserves the previous build and permits a retry',async()=>{
  let builds=0;
  const p=prototype({search:'',fetcher:async(url)=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One'})};
    if(url.startsWith('api/status'))return {json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:true,builderAvailable:true})};
    if(url.startsWith('api/pc-build')){builds++;throw Error('old build must not be recalculated');}
    return {ok:false,json:async()=>({error:'ai_unavailable'})};
  }});
  p.run("Object.assign(state,{step:'proposal',city:'Алматы',purpose:'Для игр',budget:1200000,cpu:'AMD',sessionId:'session',currentBuild:{total:1100000}})");
  p.run('submit("посчитай на AM5")');await new Promise(setImmediate);
  assert.equal(builds,0);
  assert.equal(p.run('state.currentBuild.total'),1100000);
  assert.equal(p.run('aiAvailable'),true);
});
test('proposal keeps a stable animation while consuming streamed progress',async()=>{
  let streamController;
  const stream=new ReadableStream({start(controller){streamController=controller;}});
  const p=prototype({search:'?no_ai=1',fetcher:async url=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One'})};
    if(url.startsWith('api/status'))return {json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:false,builderAvailable:true})};
    return new Response(stream,{headers:{'Content-Type':'application/x-ndjson'}});
  }});
  p.run("Object.assign(state,{step:'proposal',city:'Алматы',purpose:'Для игр',budget:1200000,cpu:'AMD'})");
  const pending=p.run('loadProposal()');
  streamController.enqueue(Buffer.from(JSON.stringify({type:'progress',phase:'compare',completed:2,total:4})+'\n'));
  await new Promise(setImmediate);
  assert.match(p.elements.get('#messages').lastElementChild.innerHTML,/pc-loading-scene/);
  assert.doesNotMatch(p.elements.get('#messages').lastElementChild.innerHTML,/2 из 4 процессоров/);
  assert.equal(p.elements.get('#conversation').scrollBehavior,'smooth');
  streamController.enqueue(Buffer.from(JSON.stringify({type:'result',status:200,payload:{build:{
    city:'Алматы',budget:1200000,total:1100000,parts:[],maxTransferBusinessDays:0,
    expiresAt:new Date(Date.now()+86400000).toISOString()}}})+'\n'));
  streamController.close();
  await pending;
  assert.equal(p.run('state.currentBuild.total'),1100000);
});
test('changed rule version requires a new proposal and a second explicit consent',async()=>{
  let version='v1';
  const p=prototype({search:'',fetcher:async(url,opts)=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One',logo_url:null})};
    if(url.startsWith('api/status'))return {json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:true})};
    if(url.startsWith('api/pc-build'))return {ok:true,json:async()=>({build:{city:'Алматы',budget:500000,total:490000,
      rulesVersion:version,pickupOptions:[{code:'ALP',name:'Филиал',city:'Алматы',address:'Адрес',total:490000,readyDate:'2026-11-05'}],parts:[{skuOver:'1',quantity:1,price:490000,transferBusinessDays:0,
        category:'Процессоры',name:'Verified CPU'}],maxTransferBusinessDays:0,
      expiresAt:new Date(Date.now()+86400000).toISOString()}})};
    const body=JSON.parse(opts.body);
    return {ok:true,json:async()=>({sessionId:'session',reply:'Готово',tasksClear:true,
      profile:{...body.profile,tasks:'CS2',...(body.selection||{})}})};
  }});
  p.start();p.run('submit("Клиент")');
  await new Promise(setImmediate);p.choose('Алматы');p.choose('Для игр');p.run('submit("CS2")');await new Promise(setImmediate);p.choose('Full HD · 1080p');
  p.run('submit("500000")');p.choose('AMD');await new Promise(setImmediate);
  assert.equal(p.run('state.currentBuild.rulesVersion'),'v1');
  version='v2';p.run('submit("Сборка устраивает")');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'proposal');
  assert.equal(p.run('state.currentBuild.rulesVersion'),'v2');
  p.run('submit("Сборка устраивает")');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'pickup');
});
test('without AI the customer still reaches a calculated build',async()=>{
  let chats=0,builds=0;
  const p=prototype({search:'?no_ai=1',fetcher:async url=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One',primary_color:'#2563eb',logo_url:null})};
    if(url.startsWith('api/status'))return {ok:true,json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:true,builderAvailable:true})};
    if(url.startsWith('api/chat')){chats++;throw new Error('Paid AI must not be called');}
    if(url.startsWith('api/pc-build')){builds++;return {ok:true,json:async()=>({build:{
      city:'Алматы',budget:500000,total:490000,parts:[],maxTransferBusinessDays:0,
      expiresAt:new Date(Date.now()+86400000).toISOString()}})};}
    throw new Error(`Unexpected request: ${url}`);
  }});
  p.start();p.run('submit("Клиент")');await new Promise(setImmediate);p.choose('Алматы');p.choose('Для офиса');
  p.run('submit("Документы")');assert.equal(p.run('state.step'),'budget');
  p.run('submit("500000")');p.choose('Intel');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'proposal');assert.equal(p.run('state.currentBuild.total'),490000);
  assert.equal(chats,0);assert.equal(builds,1);
});
test('unaffordable 4K keeps consent closed and explains the minimum cost',async()=>{
  const p=prototype({search:'?no_ai=1',fetcher:async(url)=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One'})};
    if(url.startsWith('api/status'))return {ok:true,json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:false,builderAvailable:true})};
    if(url.startsWith('api/pc-build'))return {ok:false,status:422,
      json:async()=>({error:'resolution_budget_unmet',resolution:'4K',
        minimumTotal:1206905,budgetLimit:945000})};
    throw Error(`Unexpected request: ${url}`);
  }});
  p.start();p.run('submit("Клиент")');
  await new Promise(setImmediate);p.choose('Алматы');p.choose('Для игр');p.run('submit("Cyberpunk 2077")');
  p.choose('4K · 2160p');p.run('submit("900000")');p.choose('AMD');
  await new Promise(setImmediate);
  assert.equal(p.run('state.currentBuild'),null);
  assert.match(p.elements.get('#messages').lastElementChild.innerHTML,/1\s*206\s*905/);
  p.run('submit("Сборка устраивает")');
  assert.equal(p.run('state.step'),'proposal');
});

test('customer part change updates the proposal and a rejected change keeps the last build',async()=>{
  const requests=[];
  const p=prototype({search:'?no_ai=1',fetcher:async(url,opts)=> {
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One'})};
    if(url.startsWith('api/status'))return {ok:true,json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:false,builderAvailable:true})};
    if(url.startsWith('api/pc-build')){
      const body=JSON.parse(opts.body);requests.push(body);
      if(body.changeRequest==='Замените кулер')
        return {ok:false,json:async()=>({error:'cooler_type_required'})};
      if(body.changeRequest==='Сделайте дешевле')
        return {ok:false,json:async()=>({error:'cheaper_category_required'})};
      return {ok:true,json:async()=>({partPreferences:body.changeRequest?
        {coolerType:'air',skus:{}}:{coolerType:null,skus:{}},
        build:{city:'Алматы',budget:500000,total:body.changeRequest?480000:490000,
          parts:[],maxTransferBusinessDays:0,
          expiresAt:new Date(Date.now()+86400000).toISOString()}})};
    }
    throw Error(`Unexpected request: ${url}`);
  }});
  p.start();p.run('submit("Клиент")');
  await new Promise(setImmediate);p.choose('Алматы');p.choose('Для офиса');p.run('submit("Документы")');
  p.run('submit("500000")');p.choose('AMD');await new Promise(setImmediate);
  assert.equal(p.run('state.currentBuild.total'),490000);
  p.run('submit("Замените СЖО на воздушный кулер")');await new Promise(setImmediate);
  assert.equal(requests.at(-1).changeRequest,'Замените СЖО на воздушный кулер');
  assert.equal(p.run('state.partPreferences.coolerType'),'air');
  assert.equal(p.run('state.currentBuild.total'),480000);
  p.run('submit("Хочу больше оперативной памяти")');await new Promise(setImmediate);
  assert.equal(requests.at(-1).changeRequest,'Хочу больше оперативной памяти');
  p.run('submit("Замените кулер")');await new Promise(setImmediate);
  assert.equal(p.run('state.currentBuild.total'),480000);
  assert.equal(p.run('state.partPreferences.coolerType'),'air');
  assert.equal(p.run('state.pendingCooler'),true);
  p.run('submit("воздушный")');await new Promise(setImmediate);
  assert.equal(requests.at(-1).changeRequest,'Замените кулер на воздушный');
  assert.equal(p.run('state.pendingCooler'),false);
  p.run('submit("Сделайте дешевле")');await new Promise(setImmediate);
  assert.equal(p.run('state.pendingCheaper'),true);
  p.run('submit("корпус")');await new Promise(setImmediate);
  assert.equal(requests.at(-1).changeRequest,'Поставьте дешевле корпус');
  assert.equal(p.run('state.pendingCheaper'),false);
});

test('AI failure preserves the task step instead of silently calculating without requirements',async()=>{
  let builds=0;
  const p=prototype({search:'',fetcher:async url=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One'})};
    if(url.startsWith('api/status'))return {ok:true,json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:true,builderAvailable:true})};
    if(url.startsWith('api/chat'))return {ok:false,json:async()=>({error:'ai_unavailable'})};
    if(url.startsWith('api/pc-build')){builds++;return {ok:true,json:async()=>({build:{
      city:'Алматы',budget:500000,total:480000,parts:[],maxTransferBusinessDays:0,
      expiresAt:new Date(Date.now()+86400000).toISOString()}})};}
    throw new Error(`Unexpected request: ${url}`);
  }});
  p.start();p.run('submit("Клиент")');await new Promise(setImmediate);p.choose('Алматы');p.choose('Для офиса');
  p.run('submit("Документы")');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'tasks');
  assert.equal(builds,0);
});

test('disabled AI status uses the local builder path',async()=>{
  let chats=0,builds=0;
  const p=prototype({search:'',fetcher:async url=>{
    if(url.startsWith('api/branding'))return {ok:true,json:async()=>({short_name:'Shop One'})};
    if(url.startsWith('api/status'))return {ok:true,json:async()=>({cities:['Алматы','Астана','Павлодар'],ready:false,builderAvailable:true})};
    if(url.startsWith('api/chat')){chats++;throw new Error('AI should stay disabled');}
    if(url.startsWith('api/pc-build')){builds++;return {ok:true,json:async()=>({build:{
      city:'Алматы',budget:500000,total:470000,parts:[],maxTransferBusinessDays:0,
      expiresAt:new Date(Date.now()+86400000).toISOString()}})};}
    throw new Error(`Unexpected request: ${url}`);
  }});
  await new Promise(setImmediate);
  p.start();p.run('submit("Клиент")');await new Promise(setImmediate);p.choose('Алматы');p.choose('Для офиса');
  p.run('submit("Документы")');p.run('submit("500000")');p.choose('AMD');await new Promise(setImmediate);
  assert.equal(p.run('state.currentBuild.total'),470000);
  assert.equal(chats,0);assert.equal(builds,1);
});
