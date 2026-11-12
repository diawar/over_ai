/* AI dialogue uses the local server. A ready build/payment requires verified product data. */
'use strict';
const icon = globalThis.corelabIcon;
const $ = selector => document.querySelector(selector);
const messages = $('#messages');
const form = $('#composer');
const input = $('#answer');
let state;
let transcript=[];
let restoringChat=false;
let activeChoice=null;
let generation=0;
let busy=false;
let aiController;
const demoMode=new URLSearchParams(window.location.search).get('demo')==='1';
const noAiMode=new URLSearchParams(window.location.search).get('no_ai')==='1';
let aiAvailable=!noAiMode;
let organizationCities=null;
let statusPromise;
const money = value => new Intl.NumberFormat('ru-RU').format(value) + ' ₸';
const stages = ['Знакомство', 'Ваши задачи', 'Пожелания', 'Обсуждение сборки', 'Получение и оплата'];
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const organizationId = (()=>{const value=Number(new URLSearchParams(window.location.search).get('organization_id')||1);return Number.isSafeInteger(value)&&value>0?value:1;})();
const apiUrl = path => `${path}?organization_id=${organizationId}`;
let organizationName = 'Магазин';
let welcomeHeadline = ['Ваши задачи.', 'Ваш характер.', 'Ваш компьютер.'];
function welcomeHeading(){return welcomeHeadline.map((line,index)=>index===2?`<em>${escapeHTML(line)}</em>`:escapeHTML(line)).join('<br>');}
async function loadBranding(){
  try{
    const response=await fetch(apiUrl('api/branding'), {cache:'no-store'});
    if(!response.ok)throw new Error('branding_unavailable');
    const branding=await response.json();
    organizationName=(branding.short_name||branding.name||'Магазин').trim();
    if(Array.isArray(branding.welcome_headline)&&branding.welcome_headline.length===3&&branding.welcome_headline.every(line=>typeof line==='string'&&line.trim())) welcomeHeadline=branding.welcome_headline;
    const heading=$('#welcome-heading');
    if(heading)heading.innerHTML=welcomeHeading();
    document.title=`${organizationName} — подбор компьютера`;
    const color=/^#[0-9a-fA-F]{6}$/.test(branding.primary_color)?branding.primary_color:'#ff416c';
    if(globalThis.corelabTheme)globalThis.corelabTheme.apply(color);
    else document.documentElement.style.setProperty('--accent',color);
    document.querySelectorAll('.brand-name').forEach(node=>{node.textContent=organizationName;});
    document.querySelectorAll('.assistant-name').forEach(node=>{node.textContent=organizationName;});
    const logo=branding.logo_url?apiUrl('api/branding/logo'):null;
    document.querySelectorAll('.brand-logo').forEach(node=>{node.hidden=!logo;if(logo)node.src=logo;});
    document.documentElement.classList.toggle('has-brand-logo',!!logo);
    if(logo){document.documentElement.style.setProperty('--brand-logo',`url("${logo}")`);$('#app-icon').href=logo;}
    $('.brand').setAttribute('aria-label',`${organizationName} — главная`);
  }catch{
    document.querySelectorAll('.brand-name').forEach(node=>{node.textContent=organizationName;});
  }finally{globalThis.corelabTheme?.ready();}
}

function refreshBrief() {
  const stage = {welcome:0,name:0,need:1,city:1,purpose:1,tasks:1,resolution:2,budget:2,cpu:2,proposal:3,pickup:4,payment:4,method:4,finished:4}[state.step];
  $('#progress').innerHTML = stages.map((label,index) => `<div class="step ${index===stage?'active':index<stage?'done':''}" ${index===stage?'aria-current="step"':''}><b>${index<stage?icon('check'):String(index+1).padStart(2,'0')}</b>${label}</div>`).join('');
  const entries = [['Имя',state.name],['Город',state.city],['Задачи',state.purpose],['Разрешение',state.partPreferences?.gamingResolution],['Бюджет',state.budget ? money(state.budget) : ''],['Процессор',state.cpu],['Платформа',state.partPreferences?.platformPreference],['Видеокарта от',state.graphicsPreference],['Получение',state.currentBuild?.pickupBranch?.name],['Адрес',state.currentBuild?.pickupBranch?.address],['Оплата',state.method]];
  $('#brief').innerHTML = entries.filter(([,value])=>value).map(([label,value])=>`<div><dt>${label}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
  saveChat();
}

function chatStorageKey(){return `corelab-chat-v1:${organizationId}:${demoMode?'demo':noAiMode?'local':'ai'}`;}
function saveChat(){
  if(restoringChat||!state)return;
  try{
    const snapshot=JSON.stringify({version:1,savedAt:Date.now(),state,transcript:transcript.slice(-160),
      choice:activeChoice,draft:input.value||(busy?[...transcript].reverse().find(row=>row.role==='user')?.text:'')||'',interrupted:busy});
    if(snapshot.length<1500000)sessionStorage.setItem(chatStorageKey(),snapshot);
  }catch{}
}
function readChat(){
  try{
    const raw=sessionStorage.getItem(chatStorageKey());if(!raw||raw.length>1500000)return null;
    const saved=JSON.parse(raw);
    if(saved.version!==1||!Number.isFinite(saved.savedAt)||Date.now()-saved.savedAt>86400000||saved.savedAt>Date.now()||
       !Array.isArray(saved.transcript)||saved.transcript.length>160||
       !['name','city','purpose','tasks','resolution','budget','cpu','proposal','pickup','payment','method','finished'].includes(saved.state?.step))return null;
    return saved;
  }catch{return null;}
}
// Stored markup is untrusted: keep formatting only, never scripts, attributes or controls.
function restoredMarkup(html){
  const allowed=new Set(['p','br','strong','em','b','small','div','span','h1','h2','h3','ul','li','a']);
  return String(html).split(/(<[^>]*>)/g).map(token=>{
    if(token.startsWith('<')){
      const match=/^<(\/?)\s*([a-z][a-z0-9]*)\b[^>]*>$/i.exec(token);
      if(!match||!allowed.has(match[2].toLowerCase()))return '';
      const tag=match[2].toLowerCase();
      if(match[1])return `</${tag}>`;
      let attributes='';
      const classMatch=/\bclass="([^"]*)"/i.exec(token);
      const classes=(classMatch?.[1]||'').split(/\s+/).filter(value=>
        ['proposal','part','total','note','muted','budget-alert','build-advantages','demo-label'].includes(value));
      if(classes.length)attributes+=` class="${classes.join(' ')}"`;
      const href=/\bhref="([^"]*)"/i.exec(token)?.[1];
      if(tag==='a'&&href&&/^https:\/\//i.test(href))attributes+=` href="${escapeHTML(href.replace(/&amp;/g,'&'))}" target="_blank" rel="noopener noreferrer"`;
      return `<${tag}${attributes}>`;
    }
    return token.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }).join('');
}
function restoreChat(saved){
  if(!saved)return;
  restoringChat=true;
  state=saved.state;transcript=saved.transcript.filter(row=>row&&
    (row.role==='user'&&typeof row.text==='string'||row.role==='assistant'&&typeof row.html==='string'));
  if(['city','purpose','cpu','resolution'].includes(state.step)&&typeof saved.choice?.question==='string'){
    const last=transcript.at(-1),suffix=`<p>${saved.choice.question}</p>`;
    if(last?.role==='assistant'&&last.html.endsWith(suffix)){
      last.html=last.html.slice(0,-suffix.length);if(!last.html)transcript.pop();
    }
  }
  activeChoice=null;messages.replaceChildren();
  for(const row of transcript){if(row.role==='user')user(row.text);else bot(restoredMarkup(row.html));}
  if(Date.now()-saved.savedAt>=3600000){state.sessionId=null;state.aiSelectionSent=false;}
  const step=state.step;
  // A browser snapshot is a transcript, not proof of current prices or consent.
  if(['proposal','pickup','payment','method','finished'].includes(step)){
    state.step='proposal';state.currentBuild=null;delete state.payment;delete state.method;
    choices('Переписка восстановлена. Проверим актуальные цены и наличие?', ['Обновить расчёт'],()=>{
      if(demoMode)showProposal();else void loadProposal();
    });
    textMode('Уточнить пожелания…','Перед согласованием сборки обновите расчёт.');
  }else if(step==='city')askCity();
  else if(step==='purpose')choices('Для каких задач Вам нужен компьютер?', ['Для игр','Для офиса','Для работы и творчества'],choosePurpose);
  else if(step==='cpu')choices('Какого производителя процессора Вы предпочитаете?', ['AMD','Intel','На усмотрение специалиста'],chooseCpu);
  else if(step==='resolution')askResolution();
  else if(step==='budget')textMode('Введите сумму в ₸','Например, 500 000 ₸',true);
  else if(step==='name')textMode('Ваше имя','Введите имя, как Вам удобно');
  else textMode('Напишите сообщение…','Продолжите обсуждение Ваших задач.');
  if(saved.interrupted)bot('<p>Страница была обновлена во время запроса. При необходимости отправьте сообщение повторно.</p>');
  input.value=typeof saved.draft==='string'?saved.draft.slice(0,2000):'';
  restoringChat=false;refreshBrief();scrollLatest();
}
function buildCriteriaKey(){return JSON.stringify({city:state.city,purpose:state.purpose,tasks:state.tasks||'',budget:state.budget||null,cpu:state.cpu||null,graphicsPreference:state.graphicsPreference||null,partPreferences:state.partPreferences||null});}
function isPartChange(text){return /замен|поменя|постав|установ|добав|дешев|подешев|эконом|сниз.{0,15}(?:цен|стоим)|уменьш.{0,15}(?:цен|стоим)|воздушн|сжо|жидкостн|тише|тихий|бесшумн|(?:больш|увелич).{0,25}(?:памят|озу|ram)|(?:памят|озу|ram).{0,25}(?:больш|увелич)|(?:\d{1,3}\s*(?:гб|gb).{0,25}(?:памят|озу|ram)|(?:памят|озу|ram).{0,25}\d{1,3}\s*(?:гб|gb))|(?:хочу|нужн).{0,50}(?:кулер|процессор|видеокарт|корпус|памят|озу|ram|ssd|hdd|жестк|вентилятор|блок питан)/i.test(text);}
function isPartCategory(text){return /процессор|материнск|плат[ау]|памят|озу|видеокарт|\bgpu\b|\brtx\b|\bssd\b|\bhdd\b|диск|блок питан|корпус|кулер|охлажден|сжо|вентилятор/i.test(text);}
let scrollFrame;
function scrollLatest(smooth=false) {
  const conversation=$('#conversation');
  cancelAnimationFrame(scrollFrame);
  scrollFrame=requestAnimationFrame(()=>{
    const reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    conversation.scrollTo({top:conversation.scrollHeight,behavior:smooth&&!reducedMotion?'smooth':'instant'});
  });
}
function bot(html, pending=false) {
  if(!pending&&!restoringChat)transcript.push({role:'assistant',html});
  const separate=html.startsWith('<div class="proposal">');
  const previous=messages.lastElementChild;
  if(!pending&&!separate&&previous?.className==='message assistant'&&!previous.separateReply){
    previous.insertAdjacentHTML('beforeend',html);
    scrollLatest();
    return previous;
  }
  const box = document.createElement('article');
  box.separateReply=separate;
  box.className = `message assistant${pending?' is-pending':''}`;
  box.innerHTML = `<div class="assistant-label"><span class="assistant-icon">${icon('sparkles')}</span><span class="assistant-name">${escapeHTML(organizationName)}</span><span class="assistant-divider" aria-hidden="true">·</span><span class="assistant-role">${aiAvailable?'AI-помощник':'Помощник'}</span></div>${html}`;
  messages.append(box);
  scrollLatest(pending);
  return box;
}
function user(text) {
  if(!restoringChat)transcript.push({role:'user',text});
  const box = document.createElement('article');
  box.className = 'message user';
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  box.append(paragraph);
  messages.append(box);
}
function removeMessage(box) {
  if(typeof box.remove==='function'){box.remove();return;}
  const index=Array.from(messages.children||[]).indexOf(box);
  if(index>=0)messages.children.splice(index,1);
}
function textMode(placeholder, hint, numeric = false, preserveDraft = false, focusInput = true) {
  form.hidden = false;
  if(!preserveDraft)input.value = '';
  input.placeholder = placeholder;
  input.inputMode = numeric ? 'numeric' : 'text';
  input.maxLength = numeric ? 14 : 500;
  $('#input-hint').textContent = hint;
  if(focusInput&&!busy)input.focus({preventScroll:true});
}
function noInput(hint = 'Выберите подходящий вариант выше') {
  form.hidden = true;
  $('#input-hint').textContent = hint;
}
function askBudget(preface='') {
  state.step='budget';
  bot(preface+'<p>На какой бюджет Вы рассчитываете?</p><p class="muted">Укажите сумму в тенге только на системный блок.</p>');
  textMode('Введите сумму в ₸','Например, 500 000 ₸',true);
}
function askResolution(preface=''){
  if(state.purpose!=='Для игр'&&!state.partPreferences?.workloadProfile?.tasks?.some(task=>task.application==='gaming')){askBudget(preface);return;}
  state.step='resolution';
  const options={'Full HD · 1080p':'1080p','QHD · 1440p':'1440p','4K · 2160p':'4K','Пока не знаю':'unknown'};
  choices('В каком разрешении планируете играть?', Object.keys(options),label=>{
    state.partPreferences={...(state.partPreferences||{coolerType:null,skus:{}}),gamingResolution:options[label]};
    askBudget();
  },true,preface);
}
function pcAssemblyLoader(label='Подбираем комплектующие') {
  return `<div class="pc-loading" role="status" aria-label="${escapeHTML(label)}">
    <span class="sr-only">${escapeHTML(label)}. Пожалуйста, подождите.</span>
    <div class="pc-loading-scene" aria-hidden="true">
      <span class="pc-loading-case">${icon('pc-case')}</span>
      ${['cpu','memory-stick','gpu','hard-drive','fan'].map((name,index)=>`<span class="pc-loading-part pc-loading-part-${index}"><span>${icon(name)}</span></span>`).join('')}
    </div>
  </div>`;
}
async function aiTurn(message, selection, stageOverride=null) {
  if(busy)return;
  if(state.step==='proposal'&&!state.aiSelectionSent&&!selection)
    selection={budget:state.budget,cpu:state.cpu};
  const currentGeneration=generation;
  busy=true;input.readOnly=true;form.querySelector('button').disabled=true;
  $('#input-hint').textContent='AI-помощник отвечает…';
  const pending=bot(pcAssemblyLoader(state.step==='tasks'?'Готовим ответ':'Подбираем комплектующие'),true);
  const controller=new AbortController();aiController=controller;
  const timer=setTimeout(()=>controller.abort(),140000);
  try{
    const request=state.pendingAI?.message===message?state.pendingAI:{
      requestId:globalThis.crypto?.getRandomValues?Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join(''):undefined,
      sessionId:state.sessionId,stage:stageOverride||(state.step==='tasks'?'tasks':'discussion'),message,
      profile:{city:state.city,purpose:state.purpose,tasks:state.tasks||'',budget:state.budget||null,cpu:state.cpu||null,graphicsPreference:state.graphicsPreference||null},
      partPreferences:state.partPreferences||null,selection};
    state.pendingAI=request;stageOverride=request.stage;selection=request.selection;saveChat();
    const response=await fetch(apiUrl('api/chat'),{
      method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
      body:JSON.stringify(request)
    });
    const result=await response.json();
    if(currentGeneration!==generation)return;
    if(!response.ok){showDialogueConnection(false,result.error==='ai_rate_limited'?'Лимит запросов':'Диалог недоступен');if(result.error!=='request_in_progress')state.pendingAI=null;throw new Error(result.error||'ai_unavailable');}
    showDialogueConnection(true);
    state.pendingAI=null;
    removeMessage(pending);
    state.sessionId=result.sessionId;
    if(selection)state.aiSelectionSent=true;
    Object.assign(state,result.profile);
    if(result.partPreferences)state.partPreferences=result.partPreferences;
    const replyHtml=`<p>${escapeHTML(result.reply).replace(/\n/g,'<br>')}</p>`;
    const advanceFromTasks=state.step==='tasks'&&result.tasksClear;
    if(!advanceFromTasks&&!((stageOverride==='initial_build'||state.step==='proposal')&&
         ['rebuild','change_part'].includes(result.action?.kind)))
      bot(replyHtml);
    if(advanceFromTasks){askResolution(replyHtml);}
    else textMode('Напишите сообщение…',state.step==='tasks'?'Расскажите о Ваших задачах':'Можно уточнить задачи или изменить пожелания. Пересчитаю состав после ответа.',false,true);
    refreshBrief();
    if(stageOverride==='initial_build'){
      if(result.action?.kind!=='clarify')await loadProposal(currentGeneration);
    }else if(state.step==='proposal'&&(
      result.action?.kind==='rebuild'||result.action?.kind==='change_part'||
      buildCriteriaKey()!==state.buildCriteria))
      await loadProposal(currentGeneration,result.action?.kind==='change_part'?result.action.changeRequest:null,message);
  }catch(error){
    if(currentGeneration!==generation)return;
    if(error.name==='AbortError'||error instanceof TypeError)showDialogueConnection(false,'Нет ответа');
    removeMessage(pending);
    if(error.message==='request_interrupted'||error.message==='request_in_progress'||
       (state.pendingAI&&(error.name==='AbortError'||error instanceof TypeError))){
      bot('<p>Предыдущий запрос был прерван или ещё обрабатывается. Автоматически повторно к AI его не отправляю. Попробуйте продолжить позже.</p>');
      textMode('Напишите сообщение…','Ваши пожелания сохранены.',false,true);
      if(!input.value)input.value=message;
      return;
    }
    if(['ai_not_configured','configuration_invalid','unsupported_provider','ai_auth_failed'].includes(error.message))
      aiAvailable=false;
    if(error.message==='session_expired'){state.sessionId=null;state.aiSelectionSent=false;}
    const descriptions={ai_invalid_response:'AI вернул некорректный ответ. Ваше сообщение сохранено — попробуйте отправить его повторно.',ai_not_configured:'AI выключен или не настроен на сервере. Обратитесь к администратору.',configuration_invalid:'Настройки AI на сервере требуют исправления.',unsupported_provider:'Этот провайдер пока не подключён.',ai_auth_failed:'Не удалось авторизоваться у провайдера AI. Проверьте серверный ключ.',ai_quota_exceeded:'AI сейчас недоступен. Обратитесь к консультанту магазина.',ai_timeout:'AI не успел ответить. Ваше сообщение сохранено — попробуйте отправить его ещё раз.',ai_rate_limited:'Достигнут лимит запросов к AI. Попробуйте позже.',request_in_progress:'Предыдущий запрос ещё обрабатывается. Попробуйте через несколько секунд.',session_expired:'Сессия завершилась. Начните диалог заново.',conversation_limit:'Достигнут лимит этого диалога. Начните новый.',ai_refusal:'Не удалось обработать этот запрос. Попробуйте переформулировать его.'};
    bot(`<p>${descriptions[error.message]||'Не удалось получить ответ AI. Сообщение можно отправить повторно.'}</p>`);
    textMode('Напишите сообщение…','Ответ не получен. Можно отправить сообщение повторно.',false,true);
    if(!input.value)input.value=message;
    if(state.step==='tasks'||stageOverride==='initial_build')return;
    if(state.step==='proposal'&&stageOverride!=='initial_build')
      bot('<p class="muted">Пожелание не применено. Предыдущее предложение остаётся без изменений.</p>');
  }finally{
    clearTimeout(timer);
    if(currentGeneration===generation){busy=false;input.readOnly=false;form.querySelector('button').disabled=false;input.focus({preventScroll:true});}
  }
}
async function explainFailedChange(requestGeneration,message){
  if(!aiAvailable||!state.sessionId||requestGeneration!==generation)return false;
  const pending=bot(pcAssemblyLoader('Проверяем Ваше пожелание'),true);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),140000);
  try{
    const response=await fetch(apiUrl('api/chat'),{method:'POST',headers:{'Content-Type':'application/json'},
      signal:controller.signal,
      body:JSON.stringify({sessionId:state.sessionId,stage:'build_feedback',message,
        partPreferences:state.partPreferences||null})});
    const result=await response.json();
    if(requestGeneration!==generation)return true;
    removeMessage(pending);
    if(!response.ok||!result.reply)return false;
    bot(`<p>${escapeHTML(result.reply).replace(/\n/g,'<br>')}</p><p class="muted">Предыдущее предложение остаётся без изменений.</p>`);
    textMode('Уточните пожелание…','Расскажите, какого результата Вы хотите добиться.');
    return true;
  }catch{
    if(requestGeneration===generation)removeMessage(pending);
    return false;
  }finally{clearTimeout(timer);}
}
async function readBuildResponse(response,onProgress=()=>{}){
  if(!response.headers?.get('content-type')?.includes('application/x-ndjson'))
    return {status:response.status??(response.ok?200:422),data:await response.json()};
  if(!response.body?.getReader)throw new Error('invalid_build_response');
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let buffer='';let final=null;
  while(true){
    const {done,value}=await reader.read();
    buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});
    const lines=buffer.split('\n');buffer=lines.pop();
    for(const line of lines){
      if(!line.trim())continue;
      const event=JSON.parse(line);
      if(event.type==='progress')onProgress(event);
      if(event.type==='result')final=event;
    }
    if(done)break;
  }
  if(!final||!Number.isInteger(final.status))throw new Error('invalid_build_response');
  return {status:final.status,data:final.payload};
}
async function loadProposal(requestGeneration=generation,changeRequest=null,originalMessage=null) {
  if(!state.budget||!state.cpu||!state.city||!state.purpose)return;
  const criteria=buildCriteriaKey();
  const waiting=bot(pcAssemblyLoader(),true);
  const controller=new AbortController();
  let timedOut=false;
  const requestTimer=setTimeout(()=>{timedOut=true;controller.abort();},90000);
  try{
    const response=await fetch(apiUrl('api/pc-build'),{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/x-ndjson'},
      signal:controller.signal,
      body:JSON.stringify({sessionId:state.sessionId,city:state.city,purpose:state.purpose,budget:state.budget,cpu:state.cpu,tasks:state.tasks||'',
        graphicsPreference:state.graphicsPreference||null,partPreferences:state.partPreferences||null,
        ...(changeRequest?{changeRequest}:{})})});
    const {status,data:result}=await readBuildResponse(response);
    if(requestGeneration!==generation){removeMessage(waiting);return;}
    if(status>=400){
      removeMessage(waiting);
      if(['build_queue_full','build_timeout'].includes(result.error)){
        bot(result.error==='build_queue_full'
          ? '<p>Сейчас выполняется много расчётов. Попробуйте повторить подбор немного позже.</p>'
          : '<p>Расчёт не успел завершиться. Попробуйте повторить подбор.</p>');
        textMode('Повторить подбор…','Ваши пожелания сохранены.');
        return;
      }
      if(changeRequest){
        if(await explainFailedChange(requestGeneration,originalMessage||changeRequest))return;
        state.pendingCheaper=result.error==='cheaper_category_required';
        state.pendingCooler=result.error==='cooler_type_required';
        const messages={
          cooler_type_required:'Какое охлаждение Вы хотите вместо текущего: воздушный кулер или СЖО? Модель указывать не обязательно.',
          cheaper_category_required:'Какую комплектующую хотите заменить на более дешёвую? Например, видеокарту, SSD или корпус.',
          cheaper_build_unavailable:'Не удалось повторно проверить исходную сборку для сравнения цен. Попробуйте обновить предложение.',
          cheaper_part_not_in_build:'Этой комплектующей нет в текущей сборке. Укажите другую деталь.',
          cheaper_part_unavailable:'Для этой детали нет более дешёвого варианта.',
          cheaper_part_no_build:'Не нашёл более дешёвую совместимую замену, которая снизит итоговую цену сборки.',
          part_request_not_found:'Не удалось применить изменение к доступным товарам. Опишите, какого результата Вы хотите добиться.',
          part_request_ambiguous:'Нашёл несколько товаров с похожим названием. Уточните производителя или полное название нужного варианта.',
          part_request_category_mismatch:'Название товара не совпадает с указанным типом комплектующей.',
          quiet_build_unavailable:'Не удалось проверить текущую сборку для сравнения уровня шума.',
          quiet_baseline_unknown:'Для вентилятора в текущей сборке нет подтверждённого уровня шума в дБ(A), поэтому сравнить его с заменой пока нельзя.',
          quiet_part_no_build:`Паспортный шум выбранного охлаждения — ${Number.isFinite(result.referenceNoiseDba)?`${escapeHTML(result.referenceNoiseDba)} дБ(A)`:'неизвестен'}. Более тихую совместимую замену с подтверждённым показателем сейчас не нашёл.`,
          invalid_memory_request:'Укажите объём оперативной памяти от 8 до 128 ГБ.',
          requested_part_unavailable:'Запрошенная деталь сейчас недоступна для подбора в Вашем городе.',
          requested_part_no_build:'С запрошенной деталью не удалось собрать проверенный совместимый вариант.',
          resolution_requirement_unmet:`Запрошенная деталь не подходит под выбранное разрешение ${escapeHTML(result.resolution||'')}. Нужна видеокарта с подтверждённым результатом от ${escapeHTML(result.minimumReferenceFps||'заданного минимума')} FPS в контрольных тестах и памятью от ${escapeHTML(result.minimumVramGB||'')} ГБ.`,
          resolution_budget_unmet:`При выбранном разрешении минимальная подходящая сборка стоит ${Number.isFinite(result.minimumTotal)?money(result.minimumTotal):'дороже допустимого бюджета'}. Текущий бюджет с допуском 5% — ${Number.isFinite(result.budgetLimit)?money(result.budgetLimit):'недостаточен'}.`
        };
        bot(`<p>${messages[result.error]||'Не удалось проверить изменение. Уточните, какую комплектующую хотите изменить.'}</p><p class="muted">Предыдущее предложение остаётся без изменений.</p>`);
        textMode('Уточните пожелание…',state.pendingCheaper?'Например: видеокарту или SSD.':
          state.pendingCooler?'Воздушный кулер или СЖО?':'Опишите желаемое изменение.');
        return;
      }
      state.currentBuild=null;
      state.buildCriteria=criteria;
      if(result.error==='resolution_budget_unmet'||result.error==='resolution_requirement_unmet'){
        const detail=result.error==='resolution_budget_unmet'
          ? `Для выбранного разрешения ${escapeHTML(result.resolution||'')} не нашёл подходящую сборку в бюджете или в пределах +5%. Минимальная стоимость по текущему каталогу — ${Number.isFinite(result.minimumTotal)?money(result.minimumTotal):'неизвестна'}.`
          : `Для выбранного разрешения ${escapeHTML(result.resolution||'')} нет подходящей доступной видеокарты с подтверждённым результатом от ${escapeHTML(result.minimumReferenceFps||'заданного минимума')} FPS в контрольных тестах и от ${escapeHTML(result.minimumVramGB||'')} ГБ видеопамяти.`;
        bot(`<p>${detail}</p><p>Можно увеличить бюджет или выбрать другое разрешение. Сборку, не соответствующую Вашему выбору, не предлагаю.</p>`);
        textMode('Изменить пожелания…','Измените бюджет или разрешение.');
        return;
      }
      if(result.error==='needs_review'){
        const reasons=Array.isArray(result.reasons)?result.reasons.filter(value=>typeof value==='string').slice(0,3):[];
        bot(`<p>Для этой сборки требуется проверка. Я не могу подтвердить совместимость и перейти к оформлению.</p>${reasons.map(reason=>`<p class="muted">${escapeHTML(reason)}</p>`).join('')}<p>Можно уточнить данные о комплектующих или выбрать другой вариант.</p>`);
        textMode('Уточнить пожелания…','Подбор требует проверки.');
        return;
      }
      bot('<p>Пока не удалось собрать полный вариант из товаров со статусом «Доступен для Конфигуратора», который одновременно проходит проверку характеристик, габаритов, питания и наличия для Вашего города.</p><p class="muted">Можно изменить бюджет или пожелания и попробовать ещё раз. Я не буду подставлять товары, не допущенные каталогом.</p>');
      textMode('Изменить пожелания…','Напишите, что изменить: бюджет, задачи или предпочтения.');
      return;
    }
    removeMessage(waiting);
    if(!result?.build)throw new Error('invalid_build_response');
    state.partPreferences=result.partPreferences||state.partPreferences;
    state.pendingCheaper=false;state.pendingCooler=false;
    state.currentBuild=result.build;
    state.buildCriteria=buildCriteriaKey();
    const build=result.build;
    const city=build.city;
    const rows=build.parts.map(part=>`<div class="part"><span>${escapeHTML(part.category)}</span><strong>${money(part.price)}</strong><small>${part.quantity>1?`${part.quantity} шт. × `:''}${typeof part.productUrl==='string'&&/^https:\/\//i.test(part.productUrl)?`<a href="${escapeHTML(part.productUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(part.name)}</a>`:escapeHTML(part.name)}<br>${part.transferBusinessDays===0?`Есть в наличии в ${escapeHTML(city)}`:`Перемещение до ${escapeHTML(city)} — ${part.transferBusinessDays} раб. дн.`}</small></div>`).join('');
    const advantages=Array.isArray(build.advantages)&&build.advantages.length?`<div class="build-advantages"><strong>Преимущества этой сборки</strong><ul>${build.advantages.filter(value=>typeof value==='string').map(value=>`<li>${escapeHTML(value)}</li>`).join('')}</ul></div>`:'';
    const usbWarnings=Array.isArray(build.warnings)?build.warnings.filter(value=>typeof value==='string').map(value=>`<p class="budget-alert">${escapeHTML(value)}</p>`).join(''):'';
    const timing=build.pickupOptions?.length>1?'Срок зависит от филиала получения. После согласия со сборкой выберите удобный вариант — покажем срок и стоимость для каждого филиала.':`Перемещение: до ${build.maxTransferBusinessDays} рабочих дней. Сборка: ещё ${build.assemblyBusinessDays ?? 2} рабочих дней.${build.readyDate ? ` Ориентир готовности: ${build.readyDate.split('-').reverse().join('.')}, с учётом календарей отправителя и филиала сборки.` : ''}`;
    const noise=result.noiseComparison;
    const noiseNote=noise&&Number.isFinite(noise.previousDba)&&Number.isFinite(noise.selectedDba)
      ? `<p>По паспортным данным вентилятора: ${escapeHTML(noise.previousName)} — ${noise.previousDba} дБ(A), ${escapeHTML(noise.selectedName)} — ${noise.selectedDba} дБ(A). Это сравнение деталей, а не измерение шума всего ПК.</p>`:'';
    const cpuEvidence=build.processorEvidence;
    const cpuEvidenceNote=cpuEvidence?.source==='ComputerBase'&&
      /^https:\/\/www\.computerbase\.de\//.test(cpuEvidence.url)
      ? `<p class="note">При выборе процессора учтён <a href="${escapeHTML(cpuEvidence.url)}" target="_blank" rel="noopener noreferrer">сравнительный тест ComputerBase</a>. Он показывает возможности CPU на контрольной системе, а не FPS предложенной связки.</p>`:'';
    const fpsEstimate=build.fpsEstimate;
    const fpsEstimateNote=fpsEstimate?.source==='pc-builds.com'&&
      /^https:\/\/pc-builds\.com\/fps-calculator\/result\//.test(fpsEstimate.url)&&
      Number.isFinite(fpsEstimate.averageFps)
      ? `<p class="note"><a href="${escapeHTML(fpsEstimate.url)}" target="_blank" rel="noopener noreferrer">Оценка pc-builds.com</a> для ${escapeHTML(fpsEstimate.game)} при ${fpsEstimate.resolution==='4K'?'4K':'QHD'} и средних настройках: около ${escapeHTML(fpsEstimate.averageFps)} FPS. Это расчёт сайта для модели CPU и GPU, не измерение предложенной сборки; он не влияет на подбор.${fpsEstimate.resolution==='4K'&&fpsEstimate.averageFps<60?' До 60 FPS на этих настройках оценка не дотягивает.':''}</p>`:'';
    bot(`<div class="proposal"><h3>Подбор системного блока</h3><p class="note">Город сборки: ${escapeHTML(city)} · Ваш бюджет: ${money(build.budget)}</p>${build.overBudget?`<p class="budget-alert">Итог выше бюджета на ${money(build.total-build.budget)}.</p>`:''}${rows}${usbWarnings}<div class="part"><span>Сборка компьютера</span><strong>Бесплатно</strong></div><div class="total"><span>Итого</span><span>${money(build.total)}</span></div>${advantages}<p class="note">${timing}</p>${cpuEvidenceNote}${fpsEstimateNote}<p class="note">Цена действительна один день с момента этого предложения.</p></div>${noiseNote}<p>Что хотели бы изменить? Если этот вариант Вас устраивает, напишите об этом — выберем филиал получения и способ оплаты.</p>`);
    textMode('Обсудить сборку…','Можно свободно изменить пожелания. Пересчитаю комплектующие после ответа.');
    refreshBrief();
    return true;
  }catch{
    if(requestGeneration!==generation){removeMessage(waiting);return;}
    removeMessage(waiting);
    if(changeRequest){
      bot(timedOut?'<p>Проверка замены не завершилась за 90 секунд. Предыдущее предложение остаётся без изменений.</p>':
        '<p>Не удалось проверить замену. Предыдущее предложение остаётся без изменений. Попробуйте ещё раз.</p>');
      textMode('Уточните замену…','Опишите, какую комплектующую хотите изменить.');
      return;
    }
    state.currentBuild=null;state.buildCriteria=criteria;
    bot(timedOut?'<p>Расчёт не завершился за 90 секунд. Попробуйте отправить пожелания ещё раз.</p>':
      '<p>Не удалось получить данные каталога для подбора. Попробуйте отправить пожелания ещё раз.</p>');
    textMode('Изменить пожелания…','Подбор не выполнен. Можно попробовать ещё раз.');
  }finally{
    clearTimeout(requestTimer);
  }
}
function choices(question, options, next, grid = false, preface = '') {
  activeChoice={question,options,grid,preface,step:state.step};
  noInput();
  const box = bot(`${preface}<p>${question}</p>`);
  const group = document.createElement('div');
  group.className = 'choices' + (grid ? ' grid' : '');
  for (const option of options) {
    const item = typeof option === 'string' ? {label:option} : option;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.disabled = !!item.disabled;
    button.innerHTML = `<span>${escapeHTML(item.label)}</span>${item.disabled?'<small>Позже</small>':icon('arrow-up-right')}`;
    button.addEventListener('click',()=>{
      activeChoice=null;
      group.querySelectorAll('button').forEach(el=>{el.disabled=true;});
      button.classList.add('selected');
      user(item.label);
      next(item.value ?? item.label);
      refreshBrief();
    });
    group.append(button);
  }
  box.append(group);
  scrollLatest();
}
function askCity() {
  state.step = 'city';
  if(!demoMode && organizationCities===null){
    noInput('Загружаем города организации…');
    const currentGeneration=generation;
    void (statusPromise || updateStatus()).then(()=>{
      if(currentGeneration!==generation||state.step!=='city')return;
      if(organizationCities?.length)askCity();
      else choices('Города получения пока недоступны.', ['Повторить загрузку'], ()=>{statusPromise=updateStatus();askCity();});
    });return;
  }
  const cities=demoMode?['Павлодар','Алматы','Астана','Другой город']:organizationCities;
  if(!cities?.length){choices('Нет активных филиалов получения.', ['Повторить загрузку'], ()=>{organizationCities=null;statusPromise=updateStatus();askCity();});return;}
  choices('В каком городе Вам нужен системный блок?', cities, value=>{
    chooseCity(value);
  },true);
}
function choosePurpose(value){
      state.purpose=value;
      state.step='tasks';
      bot(`<p>${value==='Для игр'?'В какие игры Вы играете? Возможно, компьютер нужен и для других задач?':value==='Для офиса'?'С какими программами Вы работаете? Расскажите о повседневных задачах.':'С какими программами Вы работаете и какие задачи выполняете?'}</p>`);
      textMode('Например, игры или рабочие программы…','Опишите задачи своими словами');
}
function chooseCity(value){
    state.city=value;
    if(demoMode&&value==='Другой город') bot('<p>В демонстрации используем Алматы.</p>');
    state.step='purpose';
    choices('Для каких задач Вам нужен компьютер?', ['Для игр','Для офиса','Для работы и творчества'], value=>{
      choosePurpose(value);
    });
}
function chooseCpu(value){
        state.cpu=value;
        if(demoMode)showProposal();
        else {
          state.step='proposal';state.currentBuild=null;
          textMode('Обсудить пожелания…','Собираю проверенный вариант…',false,false,false);
          if(!aiAvailable){busy=true;input.readOnly=true;form.querySelector('button').disabled=true;}
          const proposalGeneration=generation;
          void (aiAvailable?aiTurn(value,{budget:state.budget,cpu:state.cpu},'initial_build'):loadProposal(proposalGeneration)).finally(()=>{
            if(proposalGeneration!==generation)return;
            busy=false;input.readOnly=false;form.querySelector('button').disabled=false;
            input.focus({preventScroll:true});
          });
        }
}
function showProposal() {
  state.step='proposal';
  state.currentBuild={maxTransferBusinessDays:5,expiresAt:new Date(Date.now()+86400000).toISOString()};
  const city=state.city==='Другой город'?'Алматы':state.city;
  // Explicitly fictional line items for layout review; not generated recommendations.
  const parts=[['Процессор','Модель будет определена при подборе','85 000 ₸'],['Материнская плата','Модель будет определена при подборе','65 000 ₸'],['Оперативная память','Модель будет определена при подборе','35 000 ₸'],['Видеокарта','Модель будет определена при подборе','160 000 ₸'],['SSD-накопитель','Модель будет определена при подборе','30 000 ₸'],['Блок питания','Модель будет определена при подборе','30 000 ₸'],['Корпус','Модель будет определена при подборе','25 000 ₸'],['Охлаждение','Кулер и корпусные вентиляторы — при необходимости','20 000 ₸']];
  bot(`<p>${escapeHTML(state.name)}, вот как будет выглядеть предложение сборки.</p><div class="proposal"><div class="demo-label">ПРИМЕР ОФОРМЛЕНИЯ · Условные суммы, не данные p1. Этот пример не рассчитан под Ваш бюджет и задачи.</div><h3>Ваш системный блок</h3><p class="note">Город сборки: ${escapeHTML(city)} · Ваш бюджет: ${money(state.budget)}</p>${parts.map(([name,detail,price],i)=>`<div class="part"><span>${name}</span><strong>${price}</strong><small>${detail}<br>${i===1?'Пример: перемещение — 5 рабочих дней':'Пример: в городе сборки · без перемещения'}</small></div>`).join('')}<div class="part"><span>Сборка компьютера</span><strong>Бесплатно</strong></div><div class="total"><span>Итого в примере</span><span>450 000 ₸</span></div><p class="note">Пример срока: максимум 5 рабочих дней на перемещение + 2 рабочих дня на сборку. Проверка совместимости будет подключена вместе с AI и базой характеристик.</p></div><p>Что Вы хотели бы изменить? Если всё устраивает, напишите об этом — выберем филиал получения и способ оплаты.</p>`);
  textMode('Обсудить сборку…','Для просмотра следующего этапа напишите «Сборка устраивает». Изменения пока не рассчитываются.');
  refreshBrief();
}
function askPayment() {
  if(!state.currentBuild){bot('<p>Не могу перейти к оплате, пока нет рассчитанной и проверенной сборки.</p>');return;}
  if(!demoMode&&!state.currentBuild.pickupBranch){askPickup();return;}
  state.step='payment';
  bot(`<p>Сборка согласована. Перемещение займёт до ${state.currentBuild.maxTransferBusinessDays} рабочих дней, сборка — ещё ${state.currentBuild.assemblyBusinessDays ?? 2} рабочих дней.</p>`);
  choices('Как Вам удобнее оплатить?', ['Полная оплата','В рассрочку'], value=>{
    state.payment=value;
    if(value==='В рассрочку') finish('Рассрочка Kaspi');
    else {
      state.step='method';
      choices('Выберите способ оплаты', ['Удалённая оплата Kaspi','Удалённая оплата картой'], finish);
    }
  });
}
function askPickup() {
  state.step='pickup';
  const options=state.currentBuild?.pickupOptions || [];
  if(!options.length){
    bot('<p>Нет подтверждённых вариантов получения. Нужно обновить подбор.</p>');
    state.step='proposal';textMode('Обсудить сборку…','Попросите обновить предложение.');return;
  }
  choices('Где Вам удобно получить компьютер?', options.map(branch=>({
    value:branch.code,
    label:`${branch.name}${branch.address?` · ${branch.address}`:''} · готовность ${branch.readyDate.split('-').reverse().join('.')} · ${money(branch.total)}`,
  })), code=>{void selectPickup(code);});
}
async function selectPickup(code) {
  const currentGeneration=generation;
  const original=state.currentBuild;
  busy=true;noInput('Проверяем выбранный филиал…');
  try{
    const skus=Object.fromEntries(original.parts.map(part=>[part.category, String(part.skuOver)]));
    const response=await fetch(apiUrl('api/pc-build'),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({city:state.city,purpose:state.purpose,budget:state.budget,cpu:state.cpu,
        tasks:state.tasks||'',graphicsPreference:state.graphicsPreference||null,pickupBranch:code,
        partPreferences:{...state.partPreferences,skus:{...state.partPreferences?.skus,...skus}}})});
    const result=await response.json();
    if(currentGeneration!==generation)return;
    const build=result?.build;
    if(!response.ok||build?.pickupBranch?.code!==code){
      bot('<p>Наличие или маршрут изменились. Обновлю предложение и варианты получения.</p>');
      state.step='proposal';await loadProposal(currentGeneration);return;
    }
    const composition=b=>JSON.stringify(b.parts.map(p=>[p.skuOver,p.category,p.quantity]));
    if(composition(build)!==composition(original)){
      bot('<p>Состав сборки изменился. Покажу новое предложение для согласования.</p>');
      state.step='proposal';await loadProposal(currentGeneration);return;
    }
    state.currentBuild=build;
    const branch=build.pickupBranch;
    bot(`<p>Получение: <strong>${escapeHTML(branch.name)}</strong>${branch.address?`, ${escapeHTML(branch.address)}`:''}. Готовность: ${branch.readyDate.split('-').reverse().join('.')}. Стоимость: ${money(build.total)}.</p>`);
    const quoted=original.pickupOptions.find(b=>b.code===code);
    if(build.total!==original.total||!quoted||quoted.readyDate!==branch.readyDate||quoted.total!==build.total){
      choices('Подтверждаете стоимость и срок для этого филиала?', ['Подтвердить','Выбрать другой филиал'], value=>{
        if(value==='Подтвердить')askPayment();else {state.currentBuild.pickupBranch=null;askPickup();}
      });
    }else askPayment();
  }catch{
    if(currentGeneration===generation){bot('<p>Не удалось проверить филиал. Выберите его ещё раз.</p>');askPickup();}
  }finally{if(currentGeneration===generation){busy=false;refreshBrief();}}
}
function explicitlyAcceptsBuild(text) {
  const affirmative=/сборк[ау]\s+(меня\s+)?устраивает|всё\s+устраивает|мне\s+подходит\s+сборка|этот\s+вариант\s+(мне\s+)?подходит|принимаю\s+(эту\s+)?сборку|согласен|согласна/i.test(text);
  const negative=/не\s+(?:устраивает|подходит|согласен|согласна)/i.test(text);
  const edit=/\bно\b|замен|измен|поменя|хочу|нужно|добав|убер|дорог|дешев/i.test(text);
  return affirmative&&!negative&&!edit;
}
function buildFingerprint(build){
  return JSON.stringify({rulesVersion:build.rulesVersion||null,calendarVersion:build.calendarVersion||0,total:build.total,
    parts:(build.parts||[]).map(part=>[part.skuOver,part.category,part.name,
      part.quantity,part.price,part.transferBusinessDays])});
}
async function confirmCurrentBuild(){
  if(busy||!state.currentBuild)return;
  const original=state.currentBuild;
  const currentGeneration=generation;
  busy=true;input.readOnly=true;form.querySelector('button').disabled=true;
  try{
    const response=await fetch(apiUrl('api/pc-build'),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({city:state.city,purpose:state.purpose,budget:state.budget,cpu:state.cpu,
        tasks:state.tasks||'',graphicsPreference:state.graphicsPreference||null,
        partPreferences:state.partPreferences||null})});
    const result=await response.json();
    if(currentGeneration!==generation)return;
    if(!response.ok||!result?.build){
      state.currentBuild=null;
      bot('<p>Не удалось повторно подтвердить состав, цену и наличие. Обновлю предложение перед согласованием.</p>');
      await loadProposal(currentGeneration);return;
    }
    if(buildFingerprint(result.build)!==buildFingerprint(original)){
      state.currentBuild=null;
      bot('<p>Состав, условия или правила подбора изменились. Покажу актуальное предложение; для него потребуется новое согласие.</p>');
      await loadProposal(currentGeneration);return;
    }
    state.currentBuild=result.build;
    askPickup();
  }catch{
    if(currentGeneration===generation)bot('<p>Повторная проверка сейчас недоступна. Попробуйте подтвердить сборку позже.</p>');
  }finally{
    if(currentGeneration===generation){busy=false;input.readOnly=false;form.querySelector('button').disabled=false;}
  }
}
function finish(method) {
  state.method=method;
  state.step='finished';
  bot(`<p>Вы выбрали: <strong>${escapeHTML(method)}</strong>.</p><p>${escapeHTML(state.name)}, спасибо за обращение в ${escapeHTML(organizationName)}!</p><p class="muted">Передача заявки менеджеру через CRM пока не подключена, поэтому выбор сохранён только в текущем сеансе.</p>`);
  noInput('Конец демонстрационного сценария');
  refreshBrief();
}
function submit(text) {
  if(busy)return;
  text=text.trim();
  if(!text) return;
  if(state.step==='budget') {
    const digits=text.replace(/[\s\u00a0\u202f]/g,'');
    const amount=Number(digits);
    if(!/^\d+$/.test(digits)||!Number.isSafeInteger(amount)||amount<=0) {
      $('#input-hint').textContent='Введите положительную целую сумму в тенге, например 500 000.';
      input.setAttribute('aria-invalid','true');
      return;
    }
    state.budget=amount;
  }
  input.removeAttribute('aria-invalid');
  user(text);input.value='';
  switch(state.step) {
    case 'name':
      state.name=text;
      bot(`<p>Приятно познакомиться, ${escapeHTML(text)}! Давайте подберём компьютер под Ваши задачи и бюджет.</p>`);
      askCity();
      break;
    case 'tasks':
       if(demoMode){state.tasks=text;askResolution();}
       else if(!aiAvailable){state.tasks=text;askResolution();}
      else aiTurn(text);
      break;
    case 'budget':
      state.step='cpu';
      choices('Какого производителя процессора Вы предпочитаете?', ['AMD','Intel','На усмотрение специалиста'],value=>{
        chooseCpu(value);
      });
      break;
    case 'proposal':
      if(state.currentBuild&&explicitlyAcceptsBuild(text)){
        if(Date.now()>=Date.parse(state.currentBuild.expiresAt||0)){
          state.currentBuild=null;bot('<p>Срок действия цены истёк. Сначала проверю актуальные цены и наличие, затем попрошу Вас подтвердить обновлённый вариант.</p>');
          loadProposal();break;
        }
        if(demoMode)askPayment();else void confirmCurrentBuild();break;
      }
      if(!demoMode){
        if(aiAvailable){aiTurn(text);break;}
        if(state.pendingCooler&&/воздушн|башенн|сжо|водян|жидкостн/i.test(text)){
          state.pendingCooler=false;
          void loadProposal(generation,`Замените кулер на ${text}`);
          break;
        }
        state.pendingCooler=false;
        if(state.pendingCheaper&&isPartCategory(text)){
          state.pendingCheaper=false;
          void loadProposal(generation,`Поставьте дешевле ${text}`);
          break;
        }
        state.pendingCheaper=false;
        if(isPartChange(text)){
          void loadProposal(generation,text);
          break;
        }
        const amount=Number(text.replace(/[\s\u00a0\u202f]/g,''));
        if(/^\d+$/.test(text.replace(/[\s\u00a0\u202f]/g,''))&&Number.isSafeInteger(amount)&&amount>0)state.budget=amount;
        else if(/^(AMD|Intel)$/i.test(text))state.cpu=text.toUpperCase()==='AMD'?'AMD':'Intel';
        else state.tasks=text;
        bot('<p>Обновлю подбор по Вашим условиям без AI.</p>');
        void loadProposal();
        break;
      }
      if(/^(сборка устраивает|меня всё устраивает|меня все устраивает|согласен|согласна)[.!]?$/i.test(text)) askPayment();
      else {
        bot('<p>Это сообщение останется в диалоге. После подключения AI здесь появятся уточнения и обновлённая сборка с учётом Ваших пожеланий.</p><p>Сейчас можно продолжить обсуждение для проверки интерфейса или написать «Сборка устраивает», чтобы посмотреть этап оплаты.</p>');
        textMode('Напишите пожелания…','Прототип не распознаёт изменения и не пересчитывает комплектующие.');
      }
      break;
  }
  refreshBrief();
}
function reset() {
  transcript=[];activeChoice=null;
  try{sessionStorage.removeItem(chatStorageKey());}catch{}
  generation++;aiController?.abort();busy=false;input.disabled=false;input.readOnly=false;form.querySelector('button').disabled=false;
  state={step:'welcome',partPreferences:{coolerType:null,skus:{}}};messages.replaceChildren();noInput('Нажмите «Старт» — обсудим Ваши задачи');
  input.removeAttribute('aria-invalid');
  const box=bot('<h1 id="welcome-heading">'+welcomeHeading()+'</h1><p class="muted welcome-copy">Поможем выбрать то, что подходит именно Вам. Расскажите о своих задачах — найдём решение вместе.</p><div class="welcome-meta"><span>'+icon('arrow-up-right')+' Быстрый подбор</span><span>'+icon('check')+' Понятные рекомендации</span></div>');
  const start=document.createElement('button');start.className='primary start';start.innerHTML='<span class="start-copy"><strong>Старт</strong><small>Начнём с Ваших задач</small></span><span class="start-arrow">'+icon('arrow-right')+'</span>';
  start.addEventListener('click',()=>{start.disabled=true;user('Старт');state.step='name';bot(`<p>Здравствуйте! Я ${aiAvailable?'AI-помощник':'помощник'} ${escapeHTML(organizationName)}.</p><p>Как к Вам обращаться?</p>`);textMode('Ваше имя','Введите имя, как Вам удобно');refreshBrief();});
  box.append(start);scrollLatest();refreshBrief();
}
form.addEventListener('submit',event=>{event.preventDefault();submit(input.value);});
$('#restart').addEventListener('click',()=>$('#reset-dialog').showModal());
$('#cancel-reset').addEventListener('click',()=>$('#reset-dialog').close());
$('#confirm-reset').addEventListener('click',()=>{$('#reset-dialog').close();reset();});
const savedChat=readChat();
reset();
restoreChat(savedChat);
globalThis.addEventListener?.('pagehide',saveChat);
input.addEventListener('input',saveChat);
loadBranding();
function showDialogueConnection(connected,label=connected?'Диалог подключён':'Диалог выключен'){
  const element=$('#connection-status').querySelector?.('.ai-connection');
  if(element){element.className='ai-connection'+(connected?'':' is-off');element.innerHTML='<b>AI</b> '+escapeHTML(label);}
}
async function updateStatus(){
  if(demoMode){$('#connection-status').innerHTML='<span>ПРОТОТИП</span> Демонстрация интерфейса · AI не используется';return;}
  try{
    const response=await fetch(apiUrl('api/status'));
    if(response.ok===false)throw new Error('status_unavailable');
    const status=await response.json();
    organizationCities=Array.isArray(status.cities)?status.cities.filter(city=>typeof city==='string'&&city.trim()):[];
    aiAvailable=!noAiMode&&status.ready===true;
    const loaded=status.catalogLoaded===true;
    const active=loaded&&status.builderAvailable===true;
    $('#connection-status').innerHTML=`<span class="ai-connection ${aiAvailable?'':'is-off'}"><b>AI</b> ${aiAvailable?'Диалог подключён':'Диалог выключен'}</span><span class="selection-status ${active?'is-active':''}" title="${loaded?'Каталог загружен':'Не удалось загрузить каталог'}"><i aria-hidden="true"></i>${active?'Подбор активен':loaded?'Подбор недоступен':'Каталог недоступен'}</span>`;
  }catch{aiAvailable=false;$('#connection-status').innerHTML='<span class="ai-connection is-off"><b>AI</b> Нет подключения</span><span class="selection-status"><i aria-hidden="true"></i>Каталог недоступен</span>';}
}
statusPromise=updateStatus();
