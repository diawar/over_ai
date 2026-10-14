/* AI dialogue uses the local server. A ready build/payment requires verified product data. */
'use strict';
const $ = selector => document.querySelector(selector);
const messages = $('#messages');
const form = $('#composer');
const input = $('#answer');
let state;
let generation=0;
let busy=false;
let aiController;
const demoMode=new URLSearchParams(window.location.search).get('demo')==='1';
const money = value => new Intl.NumberFormat('ru-RU').format(value) + ' ₸';
const stages = ['Знакомство', 'Ваши задачи', 'Пожелания', 'Обсуждение сборки', 'Способ оплаты'];
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function refreshBrief() {
  const stage = {welcome:0,name:0,need:1,city:1,purpose:1,tasks:1,budget:2,cpu:2,proposal:3,payment:4,method:4,finished:4}[state.step];
  $('#progress').innerHTML = stages.map((label,index) => `<div class="step ${index===stage?'active':index<stage?'done':''}" ${index===stage?'aria-current="step"':''}><b>${index<stage?'✓':String(index+1).padStart(2,'0')}</b>${label}</div>`).join('');
  const entries = [['Имя',state.name],['Город',state.city],['Задачи',state.purpose],['Бюджет',state.budget ? money(state.budget) : ''],['Процессор',state.cpu],['Видеокарта от',state.graphicsPreference],['Оплата',state.method]];
  $('#brief').innerHTML = entries.filter(([,value])=>value).map(([label,value])=>`<div><dt>${label}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
}
function buildCriteriaKey(){return JSON.stringify({city:state.city,purpose:state.purpose,tasks:state.tasks||'',budget:state.budget||null,cpu:state.cpu||null,graphicsPreference:state.graphicsPreference||null});}
function scrollLatest() {
  const conversation=$('#conversation');
  requestAnimationFrame(()=>{conversation.scrollTop=conversation.scrollHeight;});
}
function bot(html) {
  const box = document.createElement('article');
  box.className = 'message assistant';
  box.innerHTML = `<div class="assistant-label">CoreLab · ИИ-ПОМОЩНИК</div>${html}`;
  messages.append(box);
  scrollLatest();
  return box;
}
function user(text) {
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
function textMode(placeholder, hint, numeric = false, preserveDraft = false) {
  form.hidden = false;
  if(!preserveDraft)input.value = '';
  input.placeholder = placeholder;
  input.inputMode = numeric ? 'numeric' : 'text';
  input.maxLength = numeric ? 14 : 500;
  $('#input-hint').textContent = hint;
  input.focus({preventScroll:true});
}
function noInput(hint = 'Выберите подходящий вариант выше') {
  form.hidden = true;
  $('#input-hint').textContent = hint;
}
function askBudget() {
  state.step='budget';
  bot('<p>На какой бюджет Вы рассчитываете?</p><p class="muted">Укажите сумму в тенге только на системный блок. Сборка для Вас бесплатна.</p>');
  textMode('Введите сумму в ₸','Например, 500 000 ₸',true);
}
async function aiTurn(message, selection) {
  if(busy)return;
  const currentGeneration=generation;
  busy=true;input.readOnly=true;form.querySelector('button').disabled=true;
  $('#input-hint').textContent='ИИ-помощник отвечает…';
  const pending=bot('<p class="typing-indicator" role="status">ИИ-помощник готовит ответ<span aria-hidden="true">…</span></p>');
  const controller=new AbortController();aiController=controller;
  const timer=setTimeout(()=>controller.abort(),55000);
  try{
    const response=await fetch('/api/chat',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
      body:JSON.stringify({sessionId:state.sessionId,stage:state.step==='tasks'?'tasks':'discussion',message,
        profile:{city:state.city,purpose:state.purpose,tasks:state.tasks||'',budget:state.budget||null,cpu:state.cpu||null,graphicsPreference:state.graphicsPreference||null},selection})
    });
    const result=await response.json();
    if(currentGeneration!==generation)return;
    if(!response.ok)throw new Error(result.error||'ai_unavailable');
    removeMessage(pending);
    state.sessionId=result.sessionId;
    Object.assign(state,result.profile);
    bot(`<p>${escapeHTML(result.reply).replace(/\n/g,'<br>')}</p>`);
    if(state.step==='tasks'&&result.tasksClear){askBudget();}
    else textMode('Напишите сообщение…',state.step==='tasks'?'Расскажите о Ваших задачах':'Можно уточнить задачи или изменить пожелания. Пересчитаю состав после ответа.',false,true);
    refreshBrief();
    if(state.step==='proposal'&&buildCriteriaKey()!==state.buildCriteria) await loadProposal(currentGeneration);
  }catch(error){
    if(currentGeneration!==generation)return;
    removeMessage(pending);
    const descriptions={ai_not_configured:'ИИ ещё не настроен на сервере. Нужны провайдер, модель и ключ API.',configuration_invalid:'Настройки ИИ на сервере требуют исправления.',unsupported_provider:'Этот провайдер пока не подключён.',ai_auth_failed:'Не удалось авторизоваться у провайдера ИИ. Проверьте серверный ключ.',ai_rate_limited:'Провайдер ИИ временно ограничил запросы. Попробуйте позже.',request_in_progress:'Предыдущий запрос ещё обрабатывается. Попробуйте через несколько секунд.',session_expired:'Сессия завершилась. Начните диалог заново.',conversation_limit:'Достигнут лимит этого диалога. Начните новый.',ai_refusal:'Не удалось обработать этот запрос. Попробуйте переформулировать его.'};
    bot(`<p>${descriptions[error.message]||'Не удалось получить ответ ИИ. Сообщение можно отправить повторно.'}</p>`);
    textMode('Напишите сообщение…','Ответ не получен. Данные диалога сохранены до перезагрузки страницы.',false,true);
    if(!input.value)input.value=message;
    state.retrySelection=selection;
    if(state.step==='proposal'&&buildCriteriaKey()!==state.buildCriteria) await loadProposal(currentGeneration);
  }finally{
    clearTimeout(timer);
    if(currentGeneration===generation){busy=false;input.readOnly=false;form.querySelector('button').disabled=false;input.focus({preventScroll:true});}
  }
}
async function loadProposal(requestGeneration=generation) {
  if(!state.budget||!state.cpu||!state.city||!state.purpose)return;
  const criteria=buildCriteriaKey();
  const waiting=bot('<p class="typing-indicator" role="status">Проверяю наличие и совместимость комплектующих…</p>');
  try{
    const response=await fetch('/api/pc-build',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({city:state.city,purpose:state.purpose,budget:state.budget,cpu:state.cpu,tasks:state.tasks||'',graphicsPreference:state.graphicsPreference||null})});
    const result=await response.json();
    if(requestGeneration!==generation)return;
    if(!response.ok){
      removeMessage(waiting);
      state.currentBuild=null;
      state.buildCriteria=criteria;
      bot('<p>Пока не удалось собрать полный проверенный вариант: в локальных данных не нашлось комплекта, который одновременно проходит проверку характеристик, габаритов, питания и наличия для Вашего города.</p><p class="muted">Можно изменить бюджет или пожелания и попробовать ещё раз. Я не буду подставлять неподтверждённые комплектующие.</p>');
      textMode('Изменить пожелания…','Напишите, что изменить: бюджет, задачи или предпочтения.');
      return;
    }
    removeMessage(waiting);
    if(!result?.build)throw new Error('invalid_build_response');
    state.currentBuild=result.build;
    state.buildCriteria=criteria;
    const build=result.build;
    const city=build.city;
    const rows=build.parts.map(part=>`<div class="part"><span>${escapeHTML(part.category)}</span><strong>${money(part.price)}</strong><small>${part.quantity>1?`${part.quantity} шт. × `:''}${escapeHTML(part.name)}<br>${part.transferBusinessDays===0?`Есть в наличии в ${escapeHTML(city)}`:`Перемещение до ${escapeHTML(city)} — ${part.transferBusinessDays} раб. дн.`}</small></div>`).join('');
    const timing=`Перемещение: до ${build.maxTransferBusinessDays} рабочих дней. Сборка: ещё 2 календарных дня.`;
    bot(`<div class="proposal"><h3>Подбор системного блока</h3><p class="note">Город сборки: ${escapeHTML(city)} · Ваш бюджет: ${money(build.budget)}</p>${build.overBudget?`<p class="budget-alert">Итог выше бюджета на ${money(build.total-build.budget)}.</p>`:''}${rows}<div class="part"><span>Сборка компьютера</span><strong>Бесплатно</strong></div><div class="total"><span>Итого</span><span>${money(build.total)}</span></div><p class="note">${timing}</p><p class="note">Цена действительна один день с момента этого предложения.</p></div><p>Что хотели бы изменить? Если этот вариант Вас устраивает, напишите об этом — перейдём к выбору способа оплаты.</p>`);
    textMode('Обсудить сборку…','Можно свободно изменить пожелания. Пересчитаю комплектующие после ответа.');
    refreshBrief();
  }catch{
    if(requestGeneration!==generation)return;
    removeMessage(waiting);state.currentBuild=null;state.buildCriteria=criteria;
    bot('<p>Не удалось связаться с модулем локального подбора. Попробуйте отправить пожелания ещё раз.</p>');
    textMode('Изменить пожелания…','Подбор не выполнен. Можно попробовать ещё раз.');
  }
}
function choices(question, options, next, grid = false) {
  noInput();
  const box = bot(`<p>${question}</p>`);
  const group = document.createElement('div');
  group.className = 'choices' + (grid ? ' grid' : '');
  for (const option of options) {
    const item = typeof option === 'string' ? {label:option} : option;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.disabled = !!item.disabled;
    button.innerHTML = `<span>${escapeHTML(item.label)}</span>${item.disabled?'<small>Позже</small>':'<span aria-hidden="true">↗</span>'}`;
    button.addEventListener('click',()=>{
      group.querySelectorAll('button').forEach(el=>{el.disabled=true;});
      button.classList.add('selected');
      user(item.label);
      next(item.label);
      refreshBrief();
    });
    group.append(button);
  }
  box.append(group);
  scrollLatest();
}
function askCity() {
  state.step = 'city';
  choices('В каком городе Вам нужен системный блок?', ['Павлодар','Алматы','Астана','Другой город'], value=>{
    state.city=value;
    if(value==='Другой город') bot('<p>Хорошо, будем подбирать комплектующие из Алматы. Точный город сейчас уточнять не нужно.</p>');
    state.step='purpose';
    choices('Для каких задач Вам нужен компьютер?', ['Для игр','Для офиса','Для работы и творчества'], value=>{
      state.purpose=value;
      state.step='tasks';
      bot(`<p>${value==='Для игр'?'В какие игры Вы играете? Возможно, компьютер нужен и для других задач?':value==='Для офиса'?'С какими программами Вы работаете? Расскажите о повседневных задачах.':'С какими программами Вы работаете и какие задачи выполняете?'}</p>`);
      textMode('Например, игры или рабочие программы…','Опишите задачи своими словами');
    });
  },true);
}
function showProposal() {
  state.step='proposal';
  state.currentBuild={maxTransferBusinessDays:5,expiresAt:new Date(Date.now()+86400000).toISOString()};
  const city=state.city==='Другой город'?'Алматы':state.city;
  // Explicitly fictional line items for layout review; not generated recommendations.
  const parts=[['Процессор','Модель будет определена при подборе','85 000 ₸'],['Материнская плата','Модель будет определена при подборе','65 000 ₸'],['Оперативная память','Модель будет определена при подборе','35 000 ₸'],['Видеокарта','Модель будет определена при подборе','160 000 ₸'],['SSD-накопитель','Модель будет определена при подборе','30 000 ₸'],['Блок питания','Модель будет определена при подборе','30 000 ₸'],['Корпус','Модель будет определена при подборе','25 000 ₸'],['Охлаждение','Кулер и корпусные вентиляторы — при необходимости','20 000 ₸']];
  bot(`<p>${escapeHTML(state.name)}, вот как будет выглядеть предложение сборки.</p><div class="proposal"><div class="demo-label">ПРИМЕР ОФОРМЛЕНИЯ · Условные суммы, не данные p1. Этот пример не рассчитан под Ваш бюджет и задачи.</div><h3>Ваш системный блок</h3><p class="note">Город сборки: ${escapeHTML(city)} · Ваш бюджет: ${money(state.budget)}</p>${parts.map(([name,detail,price],i)=>`<div class="part"><span>${name}</span><strong>${price}</strong><small>${detail}<br>${i===1?'Пример: перемещение — 5 рабочих дней':'Пример: в городе сборки · без перемещения'}</small></div>`).join('')}<div class="part"><span>Сборка компьютера</span><strong>Бесплатно</strong></div><div class="total"><span>Итого в примере</span><span>450 000 ₸</span></div><p class="note">Пример срока: максимум 5 рабочих дней на перемещение + 2 календарных дня на сборку. Проверка совместимости будет подключена вместе с ИИ и базой характеристик.</p></div><p>Что Вы хотели бы изменить? Если всё устраивает, напишите об этом — перейдём к выбору способа оплаты.</p>`);
  textMode('Обсудить сборку…','Для просмотра следующего этапа напишите «Сборка устраивает». Изменения пока не рассчитываются.');
  refreshBrief();
}
function askPayment() {
  if(!state.currentBuild){bot('<p>Не могу перейти к оплате, пока нет рассчитанной и проверенной сборки.</p>');return;}
  state.step='payment';
  bot(`<p>Сборка согласована. Перемещение займёт до ${state.currentBuild.maxTransferBusinessDays} рабочих дней, сборка — ещё 2 календарных дня. Услуга сборки бесплатна.</p>`);
  choices('Как Вам удобнее оплатить?', ['Полная оплата','В рассрочку'], value=>{
    state.payment=value;
    if(value==='В рассрочку') finish('Рассрочка Kaspi');
    else {
      state.step='method';
      choices('Выберите способ оплаты', ['Удалённая оплата Kaspi','Удалённая оплата картой'], finish);
    }
  });
}
function explicitlyAcceptsBuild(text) {
  const affirmative=/сборк[ау]\s+(меня\s+)?устраивает|всё\s+устраивает|мне\s+подходит\s+сборка|этот\s+вариант\s+(мне\s+)?подходит|принимаю\s+(эту\s+)?сборку|согласен|согласна/i.test(text);
  const negative=/не\s+(?:устраивает|подходит|согласен|согласна)/i.test(text);
  const edit=/\bно\b|замен|измен|поменя|хочу|нужно|добав|убер|дорог|дешев/i.test(text);
  return affirmative&&!negative&&!edit;
}
function finish(method) {
  state.method=method;
  state.step='finished';
  bot(`<p>Вы выбрали: <strong>${escapeHTML(method)}</strong>.</p><p>${escapeHTML(state.name)}, спасибо за обращение в CoreLab!</p><p class="muted">Передача заявки менеджеру через CRM пока не подключена, поэтому выбор сохранён только в текущем сеансе.</p>`);
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
      state.name=text;state.step='need';
      choices(`Приятно познакомиться, ${escapeHTML(text)}! Чем можем Вам помочь?`, ['Подбор и сборка нового системного блока',{label:'Апгрейд ПК',disabled:true},{label:'Подбор товара',disabled:true}],askCity);
      break;
    case 'tasks':
      if(demoMode){state.tasks=text;askBudget();}
      else aiTurn(text);
      break;
    case 'budget':
      state.step='cpu';
      choices('Какого производителя процессора Вы предпочитаете?', ['AMD','Intel','На усмотрение специалиста'],value=>{
        state.cpu=value;
        if(demoMode)showProposal();
        else {state.step='proposal';state.currentBuild=null;textMode('Обсудить пожелания…','ИИ-помощник отвечает…');aiTurn('Предпочтения заполнены. Подведите итог моих задач и условий. Что можем сделать дальше?',{budget:state.budget,cpu:state.cpu});}
      });
      break;
    case 'proposal':
      if(state.currentBuild&&explicitlyAcceptsBuild(text)){
        if(Date.now()>=Date.parse(state.currentBuild.expiresAt||0)){
          state.currentBuild=null;bot('<p>Срок действия цены истёк. Сначала проверю актуальные цены и наличие, затем попрошу Вас подтвердить обновлённый вариант.</p>');
          loadProposal();break;
        }
        askPayment();break;
      }
      if(!demoMode){const selection=state.retrySelection;delete state.retrySelection;aiTurn(text,selection);break;}
      if(/^(сборка устраивает|меня всё устраивает|меня все устраивает|согласен|согласна)[.!]?$/i.test(text)) askPayment();
      else {
        bot('<p>Это сообщение останется в диалоге. После подключения ИИ здесь появятся уточнения и обновлённая сборка с учётом Ваших пожеланий.</p><p>Сейчас можно продолжить обсуждение для проверки интерфейса или написать «Сборка устраивает», чтобы посмотреть этап оплаты.</p>');
        textMode('Напишите пожелания…','Прототип не распознаёт изменения и не пересчитывает комплектующие.');
      }
      break;
  }
  refreshBrief();
}
function reset() {
  generation++;aiController?.abort();busy=false;input.disabled=false;input.readOnly=false;form.querySelector('button').disabled=false;
  state={step:'welcome'};messages.replaceChildren();noInput('Начните подбор — это займёт всего несколько шагов');
  input.removeAttribute('aria-invalid');
  const box=bot('<h1>Ваши задачи.<br>Ваш характер.<br><em>Ваш компьютер.</em></h1><p class="muted welcome-copy">Поможем подобрать системный блок под Ваши задачи и бюджет. Начнём с простого знакомства.</p><div class="welcome-meta"><span>↗ Подбор под Ваши задачи</span><span>✓ Бесплатная сборка</span></div>');
  const start=document.createElement('button');start.className='primary start';start.innerHTML='Старт <span aria-hidden="true">↗</span>';
  start.addEventListener('click',()=>{start.disabled=true;user('Старт');state.step='name';bot('<p>Здравствуйте! Я ИИ-помощник CoreLab. Помогу Вам с подбором компьютера.</p><p>Как к Вам обращаться?</p>');textMode('Ваше имя','Введите имя, как Вам удобно');refreshBrief();});
  box.append(start);scrollLatest();refreshBrief();
}
form.addEventListener('submit',event=>{event.preventDefault();submit(input.value);});
$('#restart').addEventListener('click',()=>$('#reset-dialog').showModal());
$('#cancel-reset').addEventListener('click',()=>$('#reset-dialog').close());
$('#confirm-reset').addEventListener('click',()=>{$('#reset-dialog').close();reset();});
reset();
async function updateStatus(){
  if(demoMode){$('#connection-status').innerHTML='<span>ПРОТОТИП</span> Демонстрация интерфейса · ИИ не используется';return;}
  try{
    const response=await fetch('/api/status');
    const status=await response.json();
    $('#connection-status').innerHTML=status.ready?`<span>ИИ</span> Диалог подключён · ${status.builderAvailable?'подбор комплектующих активен':'подбор комплектующих недоступен'}`:'<span>НАСТРОЙКА</span> ИИ ожидает подключения';
  }catch{$('#connection-status').textContent='Для работы ИИ откройте приложение через локальный сервер.';}
}
updateStatus();
