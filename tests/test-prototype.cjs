// Interaction checks with a minimal DOM adapter; not a browser/layout test.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function prototype({search='?demo=1',fetcher}={}) {
  class Element {
    constructor(){this.children=[];this.events={};this.attrs={};this.value='';this.className='';this.classList={add:name=>{this.className+=' '+name;}};}
    append(item){this.children.push(item);}
    replaceChildren(){this.children=[];}
    addEventListener(event,handler){this.events[event]=handler;}
    querySelectorAll(){return this.children;}
    querySelector(){return this.button || (this.button=new Element());}
    setAttribute(key,value){this.attrs[key]=value;}
    removeAttribute(key){delete this.attrs[key];}
    focus(){} scrollIntoView(){} showModal(){} close(){}
    get lastElementChild(){return this.children.at(-1);}
  }
  const elements = new Map();
  const context = vm.createContext({window:{location:{search}},URLSearchParams,fetch:fetcher,AbortController,setTimeout,clearTimeout,document:{querySelector:key=>{if(!elements.has(key))elements.set(key,new Element());return elements.get(key);},createElement:()=>new Element()},Intl,requestAnimationFrame:cb=>cb(),matchMedia:()=>({matches:false})});
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
function toProposal(p, city='Другой город') {
  p.start();p.run('submit("Тестовый клиент")');
  const buttons=p.elements.get('#messages').lastElementChild.lastElementChild.children;
  assert.equal(buttons[1].disabled,true);assert.equal(buttons[2].disabled,true);
  p.choose('Подбор и сборка нового системного блока');p.choose(city);p.choose('Для игр');
  p.run('submit("Игры и работа")');p.run('submit("-1")');
  assert.equal(p.run('state.step'),'budget');
  p.run('submit("500 000")');p.choose('На усмотрение специалиста');
  assert.equal(p.run('state.step'),'proposal');assert.equal(p.run('state.budget'),500000);
}
test('new build flow, disabled directions, budget validation and explicit consent',()=>{
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
  for(const target of ['/','/style.css','/mobile.css','/app.js'])assert.equal((await fetch('http://127.0.0.1:8000'+target)).status,200);
  for(const target of ['/data/p1-catalog.json','/.secrets/p1.credentials.json','/PROJECT.md'])assert.equal((await fetch('http://127.0.0.1:8000'+target)).status,404);
});
test('AI asks clarification, proceeds only when ready, escapes response and keeps payment closed',async()=>{
  let turn=0;
  const p=prototype({search:'',fetcher:async(url,opts)=>{
    if(url==='/api/status')return {json:async()=>({ready:true})};
    if(url==='/api/pc-build')return {ok:true,json:async()=>({build:{city:'Астана',budget:500000,total:490000,overBudget:false,parts:[],maxTransferBusinessDays:0,assemblyCalendarDays:2,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),priceValidDays:1}})};
    const body=JSON.parse(opts.body);turn++;
    return {ok:true,json:async()=>({sessionId:'test-session',reply:'<img src=x> Уточним задачи.',tasksClear:turn>1,profile:{...body.profile,tasks:'CS2',...(body.selection||{})},buildsReady:false})};
  }});
  p.start();p.run('submit("Клиент")');p.choose('Подбор и сборка нового системного блока');p.choose('Астана');p.choose('Для игр');
  p.run('submit("Игры")');await new Promise(setImmediate);assert.equal(p.run('state.step'),'tasks');
  assert.ok(p.elements.get('#messages').lastElementChild.innerHTML.includes('&lt;img'));
  p.run('submit("CS2")');await new Promise(setImmediate);assert.equal(p.run('state.step'),'budget');
  p.run('submit("500000")');p.choose('Intel');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'proposal');
  p.run('submit("Сборка устраивает")');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'payment');assert.equal(p.run('state.method'),undefined);
});
test('AI connection failure leaves task step and permits retry',async()=>{
  const p=prototype({search:'',fetcher:async(url)=>url==='/api/status'?{json:async()=>({ready:false})}:{ok:false,json:async()=>({error:'ai_not_configured'})}});
  p.start();p.run('submit("Клиент")');p.choose('Подбор и сборка нового системного блока');p.choose('Алматы');p.choose('Для офиса');
  p.run('submit("Документы")');await new Promise(setImmediate);
  assert.equal(p.run('state.step'),'tasks');assert.equal(p.elements.get('#answer').value,'Документы');assert.equal(p.elements.get('#answer').disabled,false);
});
