'use strict';
const {validSku}=require('./catalog-sku.cjs');
const {validateWorkload}=require('./workload-profile.cjs');

const CATEGORIES = [
  'Процессоры', 'Материнские платы', 'Оперативная память', 'Видеокарты',
  'Твердотельные диски (SSD)', 'Жесткие диски 3.5" (для ПК)',
  'Блоки питания', 'Корпуса', 'Кулеры для процессоров',
  'Системы водяного / жидкостного охлаждения (СЖО)', 'Охлаждение для корпусов ПК'
];
const AIR = 'Кулеры для процессоров';
const AIO = 'Системы водяного / жидкостного охлаждения (СЖО)';
const CATEGORY_PATTERN = [
  [/корпусн.*(?:вентилятор|кулер)|вентилятор/i,'Охлаждение для корпусов ПК'],
  [/кулер|охлажден|\bсжо\b|\baio\b/i,AIR],
  [/процессор|\bcpu\b|\bryzen\b|\bcore\s+(?:i[3579]|ultra)/i,'Процессоры'],
  [/материнск|\bmotherboard\b|плат[ау]/i,'Материнские платы'],
  [/оперативн|памят|озу|\bрам\b|\bram\b|\bddr[345]\b/i,'Оперативная память'],
  [/видеокарт|\bgpu\b|\brtx\b|\bradeon\b/i,'Видеокарты'],
  [/\bssd\b|\bссд\b|твердотельн/i,'Твердотельные диски (SSD)'],
  [/\bhdd\b|жестк.*диск/i,'Жесткие диски 3.5" (для ПК)'],
  [/блок.*питан|\bпсу\b|\bpsu\b/i,'Блоки питания'],
  [/корпус|\bcase\b/i,'Корпуса']
];
const normalized = value => String(value||'').toLocaleLowerCase('ru-RU')
  .replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const isCheaperRequest = message => /дешев|подешев|эконом|сниз\S*\s+(?:цен|стоим)|уменьш\S*\s+(?:цен|стоим)/i.test(normalized(message));
const isQuietRequest = message => /тише|тихий|тихую|бесшумн|меньше\s+шума|сниз\S*\s+шум/i.test(normalized(message));

function validatePartPreferences(value) {
  if(value==null)return {coolerType:null,skus:{}};
  if(!value||typeof value!=='object'||Array.isArray(value)||
      ![null,'air','aio'].includes(value.coolerType??null)||
      !value.skus||typeof value.skus!=='object'||Array.isArray(value.skus))throw Error('invalid_part_preferences');
  const skus={};
  for(const [category,sku] of Object.entries(value.skus)){
    if(!CATEGORIES.includes(category)||!validSku(sku))
      throw Error('invalid_part_preferences');
    skus[category]=sku;
  }
  const result={coolerType:value.coolerType??null,skus};
  if(value.workloadProfile!=null)result.workloadProfile=validateWorkload(value.workloadProfile);
  if(value.workloadGpu!=null){
    const gpu=value.workloadGpu;
    if(!gpu||typeof gpu!=='object'||Array.isArray(gpu)||
       !['not_required','preferred','required'].includes(gpu.mode)||
       !Number.isInteger(gpu.minVramGB)||gpu.minVramGB<0||gpu.minVramGB>192||
       ![null,'cuda'].includes(gpu.technology))throw Error('invalid_part_preferences');
    if(gpu.mode==='not_required'&&(gpu.minVramGB||gpu.technology))throw Error('invalid_part_preferences');
    result.workloadGpu={mode:gpu.mode,minVramGB:gpu.minVramGB,technology:gpu.technology};
  }
  if(value.gamingResolution!==undefined){
    if(!['1080p','1440p','4K','unknown'].includes(value.gamingResolution))
      throw Error('invalid_part_preferences');
    result.gamingResolution=value.gamingResolution;
  }
  if(value.platformPreference!==undefined){
    if(!['AM4','AM5','LGA1700','LGA1851'].includes(value.platformPreference))
      throw Error('invalid_part_preferences');
    result.platformPreference=value.platformPreference;
  }
  if(value.colorPreference!==undefined){
    if(value.colorPreference!=='white')throw Error('invalid_part_preferences');
    result.colorPreference='white';
  }
  if(value.minMemoryGB!==undefined){
    if(!Number.isInteger(value.minMemoryGB)||value.minMemoryGB<8||value.minMemoryGB>128)
      throw Error('invalid_part_preferences');
    result.minMemoryGB=value.minMemoryGB;
  }
  for(const key of ['includeGpu','includeHdd','includeCaseFans']){
    if(value[key]!==undefined){
      if(typeof value[key]!=='boolean')throw Error('invalid_part_preferences');
      result[key]=value[key];
    }
  }
  if(value.maxTotal!==undefined){
    if(!Number.isSafeInteger(value.maxTotal)||value.maxTotal<1)throw Error('invalid_part_preferences');
    result.maxTotal=value.maxTotal;
  }
  for(const key of ['maxCoolerNoiseDba','maxFanNoiseDba']){
    if(value[key]!==undefined){
      if(typeof value[key]!=='number'||!Number.isFinite(value[key])||value[key]<=10||value[key]>80)
        throw Error('invalid_part_preferences');
      result[key]=value[key];
    }
  }
  if(value.cheaperThan!==undefined){
    if(!value.cheaperThan||typeof value.cheaperThan!=='object'||Array.isArray(value.cheaperThan))
      throw Error('invalid_part_preferences');
    const cheaperThan={};
    for(const [category,price] of Object.entries(value.cheaperThan)){
      if(!CATEGORIES.includes(category)||!Number.isSafeInteger(price)||price<1)
        throw Error('invalid_part_preferences');
      cheaperThan[category]=price;
    }
    result.cheaperThan=cheaperThan;
  }
  return result;
}

function resolvePartChange(message,inventory,current,currentBuild=null) {
  const preferences=validatePartPreferences(current);
  const text=normalized(message);
  if(!text||text.length>500)throw Error('invalid_part_request');
  if(/\bwhite\b|бел(?:ый|ая|ое|ые|ого|ую|ым|ом|ых)?/iu.test(text)){
    const next={...preferences,colorPreference:'white'};delete next.maxTotal;return next;
  }
  if(isQuietRequest(text)){
    if(!currentBuild||!Array.isArray(currentBuild.parts))throw Error('quiet_build_unavailable');
    const wantsCaseFan=/корпусн|вентилятор/i.test(text);
    const caseFan=currentBuild.parts.find(part=>part.category==='Охлаждение для корпусов ПК');
    const cooler=currentBuild.parts.find(part=>part.category===AIR||part.category===AIO);
    const original=wantsCaseFan?caseFan:(caseFan&&!/кулер|сжо|процессор/i.test(text)?caseFan:cooler);
    const row=original&&inventory.find(item=>item.skuOver===original.skuOver&&item.category===original.category);
    const baseline=row?.component?.facts?.[original.category==='Охлаждение для корпусов ПК'
      ? 'caseFanSpecifications':'cpuCoolerSpecifications']?.value?.noiseDba;
    if(!Number.isFinite(baseline)||baseline<=10||baseline>80)throw Error('quiet_baseline_unknown');
    const skus={...preferences.skus};
    const next={...preferences,skus};
    if(original.category==='Охлаждение для корпусов ПК'){
      delete skus[original.category];
      const enclosure=currentBuild.parts.find(part=>part.category==='Корпуса');
      if(enclosure)skus['Корпуса']=enclosure.skuOver;
      next.includeCaseFans=true;
      next.maxFanNoiseDba=baseline;
    }else{
      delete skus[AIR];delete skus[AIO];
      next.coolerType=null;
      next.maxCoolerNoiseDba=baseline;
    }
    return next;
  }
  if(isCheaperRequest(text)){
    const category=CATEGORY_PATTERN.find(([pattern])=>pattern.test(text))?.[1];
    if(!category)throw Error('cheaper_category_required');
    if(!currentBuild||!Array.isArray(currentBuild.parts)||!Number.isSafeInteger(currentBuild.total))
      throw Error('cheaper_build_unavailable');
    const original=currentBuild.parts.find(part=>part.category===category ||
      (category===AIR&&part.category===AIO));
    if(!original)throw Error('cheaper_part_not_in_build');
    const previousPrice=Math.floor(original.price/original.quantity);
    if(previousPrice<2||currentBuild.total<2)throw Error('cheaper_part_unavailable');
    const skus={...preferences.skus};
    delete skus[category];
    if(category===AIR){delete skus[AIR];delete skus[AIO];}
    const cheaperThan={...(preferences.cheaperThan||{}),[original.category]:previousPrice};
    return {...preferences,skus,coolerType:category===AIR?null:preferences.coolerType,
      cheaperThan,maxTotal:currentBuild.total-1};
  }
  const target=text.includes(' на ')?text.slice(text.lastIndexOf(' на ')+4):text;
  const cooling=/кулер|охлажден|сжо|\baio\b/.test(text);
  const avoidingAio=/без\s+(?:сжо|жидкостн|водян)|не\s+хочу\s+(?:сжо|жидкостн|водян)|убер\S*\s+сжо/.test(text);
  const air=avoidingAio||/воздушн|башенн|\bair\b/.test(target);
  const aio=!avoidingAio&&/жидкостн|водян|сжо|\baio\b/.test(target);
  const mentions=inventory.filter(row=>{
    const model=row.component?.officialModel;
    const modelTail=typeof model==='string'?model.trim().split(/\s+/).slice(1).join(' '):null;
    const names=[row.skuOver,row.product?.article,model,modelTail,row.product?.name]
      .filter(value=>typeof value==='string'&&normalized(value).length>=4);
    return names.some(value=>{
      const needle=normalized(value);
      return (` ${target} `).includes(` ${needle} `);
    });
  });
  const unique=[...new Map(mentions.map(row=>[row.skuOver,row])).values()];
  if(unique.length>1)throw Error('part_request_ambiguous');
  if(!unique.length){
    const next={...preferences};
    let changed=false;
    if(/(?:добав|постав|установ|хочу|нужн).{0,50}(?:видеокарт|\bgpu\b|\brtx\b)/i.test(text)){
      next.includeGpu=true;changed=true;
    }
    if(/(?:добав|постав|установ|хочу|нужен|нужны).{0,50}(?:\bhdd\b|жестк\S*\s+диск)/i.test(text)){
      next.includeHdd=true;changed=true;
    }
    if(/(?:добав|постав|установ|хочу|нужен|нужны).{0,50}(?:вентилятор|корпусн\S*\s+кулер)/i.test(text)){
      next.includeCaseFans=true;changed=true;
    }
    const memory=/\b(\d{1,3})\s*(?:гб|gb)\s*(?:оперативн\S*\s+)?(?:памят|озу|ram)?|(?:оперативн\S*\s+)?(?:памят|озу|ram).{0,20}?\b(\d{1,3})\s*(?:гб|gb)/i.exec(text);
    if((memory&&/(?:оперативн|памят|озу|\bram\b)/i.test(text))||
       /(?:больш|увелич|добав|постав|хочу|нужн).{0,35}(?:оперативн|памят|озу|\bram\b)/i.test(text)||
       /(?:оперативн|памят|озу|\bram\b).{0,35}(?:больш|увелич)/i.test(text)){
      const explicit=memory&&Number(memory[1]||memory[2]);
      const requested=explicit||Math.min(128,Math.max(32,(preferences.minMemoryGB||16)*2));
      if(requested<8||requested>128)throw Error('invalid_memory_request');
      next.minMemoryGB=requested;changed=true;
    }
    if(changed){delete next.maxTotal;return next;}
  }
  if(!unique.length&&cooling&&air!==aio){
    const coolerType=air?'air':'aio';
    const skus={...preferences.skus};
    delete skus[AIR];delete skus[AIO];
    const next={...preferences,coolerType,skus};delete next.maxTotal;return next;
  }
  if(!unique.length&&cooling&&!air&&!aio)throw Error('cooler_type_required');
  if(!unique.length)throw Error('part_request_not_found');
  const row=unique[0];
  const expected=CATEGORY_PATTERN.find(([pattern])=>pattern.test(message))?.[1];
  if(expected&&expected!==row.category&&
      !(expected===AIR&&row.category===AIO))throw Error('part_request_category_mismatch');
  const skus={...preferences.skus,[row.category]:row.skuOver};
  const cheaperThan={...(preferences.cheaperThan||{})};
  delete cheaperThan[row.category];
  if(row.category===AIR||row.category===AIO){
    delete skus[row.category===AIR?AIO:AIR];
    delete cheaperThan[AIR];delete cheaperThan[AIO];
    const next={...preferences,coolerType:row.category===AIR?'air':'aio',skus,cheaperThan};
    delete next.maxTotal;return next;
  }
  const next={...preferences,skus,cheaperThan};delete next.maxTotal;return next;
}

module.exports={validatePartPreferences,resolvePartChange,isCheaperRequest,isQuietRequest,AIR,AIO};
