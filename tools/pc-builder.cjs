'use strict';
const {timings,referencePrices,balanceBonus,caseCapability,memoryProfileSupport}=require('./component-budget.cjs');
const {buildAdvantages}=require('./build-advantages.cjs');
const {profileFor,assessWorkload,workloadRequirements,workloadGaps}=require('./workload-profile.cjs');
const workloadCohorts=require('./performance-models.json').workloadObservations||[];
const {gpuAssessment,gpuEvidence,gpuUtilityFromEvidence,cpuEvidence,cpuUtilityFromEvidence,requests1440p,getBenchmarkData}=require('./performance-evidence.cjs');
const {cpuModel,normalizeModel}=require('./model-identity.cjs');
const {pcBuildsEstimate}=require('./pc-builds-estimates.cjs');
const {analyzeGames}=require('./game-context.cjs');
const {coolingConnectionFit}=require('./cooling-connectors.cjs');
const {cpuCoolingPower}=require('./cpu-cooling-power.cjs');
const {validatePartPreferences}=require('./part-preferences.cjs');
const {buildSchedule}=require('./branch-calendar.cjs');

const CATEGORY_FACT = {
  'Процессоры': 'processorSpecifications',
  'Материнские платы': 'motherboardSpecifications',
  'Оперативная память': 'memorySpecifications',
  'Видеокарты': 'graphicsCardSpecifications',
  'Блоки питания': 'powerSupplySpecifications',
  'Корпуса': 'caseSpecifications',
  'Жесткие диски 3.5" (для ПК)': 'hardDriveSpecifications',
  'Твердотельные диски (SSD)': 'solidStateDriveSpecifications',
  'Кулеры для процессоров': 'cpuCoolerSpecifications',
  'Системы водяного / жидкостного охлаждения (СЖО)': 'cpuCoolerSpecifications',
  'Охлаждение для корпусов ПК': 'caseFanSpecifications'
};
const EXCLUDED_SUPPLIERS = new Set(['OVER ALB', 'VENDER_P_S']);
const CITY_ALIAS = {'Другой город': 'Алматы'};
// Only rules with an implemented comparison may certify a required attribute.
// An unlisted rule is a review item even when the catalog contains a value.
const CHECKED_ATTRIBUTES = new Set([
  'gpu_graphics_processor','gpu_length_mm','gpu_power_connectors','gpu_recommended_psu_w',
  'cores','cpu_memory_type','cpu_tdp_w','cpu_max_turbo_power_w','cpu_ppt_w','integrated_graphics','max_memory_gb','socket',
  'psu_form_factor','psu_length_mm','psu_pcie_6plus2_count','psu_connector12v2x6_count',
  'psu_pcie_connectors','psu_power_w','psu_cpu_connectors',
  'aio_radiator_size_mm','capacity','memory_form_factor','memory_type','module_count',
  'motherboard_form_factor','motherboard_m2_interfaces','motherboard_m2_slots',
  'motherboard_max_memory_gb','motherboard_memory_slots','motherboard_pcie_x16',
  'motherboard_sata_ports','motherboard_socket','motherboard_chipset','motherboard_fan_headers',
  'motherboard_cpu_power_connectors','motherboard_rear_connector',
  'motherboard_internal_usb_headers','case_front_usb_headers',
  'motherboard_lighting_headers','cooler_fan_connectors','aio_pump_connectors','cooling_lighting_connectors',
  'case_cpu_cooler_max_height_mm','case_gpu_max_length_mm',
  'case_motherboard_form_factors','case_psu_form_factor','case_psu_max_length_mm',
  'case_drive_bays_25','case_drive_bays_35','case_drive_bays_shared_25_35',
  'case_preinstalled_fans','case_fan_mounts',
  'case_radiator_support','cpu_cooler_height_mm','cpu_cooler_sockets',
  'cpu_cooler_tdp_w','cpu_cooler_type','case_fan_connector','case_fan_size',
  'storage_connection','storage_form_factor','storage_interface'
]);
// Required catalog facts that do not impose a hard component compatibility
// constraint. They may describe or rank a part without blocking a build.
const NON_BLOCKING_ATTRIBUTES = new Set([
  'base_clock_ghz','psu_atx_version','psu_efficiency_rating',
  'aio_radiator_dimensions_mm','memory_frequency','memory_timings','memory_profiles','motherboard_memory_profiles',
  'gpu_board_power_w','gpu_memory_gb','gpu_pcie_interface',
  'cpu_cooler_fan_noise_dba','aio_fan_noise_dba','case_fan_noise_dba','component_color'
]);
function uncheckedRules(rules,categories){
  const reasons=[];
  for(const rule of rules||[]){
    if(!categories.has(rule.category))continue;
    for(const code of rule.attributes||[]){
      if(!CHECKED_ATTRIBUTES.has(code)&&!NON_BLOCKING_ATTRIBUTES.has(code))reasons.push(`Для обязательной характеристики «${rule.category}: ${code}» требуется проверка совместимости`);
    }
  }
  return reasons;
}

function amount(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function fact(component, key) { return component?.facts?.[key]?.value ?? null; }
function byOffer(a,b) { return a.offer.price-b.offer.price || a.offer.days-b.offer.days || a.skuOver.localeCompare(b.skuOver); }
function cheapest(rows) { return rows.length ? Math.min(...rows.map(row=>row?.offer.price||0)) : Infinity; }
function normalized(value) { return String(value || '').toLocaleLowerCase('en-US'); }
function isDesktopRamFormFactor(value) {
  const formFactor=String(value||'').toUpperCase().replace(/[\s-]+/g,'');
  return ['DIMM','UDIMM','288PINUDIMM','UNBUFFEREDDIMM','DESKTOPDIMM'].includes(formFactor);
}
function memoryProfile(spec,quantity,board={}) {
  const modules=spec.moduleCount*quantity;
  const matchedKit=spec.moduleCount===2&&quantity===1;
  const speedBase=spec.memoryType==='DDR5'?5200:spec.memoryType==='DDR4'?3200:0;
  const speedTier=Number.isFinite(spec.speedMTs)&&speedBase
    ? Math.max(0,Math.min(2,Math.floor((spec.speedMTs-speedBase)/400))) : 0;
  const timing=timings(spec);
  const support=memoryProfileSupport(spec,board);
  const tuningAllowed=support.tuningAllowed;
  const tuningUtility=tuningAllowed?speedTier*0.5+timing.utility+support.utility:0;
  return {key:`${modules}:${matchedKit?1:0}:${tuningUtility}`,
    tuningUtility,
    utility:(matchedKit?3:modules===2?1:0)+tuningUtility};
}
function memoryCapacityUtility(capacityGB){
  // 64 GB is a useful optional tier, with a smaller gain than the first 32 GB.
  return 8*Math.min(32,capacityGB)/32+(capacityGB>=64?2:0);
}
function coolingUtility(spec,liquid) {
  if(liquid)return spec.radiatorSizeMm>=360?4:2;
  return spec.tdpW>=280?4:spec.tdpW>=240?3:spec.tdpW>=200?2:1;
}
function boardUtility(spec){
  const chipset=String(spec.chipset||'').toUpperCase().replace(/^AMD\s+/,'');
  const chipsetScore={X870E:1.5,X870:1,B850:0.5,X670E:1.25,X670:0.75,B650E:0.5,B650:0.25}[chipset]||0;
  const lan=String(spec.lan||'');
  return Math.min(4,spec.memorySlots||0)/2+Math.min(4,spec.m2Slots||0)+
    (/\b2\.5\s*Gigabit/i.test(lan)?1.5:/\b5\s*Gigabit/i.test(lan)?2.5:0)+
    (spec.wifiBuiltIn===true?1:0)+
    Math.min(2,spec.usb4Ports||0)*0.75+
    (/PCIe\s*5(?:\.0)?/i.test(spec.pcieX16||'')?1:0)+
    Math.min(4,spec.fanHeaders||0)*0.25+chipsetScore;
}
const BALANCED_SPEND={caseShare:0.03,coolingShare:0.025};
function uncachedNamedColor(row){
  const name=String(row?.product?.name||'');
  if(/\b(?:white|snow)\b|(?:^|\s)бел(?:ый|ая|ое|ые)(?=$|\s)/iu.test(name))return 'white';
  if(/\bblack\b|(?:^|\s)(?:чёрн|черн)(?:ый|ая|ое|ые)(?=$|\s)/iu.test(name))return 'black';
  return null;
}
function socketName(value) {
  const label=String(value||'').trim().toUpperCase();
  const match=label.match(/^(?:(?:AMD|INTEL)\s+)?(AM[345]|LGA\s*\d{3,4})$/);
  return match?match[1].replace(/\s+/g,''):null;
}
// Selection policy: match CPU/board sockets and chipset platform. Descriptive
// CPU-series lists and BIOS versions do not restrict selection.
const CHIPSET_SOCKET = new Map([
  ...['A320','B350','X370','B450','X470','A520','B550','X570'].map(code=>[code,'AM4']),
  ...['A620','A620A','B650','B650E','X670','X670E','B840','B850','X870','X870E'].map(code=>[code,'AM5']),
  ...['H610','B660','H670','Z690','Q670','W680','B760','H770','Z790'].map(code=>[code,'LGA1700']),
  ...['H810','B860','Z890'].map(code=>[code,'LGA1851'])
]);
function chipsetSocket(value) {
  const label=String(value||'').trim().toUpperCase();
  const match=label.match(/^(?:(AMD|INTEL)\s+)?([A-Z][A-Z0-9]*)$/);
  if(!match)return null;
  const platform=CHIPSET_SOCKET.get(match[2]);
  if(match[1]&&platform&&(match[1]==='AMD')!==platform.startsWith('AM'))return null;
  return platform||null;
}
function resolutionRequirements(resolution){
  return resolution==='1440p'?{memoryGB:12,referenceFps:53,cpuScore:0}:
    resolution==='4K'?{memoryGB:16,referenceFps:54,cpuScore:24}:null;
}
// The 2.5" and 3.5" figures are separate maxima. Shared trays belong to both
// maxima, but each physical tray holds only one drive at a time.
function driveBayFit(enclosure, ssd25Count, hdd35Count) {
  const max25=enclosure?.driveBays25;
  const max35=enclosure?.driveBays35;
  if(!Number.isInteger(max25)||max25<0||!Number.isInteger(max35)||max35<0)
    return 'review';
  if(ssd25Count>max25||hdd35Count>max35)return 'no';
  if(ssd25Count===0||hdd35Count===0)return 'yes';
  const shared=enclosure.sharedDriveBays;
  if(shared===undefined||shared===null)
    return ssd25Count+hdd35Count<=Math.max(max25,max35)?'yes':'review';
  if(!Number.isInteger(shared)||shared<0||shared>Math.min(max25,max35))return 'review';
  return ssd25Count+hdd35Count<=max25+max35-shared?'yes':'no';
}
function frontUsbWarnings(front, internal) {
  if (!Array.isArray(front)) return [];
  const labels = {usb2_9pin:'USB 2.0',usb3_19pin:'USB 3.x Type-A',usb_c_type_e:'USB-C'};
  const warnings = [];
  for (const port of front) {
    if (!port || !labels[port.kind] || !Number.isInteger(port.count) || port.count < 1) continue;
    const available = Array.isArray(internal) ? internal.find(row => row?.kind === port.kind) : null;
    if (!available || !Number.isInteger(available.count)) {
      warnings.push(`Порт ${labels[port.kind]} на передней панели корпуса: подключение к материнской плате не подтверждено — в характеристиках платы не указан соответствующий внутренний разъём.`);
    } else if (available.count < port.count) {
      warnings.push(`Порт ${labels[port.kind]} на передней панели корпуса может не работать: для его подключения нужно ${port.count} внутренних разъёмов, на плате указано ${available.count}.`);
    }
  }
  return warnings;
}
function connectorDemand(value) {
  if(Array.isArray(value)&&value.every(row=>row&&typeof row==='object')){
    const demand={six:0,eight:0,sixteen:0};
    for(const row of value){
      if(!Number.isInteger(row.count)||row.count<0)return null;
      if(row.kind==='none'&&row.count===0)continue;
      const key={pcie_6:'six',pcie_8:'eight',pcie_16:'sixteen'}[row.kind];
      if(!key||row.count===0)return null;
      demand[key]+=row.count;
    }
    return demand;
  }
  const rows=(Array.isArray(value)?value.join(','):String(value||'')).split(/[,;]+/).map(row=>row.trim()).filter(Boolean);
  if(!rows.length)return null;
  const demand={six:0,eight:0,sixteen:0};
  for(const row of rows){
    if(/^(нет|none|no)$/i.test(row))continue;
    const kind=/16[ -]?pin|12V[- ]?2x6|12VHPWR/i.test(row)?'sixteen':
      /(?:6\s*\+\s*2|8)[ -]?pin/i.test(row)?'eight':/6[ -]?pin/i.test(row)?'six':null;
    if(!kind)return null;
    const count=Number(row.match(/^(\d+)\s*(?:x|×)/i)?.[1]||
      row.match(/(?:^|\s)(?:x|×)\s*(\d+)\s*$/i)?.[1]||1);
    if(!Number.isSafeInteger(count)||count<1)return null;
    demand[kind]+=count;
  }
  return demand;
}
function psuConnectorCount(psu,kind) {
  if(Array.isArray(psu.pcieConnectors)&&psu.pcieConnectors.every(row=>row&&typeof row==='object')){
    const target={six:'pcie_6',eight:'pcie_8',sixteen:'pcie_16'}[kind];
    if(psu.pcieConnectors.some(row=>row.kind==='unresolved'))return null;
    return psu.pcieConnectors.filter(row=>row.kind===target).reduce((sum,row)=>sum+row.count,0);
  }
  const fields=kind==='sixteen' ? ['connector16PinCount','connector12V2x6Count','pciE12Plus4Count'] :
    ['pciE6Plus2Count','pciE8PinCount'];
  const known=fields.map(field=>psu[field]).filter(Number.isFinite);
  const fromCounts=known.length?known.reduce((sum,count)=>sum+count,0):null;
  const fromList=connectorDemand(psu.pcieConnectors)?.[kind];
  return fromCounts===null?fromList??null:fromList===undefined?fromCounts:Math.min(fromCounts,fromList);
}
function gpuPowerFit(gpuConnectors,psu) {
  const need=connectorDemand(gpuConnectors);
  if(!need)return 'review';
  const six=psuConnectorCount(psu,'six');
  const eight=psuConnectorCount(psu,'eight');
  const sixteen=psuConnectorCount(psu,'sixteen');
  if((need.six>0&&six===null&&eight===null)||(need.eight>0&&eight===null)||
     (need.sixteen>0&&sixteen===null))return 'review';
  if((eight??0)<need.eight||(sixteen??0)<need.sixteen||
     (six??0)+Math.max(0,(eight??0)-need.eight)<need.six)return 'no';
  // Several GPU sockets need separately documented cables, not just plugs on
  // one daisy-chain. An unknown cable count is a review item.
  if(Array.isArray(psu.pcieConnectors)&&psu.pcieConnectors.every(row=>row&&typeof row==='object')){
    const groups=[
      [new Set(['pcie_6','pcie_8']),need.six+need.eight],
      [new Set(['pcie_16']),need.sixteen]
    ];
    for(const [kinds,count] of groups){
      if(count<2)continue;
      const rows=psu.pcieConnectors.filter(row=>kinds.has(row.kind));
      const cables=rows.reduce((sum,row)=>
        sum+(Number.isInteger(row.cables)?row.cables:0),0);
      if(rows.some(row=>!Number.isInteger(row.cables)))return 'review';
      if(cables<count)return 'no';
    }
  }else if(need.eight+need.six+need.sixteen>1)return 'review';
  return 'yes';
}
function cpuPowerConnectorCounts(value, psu=false) {
  if(!Array.isArray(value)||!value.length)return null;
  const counts={four:0,eight:0,flex:0};
  for(const raw of value){
    if(raw&&typeof raw==='object'){
      const key={cpu_4:'four',cpu_8:'eight',cpu_4plus4:'flex'}[raw.kind];
      if(!key||!Number.isInteger(raw.count)||raw.count<1||(key==='flex'&&!psu))return null;
      counts[key]+=raw.count;
      continue;
    }
    if(typeof raw!=='string')return null;
    const match=raw.trim().match(/^(?:(\d+)\s*[x×]\s*)?(?:CPU\s+)?(4\s*\+\s*4|8|4)(?:\s*[- ]?pin)?(?:\s+(?:EPS|ATX12V))?$/i);
    if(!match)return null;
    const count=Number(match[1]||1);
    if(!Number.isSafeInteger(count)||count<1)return null;
    const kind=match[2].includes('+')?'flex':match[2]==='8'?'eight':'four';
    if(kind==='flex'&&!psu)return null;
    counts[kind]+=count;
  }
  return counts;
}
function cpuPowerConnectorFit(boardConnectors, psuConnectors) {
  const board=cpuPowerConnectorCounts(boardConnectors);
  const psu=cpuPowerConnectorCounts(psuConnectors,true);
  if(!board||!psu)return 'review';
  const flexAfterEight=psu.flex-Math.max(0,board.eight-psu.eight);
  return flexAfterEight>=0 && psu.four+flexAfterEight>=board.four?'yes':'no';
}
function motherboardCaseFit(board, caseFormats) {
  if(!Array.isArray(caseFormats)||!caseFormats.length||!nonEmpty(board?.formFactor)||
     typeof board?.rearConnector!=='boolean')return 'review';
  const identity=value=>{
    const text=String(value||'').trim().toLocaleLowerCase('en-US');
    const rear=/rear[\s-]*connector|back[\s-]*connect|\bbtf\b|project[\s-]*zero|\bstealth\b/i.test(text);
    const base=text.replace(/\(?\s*(?:rear[\s-]*connector|back[\s-]*connect|\bbtf\b|project[\s-]*zero|\bstealth\b)\s*\)?/ig,'').replace(/[\s()._-]/g,'');
    return {base,rear};
  };
  const boardType=identity(board.formFactor);
  const needsRear=board.rearConnector||boardType.rear;
  return caseFormats.some(value=>{
    const caseType=identity(value);
    return caseType.base.startsWith(boardType.base)&&(!needsRear||caseType.rear);
  })?'yes':'no';
}
function caseFanHeaderFit(connector, fanQuantity, boardHeaders, boardUsb2Headers) {
  if(Array.isArray(connector)&&connector.every(row=>row&&typeof row==='object')){
    if(!Number.isInteger(fanQuantity)||fanQuantity<1||!Number.isInteger(boardHeaders)||boardHeaders<0)
      return 'review';
    const kinds=new Set(connector.map(row=>row.kind));
    if(kinds.has('unresolved'))return 'review';
    if(kinds.has('usb2_9pin')){
      if(!Number.isInteger(boardUsb2Headers)||boardUsb2Headers<0)return 'usb_unknown';
      if(boardUsb2Headers===0)return 'no';
      return 'external';
    }
    if([...kinds].some(kind=>kind==='sata_power'||kind==='molex_4'||kind.startsWith('proprietary_')))
      return 'external';
    if(kinds.has('fan_pwm_4pin')||kinds.has('fan_dc_3pin'))
      return boardHeaders>=fanQuantity?'yes':'no';
    return 'review';
  }
  if(typeof connector!=='string'||!connector.trim()||!Number.isInteger(fanQuantity)||fanQuantity<1||
     !Number.isInteger(boardHeaders)||boardHeaders<0)return 'review';
  const value=connector.trim();
  if(/9\s*[- ]?pin\s+usb(?:\s*2\.0)?/i.test(value)){
    if(!Number.isInteger(boardUsb2Headers)||boardUsb2Headers<0)return 'usb_unknown';
    if(boardUsb2Headers===0)return 'no';
    return 'external';
  }
  if(/molex|sata|9\s*[- ]?pin\s+usb|controller|hub/i.test(value))return 'external';
  const primary=value.split(';')[0].trim();
  if(/^3\s*[- ]?pin(?:\s|$)/i.test(primary)||/^4\s*[- ]?pin\s+pwm(?:\s|$)/i.test(primary))
    return boardHeaders>=fanQuantity?'yes':'no';
  return 'review';
}
function componentDimension(value, index) {
  const dimensions = value?.dimensions;
  if (dimensions && Number.isFinite(dimensions.lengthMm)) return dimensions.lengthMm;
  const nums = String(value?.dimensionsMm || '').match(/\d+(?:\.\d+)?/g);
  return nums?.length > index ? Number(nums[index]) : null;
}
function getOffer(product, warehouses, destinationCity, options = {}) {
  if (!Array.isArray(product?.dealersData)) return null;
  const offers = [];
  for (const row of product.dealersData) {
    const match = String(row).match(/^(.*?)\s+\((\d+)\)/);
    if (!match) continue;
    const supplier = match[1].trim();
    const quantity = Number(match[2]);
    if (quantity < 1 || (!options.organizationPolicy && EXCLUDED_SUPPLIERS.has(supplier))) continue;
    const warehouse = warehouses.get(supplier);
    const days = warehouse?.deliveries?.[destinationCity];
    if (!warehouse || !Number.isFinite(days) || days < 0) continue;
    offers.push({supplier, quantity, days, local: warehouse.city === destinationCity});
  }
  offers.sort((a, b) => Number(b.local) - Number(a.local) || a.days - b.days || a.supplier.localeCompare(b.supplier));
  const offer = offers[0];
  const price = amount(product?.priceLoan);
  return offer && price ? {...offer, price} : null;
}

function pickupOptionsForBuild(build, localData, branches) {
  const options = [];
  for (const branch of branches) {
    const candidates = localData.getBuildCandidates(build.city, branch.code);
    const parts = build.parts.map(part => {
      const row = candidates.find(row => String(row.skuOver) === String(part.skuOver) && row.category === part.category);
      if (!row || row.offer.quantity < part.quantity) return null;
      return {...part, price: row.offer.price * part.quantity, supplier: row.offer.supplier,
        stock: row.offer.quantity, transferBusinessDays: row.offer.days};
    });
    if (parts.some(part => !part)) continue;
    const maxTransferBusinessDays = Math.max(...parts.map(part => part.transferBusinessDays));
    try {
      const schedule = buildSchedule(build.createdAt, maxTransferBusinessDays, localData.getOperations(),
        {parts, destinationCity: build.city, destinationBranch: branch.code, requireBranches: true});
      options.push({code: branch.code, name: branch.name, address: branch.address || '', city: branch.city,
        total: parts.reduce((sum, part) => sum + part.price, 0), maxTransferBusinessDays, ...schedule});
    } catch { /* An unavailable route/calendar must not become a pickup option. */ }
  }
  return options;
}

function buildPc(options) {
  let preferences;
  try { preferences=validatePartPreferences(options.partPreferences); }
  catch { return {ok:false,code:'invalid_build_request'}; }
  if(preferences.workloadGpu?.mode==='preferred'&&options.purpose!=='Для игр'&&
     !preferences.includeGpu&&!preferences.skus['Видеокарты']){
    const withGpu=buildPc({...options,partPreferences:{...preferences,
      workloadGpu:{...preferences.workloadGpu,mode:'required'}}});
    if(withGpu.ok&&!withGpu.build.overBudget)return withGpu;
    const withoutGpu=buildPc({...options,partPreferences:{...preferences,
      workloadGpu:{mode:'not_required',minVramGB:0,technology:null}}});
    if(withoutGpu.ok)withoutGpu.build.warnings.push('Желательная дискретная видеокарта не вошла в бюджет; выбран вариант со встроенной графикой.');
    return withoutGpu;
  }
  // Prefer an office SSD in the 480/500/512 GB class. Only relax capacity
  // when no complete build with that capacity fits the customer's budget.
  const office = options.purpose === 'Для офиса';
  const recommended = buildPcWithStorage(options, office ? 480 : 1000);
  if (!office || (recommended.ok && !recommended.build.overBudget)) return recommended;
  return buildPcWithStorage(options, 1);
}

function buildPcWithStorage(options, minimumSsdGB) {
  const {localData, city, pickupBranch} = options;
  if (typeof city !== 'string' || !city.trim() || city.length > 120) return {ok:false, code:'invalid_build_request'};
  // Historical test fixtures have no organization directory.
  if (typeof localData.getBranches !== 'function') {
    const result = buildForBranch({...options, minimumSsdGB}); delete result.utility; return result;
  }
  const branches = localData.getBranches(city);
  const targets = pickupBranch == null ? branches : branches.filter(b => b.code === pickupBranch);
  if (!targets.length) return {ok:false, code:'invalid_build_request'};
  let best = null, failure = null;
  for (const branch of targets) {
    const scopedData = {...localData, getBuildCandidates: targetCity => localData.getBuildCandidates(targetCity, branch.code)};
    const result = buildForBranch({...options, localData:scopedData, destinationBranch:branch.code, minimumSsdGB});
    if (!result.ok) { failure ??= result; continue; }
    if (!best || compareBuilds(result, best) < 0) best = result;
  }
  if (!best) return failure || {ok:false, code:'no_verified_build', city};
  const pickupOptions = pickupOptionsForBuild(best.build, localData, branches);
  if (!pickupOptions.length) return {ok:false, code:'needs_review', city, reasons:['Нет доступного филиала для всей сборки.']};
  best.build.pickupOptions = pickupOptions;
  best.build.pickupBranch = pickupBranch == null ? null : pickupOptions.find(b => b.code === pickupBranch);
  if (pickupBranch != null && !best.build.pickupBranch) return {ok:false, code:'requested_part_unavailable', city};
  delete best.utility;
  return best;
}

function buildForBranch({localData, city, destinationBranch, budget, cpu, purpose, minimumSsdGB, tasks = '', graphicsPreference = null, partPreferences = null, onProgress = null}) {
  const {validatePartPreferences,AIR,AIO}=require('./part-preferences.cjs');
  let preferred;
  try{preferred=validatePartPreferences(partPreferences);}catch{return {ok:false,code:'invalid_build_request'};}
  const colors=new Map();
  const namedColor=row=>{if(!colors.has(row))colors.set(row,uncachedNamedColor(row));return colors.get(row);};
  const whiteBuild=preferred.colorPreference==='white'||/\bwhite\b|бел(?:ый|ая|ое|ые|ого|ую|ым|ом|ых)?/iu.test(String(tasks||''));
  const isWhite=row=>String(fact(row?.component,CATEGORY_FACT[row?.category])?.color||'').trim().toLocaleLowerCase('ru-RU')==='белый';
  const destinationCity = typeof localData.getBranches === 'function' ? city : CITY_ALIAS[city] || city;
  const validCity = typeof localData.getBranches === 'function' ? localData.getBranches(destinationCity).length > 0 : ['Алматы', 'Астана', 'Павлодар'].includes(destinationCity);
  if (!validCity || !amount(budget) ||
      !['AMD', 'Intel', 'На усмотрение специалиста'].includes(cpu) ||
      !(graphicsPreference==null||['RTX 5060','RTX 5060 Ti','RTX 5070','RTX 5080'].includes(graphicsPreference)) ||
      !['Для игр', 'Для офиса', 'Для работы и творчества'].includes(purpose)) {
    return {ok:false, code:'invalid_build_request'};
  }
  const available = localData.getBuildCandidates(destinationCity);
  for(const [category,sku] of Object.entries(preferred.skus)){
    if(!available.some(row=>row.category===category&&row.skuOver===sku))
      return {ok:false,code:'requested_part_unavailable',city:destinationCity};
  }
  const inventory = available.filter(row=>
    (!preferred.skus[row.category]||preferred.skus[row.category]===row.skuOver)&&
    (!preferred.cheaperThan||row.offer.price <
      (row.category===AIR||row.category===AIO
        ? Math.min(preferred.cheaperThan[AIR]??Infinity,preferred.cheaperThan[AIO]??Infinity)
        : preferred.cheaperThan[row.category]??Infinity))&&
    (!preferred.coolerType||(
      row.category!==AIR&&row.category!==AIO)||
      (preferred.coolerType==='air'?row.category===AIR:row.category===AIO)));
  const currentRules = localData.getRules?.();
  const requiredCategories = new Set((currentRules || []).filter(row=>row.required).map(row=>row.category));
  const rulesVersion = localData.getRulesVersion?.() || null;
  const workloadProfile=profileFor(purpose,preferred);
  const requirements=workloadRequirements(workloadProfile);
  const minVramGB=Math.max(requirements.minVramGB,preferred.workloadGpu?.minVramGB||0);
  const gaming = purpose === 'Для игр'||workloadProfile.tasks.some(task=>task.application==='gaming');
  const workloadCpu=new Map(),workloadGpu=new Map();
  const workloadScore=assessment=>assessment?.score==null?0:assessment.score*0.24;
  const gpuRequired = gaming || requirements.requiresGpu || workloadProfile.tasks.some(task=>task.operation==='gpu_render') || preferred.workloadGpu?.mode==='required' || preferred.includeGpu===true || !!preferred.skus['Видеокарты'];
  const cpuRows = inventory.filter(row => row.category === 'Процессоры' &&
    (cpu === 'На усмотрение специалиста' || row.product.manufacturer === cpu) &&
    (!preferred.platformPreference ||
      socketName(fact(row.component,CATEGORY_FACT['Процессоры'])?.socket)===preferred.platformPreference)).sort(byOffer);
  const motherboardRows = inventory.filter(row => row.category === 'Материнские платы'&&(!whiteBuild||isWhite(row))).sort(byOffer);
  const memoryRows = inventory.filter(row => row.category === 'Оперативная память'&&(!whiteBuild||isWhite(row))).sort(byOffer);
  const gpuRows = gpuRequired ? inventory.filter(row => row.category === 'Видеокарты'&&(!whiteBuild||isWhite(row))) : [];
  const psuRows = inventory.filter(row => row.category === 'Блоки питания'&&(!whiteBuild||isWhite(row))).sort(byOffer);
  const caseRows = inventory.filter(row => row.category === 'Корпуса'&&(!whiteBuild||isWhite(row))).sort(byOffer);
  const ssdRows = inventory.filter(row => row.category === 'Твердотельные диски (SSD)');
  const hddRows = inventory.filter(row => row.category === 'Жесткие диски 3.5" (для ПК)');
  const coolerRows = inventory.filter(row => (row.category === 'Кулеры для процессоров' ||
    row.category === 'Системы водяного / жидкостного охлаждения (СЖО)') &&
    (!whiteBuild||isWhite(row)) &&
    (preferred.maxCoolerNoiseDba===undefined||
      (Number.isFinite(fact(row.component,CATEGORY_FACT[row.category])?.noiseDba)&&
       fact(row.component,CATEGORY_FACT[row.category]).noiseDba>10&&
       fact(row.component,CATEGORY_FACT[row.category]).noiseDba<preferred.maxCoolerNoiseDba)));
  const caseFanRows = inventory.filter(row => row.category === 'Охлаждение для корпусов ПК' &&
    (!whiteBuild||isWhite(row)) &&
    (preferred.maxFanNoiseDba===undefined||
      (Number.isFinite(fact(row.component,CATEGORY_FACT[row.category])?.noiseDba)&&
       fact(row.component,CATEGORY_FACT[row.category]).noiseDba>10&&
       fact(row.component,CATEGORY_FACT[row.category]).noiseDba<preferred.maxFanNoiseDba)));
  const caseReferencePrices=referencePrices(caseRows,row=>fact(row.component,CATEGORY_FACT[row.category]));
  const coolerReferencePrices=referencePrices(coolerRows,row=>fact(row.component,CATEGORY_FACT[row.category]));
  const hddRequired = requiredCategories.has('Жесткие диски 3.5" (для ПК)') ||
    !!preferred.skus['Жесткие диски 3.5" (для ПК)'] || preferred.includeHdd===true;
  const hddOptions = hddRequired ? hddRows.filter(row => {
    const spec=fact(row.component,CATEGORY_FACT['Жесткие диски 3.5" (для ПК)']);
    return Number.isFinite(spec?.capacityGB) && spec.capacityGB>0 &&
      /3[.,]5/.test(spec.formFactor||'') && /sata/i.test(spec.interface||'') &&
      /sata/i.test(spec.connection||'');
  }).sort((a,b)=>a.offer.price-b.offer.price || a.offer.days-b.offer.days ||
    a.skuOver.localeCompare(b.skuOver)).slice(0,1) : [null];
  // Compare complete configurations. No CPU/GPU pair is frozen in advance.
  let best = null;
  let buildCount = 0;
  const canImproveOnPrice=floor=>!best||floor<=(best.build.overBudget?best.build.total:budget);
  const reviewReasons = new Set();
  const needs=(message)=>reviewReasons.add(message);
  if(whiteBuild){
    const colorCategories=['Корпуса','Материнские платы','Оперативная память','Блоки питания',
      ...(gpuRequired?['Видеокарты']:[]),
      ...(preferred.coolerType==='air'?[AIR]:preferred.coolerType==='aio'?[AIO]:[AIR,AIO]),
      ...((preferred.includeCaseFans===true||preferred.skus['Охлаждение для корпусов ПК'])?
        ['Охлаждение для корпусов ПК']:[])];
    for(const category of colorCategories){
      if(!inventory.some(row=>row.category===category&&isWhite(row)))
        needs(`Нет товара категории «${category}» с подтверждённым белым цветом`);
    }
  }
  if(hddRequired&&!hddOptions.length)
    needs('Не найдён подтверждённый 3.5-дюймовый HDD для обязательной категории');
  const memoryMinimumGB = Math.max(purpose === 'Для офиса' ? 8 : 16,preferred.minMemoryGB||0,requirements.minMemoryGB);
  const memoryTargetGB = Math.max(purpose === 'Для офиса' ? 16 : gaming ? 64 : 32,memoryMinimumGB);
  const storageTierFor = capacity => purpose === 'Для офиса'
    ? Math.min(1, capacity / 480) : Math.min(4, Math.floor(capacity / 1000));
  const storageUtilityFor = capacity => {
    const tier = storageTierFor(capacity);
    return purpose === 'Для офиса' ? tier * 2 : tier >= 4 ? 9 : tier >= 2 ? 6 : tier >= 1 ? 2 : 1;
  };
  const gameContext=gaming?analyzeGames(tasks):null;
  const resolution=preferred.gamingResolution;
  // An explicit resolution is a selection constraint, not just a score multiplier.
  // The floor refers to a published comparison cohort, not a specific GPU model
  // or a promise of this build's frame rate in every game.
  const resolutionMinimum=gaming?resolutionRequirements(resolution):null;
  const competitive=gaming&&(gameContext.competitiveOnly||
    (gameContext.titles.length===0&&/киберспорт/iu.test(tasks)))&&
    !requests1440p(tasks,resolution)&&resolution!=='4K';
  const gpuFocused=gaming&&(requests1440p(tasks,resolution)||resolution==='4K')&&!competitive;
  const cpuEvidenceBySku=new Map();
  const cpuPriority = new Map(cpuRows.map(row=>{
    const assessment=assessWorkload(workloadProfile,'cpu',cpuModel(row.component.officialModel||row.product.name,row.product.manufacturer),null,workloadCohorts);
    workloadCpu.set(row.skuOver,assessment);
    const evidence=gaming?cpuEvidence(row.product,
      fact(row.component,CATEGORY_FACT['Процессоры']),row.component.officialModel):null;
    cpuEvidenceBySku.set(row.skuOver,evidence);
    return [row.skuOver, (gaming?(cpuUtilityFromEvidence(evidence)??0):0)+workloadScore(assessment)];
  }));
  const gpuEvidenceBySku=new Map();
  const measuredWorkloadGpu=row=>{
    if(!row)return null;
    if(!workloadGpu.has(row.skuOver)){
      const spec=fact(row.component,CATEGORY_FACT['Видеокарты']);
      workloadGpu.set(row.skuOver,assessWorkload(workloadProfile,'gpu',spec.gpu,spec.memoryGB,workloadCohorts));
    }
    return workloadGpu.get(row.skuOver);
  };
  const graphicsScore=row=>(gaming?(gpuUtilityFromEvidence(row?measuredGpu(row):null)??0):0)+workloadScore(measuredWorkloadGpu(row));
  const measuredGpu=row=>{
    if(!gaming)return null;
    if(!gpuEvidenceBySku.has(row.skuOver))
      gpuEvidenceBySku.set(row.skuOver,gpuEvidence(
        fact(row.component,CATEGORY_FACT['Видеокарты']),tasks,resolution));
    return gpuEvidenceBySku.get(row.skuOver);
  };
  // A requested performance floor must use the same test cohort as candidates,
  // never the manufacturer or digits in a model name.
  const referenceRows=getBenchmarkData().computerbase.resolutions[resolution==='4K'?'4K':'1440p']?.observations||[];
  const graphicsReference=graphicsPreference?referenceRows.find(row=>
    normalizeModel(row.gpu)===normalizeModel(`GeForce ${graphicsPreference}`)):null;
  cpuRows.sort((a,b)=>cpuPriority.get(b.skuOver)-cpuPriority.get(a.skuOver)||byOffer(a,b));
  const resolutionGpuAvailable=!resolutionMinimum||gpuRows.some(row=>{
    const spec=fact(row.component,CATEGORY_FACT['Видеокарты']);
    const evidence=measuredGpu(row);
    return Number.isFinite(spec?.memoryGB)&&spec.memoryGB>=resolutionMinimum.memoryGB&&
      Number.isFinite(evidence?.rankingFps)&&evidence.rankingFps>=resolutionMinimum.referenceFps;
  });

  // Cooling and fan wiring depends on these three parts, not on RAM/SSD/GPU/PSU.
  // Reuse the result only inside this build request, preserving all compatibility checks.
  const caseCoolingCache = new Map();
  const tailFitCache = new Map();
  function caseCooling(boardRow, caseRow, coolerRow) {
    const key = JSON.stringify([boardRow.skuOver,caseRow.skuOver,coolerRow.skuOver]);
    if (caseCoolingCache.has(key)) return caseCoolingCache.get(key);
    const board = fact(boardRow.component, CATEGORY_FACT[boardRow.category]);
    const enclosure = fact(caseRow.component, CATEGORY_FACT[caseRow.category]);
    const cooler = fact(coolerRow.component, CATEGORY_FACT[coolerRow.category]);
    if (!enclosure) {
      needs(`Корпус ${caseRow.skuOver}: не подтверждены характеристики`);
      caseCoolingCache.set(key, null);
      return null;
    }
    const liquidCooler = coolerRow.category === 'Системы водяного / жидкостного охлаждения (СЖО)';
    const evaluate = () => {
      const fanLayout = normalized(enclosure.preinstalledFans || '');
      const hasBuiltInFans = /front|rear|top|bottom|side/i.test(fanLayout);
      const confirmedNoFans = /^(0|нет|none|without)$/i.test(fanLayout);
      if (!hasBuiltInFans && !confirmedNoFans) {
        reviewReasons.add('Нет подтверждённых данных о штатных вентиляторах корпуса');
        return null;
      }
      const needCaseFans = requiredCategories.has('Охлаждение для корпусов ПК') ||
        !!preferred.skus['Охлаждение для корпусов ПК'] || preferred.includeCaseFans===true ||
        preferred.maxFanNoiseDba!==undefined || (gaming && confirmedNoFans);
      let caseFanRow = null;
      let caseFanQuantity = 0;
      if (needCaseFans) {
        caseFanQuantity = gaming && confirmedNoFans ? 2 : 1;
        const mounts = enclosure.fanMounts;
        if (!Array.isArray(mounts) || !Number.isInteger(board.fanHeaders)) {
          reviewReasons.add('Неизвестны свободные места корпуса или разъёмы вентиляторов платы');
          return null;
        }
        if (mounts.length < caseFanQuantity || board.fanHeaders < caseFanQuantity) return null;
        let externalFanPower = false;
        caseFanRow = caseFanRows.find(row => {
          const spec = fact(row.component, CATEGORY_FACT['Охлаждение для корпусов ПК']);
          const size = Number(String(spec?.size || '').match(/\d{2,3}/)?.[0]);
          if(!Number.isFinite(size)||
             mounts.filter(mount => new RegExp(`(?:^|\\D)${size}(?:\\D|$)`).test(String(mount))).length < caseFanQuantity ||
             row.offer.quantity < caseFanQuantity)return false;
          const fit=caseFanHeaderFit(spec?.connector,caseFanQuantity,board.fanHeaders,board.usb2Headers);
          if(fit==='external')externalFanPower=true;
          if(fit==='usb_unknown')reviewReasons.add(`Вентилятор ${row.skuOver}: неизвестно число внутренних разъёмов USB 2.0 на плате`);
          if(fit==='review')reviewReasons.add(`Вентилятор ${row.skuOver}: не распознана схема питания или контроллер`);
          if(fit!=='yes')return false;
          const combined=coolingConnectionFit(board,cooler,{liquid:liquidCooler,
            caseFan:spec,quantity:caseFanQuantity});
          if(combined.fit==='review')reviewReasons.add(`Вентилятор ${row.skuOver}: требуется проверка общего подключения с охлаждением CPU и помпой`);
          return combined.fit==='yes';
        }) || null;
        if (!caseFanRow) {
          if(externalFanPower)reviewReasons.add('Вентилятору с Molex/SATA или контроллером нужна подтверждённая схема подключения к БП/плате');
          return null;
        }
      }
      const coolingFit=coolingConnectionFit(board,cooler,{liquid:liquidCooler,
        caseFan:caseFanRow?fact(caseFanRow.component,CATEGORY_FACT[caseFanRow.category]):null,
        quantity:caseFanQuantity});
      if(coolingFit.fit==='review'){
        needs(`Плата ${boardRow.skuOver} / охлаждение ${coolerRow.skuOver}: требуется проверка разъёмов вентиляторов CPU, помпы, управления или допустимого тока`);
        return null;
      }
      if(coolingFit.fit==='no')return null;
      return { caseFanRow, caseFanQuantity, coolingFit };
    };
    const result = evaluate();
    caseCoolingCache.set(key, result);
    return result;
  }

  let checkedCpus=0;
    const ssdMatches = ssdRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Твердотельные диски (SSD)']);
      if(!Number.isFinite(spec?.capacityGB)||!nonEmpty(spec.formFactor)||
         !nonEmpty(spec.interface)||!nonEmpty(spec.connection)){
        needs(`SSD ${row.skuOver}: не подтверждены объём, форм-фактор, интерфейс или подключение`);return false;
      }
      const m2=/m\.2/i.test(spec.formFactor);
      return (m2 && /^m\.2$/i.test(spec.connection)) ||
        (!m2 && /2[.,]5/.test(spec.formFactor) && /sata/i.test(spec.connection));
    });
    // Price, transfer time and the two utility tiers are the only distinctions
    // between SSDs with the same physical connection for this builder.
    const bestSsdByFit = new Map();
    for (const row of ssdMatches) {
      const spec = fact(row.component, CATEGORY_FACT['Твердотельные диски (SSD)']);
      if(spec.capacityGB<minimumSsdGB)continue;
      const isM2=/m\.2/i.test(spec.formFactor);
      if(isM2?!/sata|pcie|nvme/i.test(spec.interface):!/sata/i.test(spec.interface))continue;
      const connection=isM2?(/sata/i.test(spec.interface)?'m2-sata':'m2-pcie'):'sata-25';
      const storageTier=storageTierFor(spec.capacityGB);
      const speedTier=Math.min(7,Math.floor(Math.min(
        spec.sequentialReadMBs||0,spec.sequentialWriteMBs||0)/1000));
      const key=`${connection}:${storageTier}:${speedTier}`;
      const previous=bestSsdByFit.get(key);
      if(!previous||row.offer.price<previous.offer.price||
         (row.offer.price===previous.offer.price&&(
           row.offer.days<previous.offer.days||
           (row.offer.days===previous.offer.days&&row.skuOver.localeCompare(previous.skuOver)<0))))
        bestSsdByFit.set(key,row);
    }
    const selectedSsds=[...bestSsdByFit.values()].sort(byOffer);
    let graphicsMatches = gpuRequired ? gpuRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Видеокарты']);
      if(!spec?.gpu||!Number.isFinite(spec.dimensions?.lengthMm)||
         !Number.isFinite(spec.recommendedPsuW)||!connectorDemand(spec.powerConnectors)){
        needs(`Видеокарта ${row.skuOver}: не подтверждены модель GPU, длина или питание`);return false;
      }
      const evidence=measuredGpu(row);
      if(gaming&&!evidence&&!preferred.skus['Видеокарты'])
        needs(`Видеокарта ${row.skuOver}: производительность не оценена для игр; нужны проверенные тесты модели`);
      return nonEmpty(spec.gpu) &&
        (!minVramGB||(Number.isFinite(spec.memoryGB)&&spec.memoryGB>=minVramGB)) &&
        (preferred.workloadGpu?.technology!=='cuda'||/\b(?:GeForce|Quadro|NVIDIA)\b/i.test(spec.gpu)) &&
        (!resolutionMinimum||(Number.isFinite(spec.memoryGB)&&
          spec.memoryGB>=resolutionMinimum.memoryGB&&
          Number.isFinite(evidence?.rankingFps)&&evidence.rankingFps>=resolutionMinimum.referenceFps)) &&
        (!graphicsPreference || (graphicsReference&&
          (gpuEvidence(spec,tasks,resolution)?.rankingFps??-1)>=graphicsReference.fps)) &&
        (!gaming||!!evidence||preferred.skus['Видеокарты']===row.skuOver) &&
        Number.isFinite(spec.dimensions?.lengthMm) &&
        Number.isFinite(spec.recommendedPsuW) && !!connectorDemand(spec.powerConnectors);
    }) : [null];
    // Model-number ordering is not workload performance. Keep all compatible
    // candidates: an unrecognised model must not exclude RTX/RX alternatives.
    if(gpuRequired&&!gaming&&!preferred.skus['Видеокарты']){
      // With no workload benchmark score, discard only operationally dominated
      // options. This is a price/fit reduction, NOT a performance comparison.
      const candidates=graphicsMatches.map(row=>({row,spec:fact(row.component,CATEGORY_FACT['Видеокарты'])}));
      graphicsMatches=candidates.filter(({row,spec})=>!candidates.some(other=>{
        if(other.row===row)return false;
        const a=other.row,b=row,x=other.spec,y=spec;
        return graphicsScore(a)>=graphicsScore(b)&&a.offer.price<=b.offer.price&&a.offer.days<=b.offer.days&&
          x.memoryGB>=y.memoryGB&&x.dimensions.lengthMm<=y.dimensions.lengthMm&&
          x.recommendedPsuW<=y.recommendedPsuW&&
          JSON.stringify(connectorDemand(x.powerConnectors))===JSON.stringify(connectorDemand(y.powerConnectors))&&
          (a.offer.price<b.offer.price||a.offer.days<b.offer.days||
            a.skuOver.localeCompare(b.skuOver)<0);
      })).map(item=>item.row);
    }
    graphicsMatches.sort((a,b)=>a&&b?
      (gpuUtilityFromEvidence(measuredGpu(b))-gpuUtilityFromEvidence(measuredGpu(a))||byOffer(a,b)):0);
    const economicalGpuByFit=new Map();
    if(gpuRequired&&!gaming&&!preferred.skus['Видеокарты']){
      // All workload GPUs currently have no measured utility. For a fixed PSU
      // and enclosure, a dearer/later option cannot improve this provisional
      // price/compatibility calculation. Retain ties with differing delivery.
      for(const psuRow of psuRows)for(const caseRow of caseRows){
        const psu=fact(psuRow.component,CATEGORY_FACT['Блоки питания']);
        const enclosure=fact(caseRow.component,CATEGORY_FACT['Корпуса']);
        const fit=graphicsMatches.filter(row=>{
          const spec=fact(row.component,CATEGORY_FACT['Видеокарты']);
          return spec.recommendedPsuW<=psu?.ratedPowerW&&
            spec.dimensions.lengthMm<=enclosure?.maxGpuLengthMm&&gpuPowerFit(spec.powerConnectors,psu)==='yes';
        });
        const selected=fit.filter(row=>!fit.some(other=>other!==row&&
          graphicsScore(other)>=graphicsScore(row)&&other.offer.price<=row.offer.price&&other.offer.days<=row.offer.days&&
          (other.offer.price<row.offer.price||other.offer.days<row.offer.days||other.skuOver.localeCompare(row.skuOver)<0)));
        economicalGpuByFit.set(JSON.stringify([psuRow.skuOver,caseRow.skuOver]),new Set(selected.map(row=>row.skuOver)));
      }
    }

  // Exact reduction for the existing ranking, not a claim of equal real-world
  // performance: keep every different score, socket and compatibility frontier.
  const searchCpus=gaming||preferred.skus['Процессоры']?cpuRows:cpuRows.filter(row=>{
    const spec=fact(row.component,CATEGORY_FACT['Процессоры']);
    const power=cpuCoolingPower(spec,`${row.component.officialModel||''} ${row.product?.name||''}`);
    return !cpuRows.some(other=>{
      if(other===row||other.offer.price>=row.offer.price||other.offer.days>row.offer.days||
         cpuPriority.get(other.skuOver)!==cpuPriority.get(row.skuOver))return false;
      const candidate=fact(other.component,CATEGORY_FACT['Процессоры']);
      const candidatePower=cpuCoolingPower(candidate,`${other.component.officialModel||''} ${other.product?.name||''}`);
      return socketName(candidate?.socket)===socketName(spec?.socket)&&!!socketName(spec?.socket)&&
        Array.isArray(spec?.memoryTypes)&&Array.isArray(candidate?.memoryTypes)&&
        spec.memoryTypes.every(type=>candidate.memoryTypes.includes(type))&&
        Number.isFinite(spec.maxMemoryGB)&&Number.isFinite(candidate.maxMemoryGB)&&candidate.maxMemoryGB>=spec.maxMemoryGB&&
        Number.isFinite(power)&&Number.isFinite(candidatePower)&&candidatePower<=power&&candidatePower>0&&
        (gpuRequired||candidate.integratedGraphics)&&
        JSON.stringify(workloadCpu.get(other.skuOver).tasks.map(t=>t.status))===JSON.stringify(workloadCpu.get(row.skuOver).tasks.map(t=>t.status));
    });
  });
  for (const cpuRow of searchCpus) {
    onProgress?.({completed:checkedCpus++,total:searchCpus.length});
    if(resolutionMinimum&&cpuPriority.get(cpuRow.skuOver)<resolutionMinimum.cpuScore)continue;
    const cpuSpec = fact(cpuRow.component, CATEGORY_FACT['Процессоры']);
    const cpuPowerW = cpuCoolingPower(cpuSpec, `${cpuRow.component.officialModel || ''} ${cpuRow.product?.name || ''}`);
    if (!cpuSpec?.socket || !Array.isArray(cpuSpec.memoryTypes) || !Number.isFinite(cpuPowerW) ||
        !Number.isFinite(cpuSpec.maxMemoryGB)) {
      needs(`Процессор ${cpuRow.skuOver}: не подтверждены сокет, тип памяти, мощность или предел памяти`);continue;
    }
    if (!gpuRequired && !cpuSpec.integratedGraphics) continue;
    if (gaming && (!Number.isFinite(cpuSpec.cores) || cpuSpec.cores < 6)) continue;
    const boardRows = motherboardRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Материнские платы']);
      if(!socketName(spec?.socket)||!socketName(cpuSpec.socket)||!spec?.memoryType||
         !spec.formFactor||typeof spec.rearConnector!=='boolean'||
         !Number.isFinite(spec.memorySlots)||!Number.isFinite(spec.maxMemoryGB)){
        needs(`Плата ${row.skuOver}: не подтверждены сокет, тип памяти, форм-фактор, обратная сторона разъёмов или предел RAM`);return false;
      }
      const chipsetPlatform=chipsetSocket(spec.chipset);
      if(!chipsetPlatform){
        needs(`Плата ${row.skuOver}: не подтверждён или не распознан чипсет`);return false;
      }
      return chipsetPlatform === socketName(spec.socket) &&
        chipsetPlatform === socketName(cpuSpec.socket) && cpuSpec.memoryTypes.includes(spec.memoryType) &&
        spec.formFactor && Number.isFinite(spec.memorySlots) &&
        Number.isFinite(spec.maxMemoryGB);
    });
    const coolerMatches = coolerRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Кулеры для процессоров']);
      const liquid = row.category === 'Системы водяного / жидкостного охлаждения (СЖО)';
      const kind = spec?.type || (liquid ? 'aio' : null);
      if(!Array.isArray(spec?.mountingSockets)||!socketName(cpuSpec.socket)||!Number.isFinite(spec.tdpW)||
         (liquid?!Number.isFinite(spec.radiatorSizeMm):
           !Number.isFinite(spec.dimensionsMm?.heightMm)||!Number.isFinite(spec.tdpW))){
        needs(`Кулер ${row.skuOver}: не подтверждены крепление, размеры или мощность охлаждения`);return false;
      }
      if(gaming&&!kind){needs(`Кулер ${row.skuOver}: не подтверждён тип охлаждения`);return false;}
      return spec.mountingSockets.some(socket=>socketName(socket)===socketName(cpuSpec.socket)) &&
        (liquid ? Number.isFinite(spec.radiatorSizeMm) && spec.radiatorSizeMm >= 240 :
          Number.isFinite(spec.dimensionsMm?.heightMm)) &&
        (!gaming || kind === 'tower' || kind === 'aio') &&
        Number.isFinite(spec.tdpW) && spec.tdpW >= cpuPowerW;
    }).sort(byOffer);
    const memoryMatches = memoryRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Оперативная память']);
      if(!spec?.memoryType||!Number.isFinite(spec.capacityGB)||!Number.isFinite(spec.moduleCount)||
         !nonEmpty(spec.formFactor)){
        needs(`Память ${row.skuOver}: не подтверждены тип, объём, число модулей или форм-фактор`);return false;
      }
      return spec?.memoryType && cpuSpec.memoryTypes.includes(spec.memoryType) &&
        Number.isFinite(spec.capacityGB) && Number.isFinite(spec.moduleCount) &&
        nonEmpty(spec.formFactor) && isDesktopRamFormFactor(spec.formFactor) &&
        spec.capacityGB >= 8;
    });
    const minCoolerPrice=cheapest(coolerMatches);
    const minGpuPrice=cheapest(graphicsMatches);
    const minAfterPsu=cheapest(caseRows)+minCoolerPrice;
    const minAfterGpu=cheapest(psuRows)+minAfterPsu;
    const minTailPrice=minGpuPrice+minAfterGpu+cheapest(hddOptions);
    const minSsdPrice=cheapest(selectedSsds);

    for (const boardRow of boardRows) {
      const board = fact(boardRow.component, CATEGORY_FACT['Материнские платы']);
      const boardScore=boardUtility(board);
      const cpuPowerFits=new Map();
      const memoryProfiles=new Map();
      const profileFor=(row,quantity)=>{
        let profiles=memoryProfiles.get(row);
        if(!profiles){profiles=new Map();memoryProfiles.set(row,profiles);}
        if(!profiles.has(quantity))profiles.set(quantity,memoryProfile(
          fact(row.component,CATEGORY_FACT['Оперативная память']),quantity,board));
        return profiles.get(quantity);
      };
      // Reject impossible cooling combinations before multiplying them by every
      // memory, storage, GPU and PSU option. Final dimensions/power checks still run below.
      const coolersByCase = new Map(caseRows.map(caseRow => [caseRow,
        coolerMatches.filter(coolerRow => caseCooling(boardRow, caseRow, coolerRow))]));
      const cooledCases = caseRows.filter(caseRow => coolersByCase.get(caseRow).length);
      if (!cooledCases.length) continue;
      // Keep the least expensive option for each capacity and module layout.
      // A matched two-module kit must remain available beside loose modules.
      const bestMemoryByProfile=new Map();
      const memoryKey=(row,quantity)=>{
        const spec=fact(row.component,CATEGORY_FACT['Оперативная память']);
        const profile=profileFor(row,quantity);
        return `${spec.capacityGB*quantity}:${gaming?profile.key:profile.tuningUtility}:${namedColor(row)||''}`;
      };
      for(const row of memoryMatches){
        const spec=fact(row.component,CATEGORY_FACT['Оперативная память']);
        for(const quantity of [1,2,4]){
          const capacity=spec.capacityGB*quantity;
          const modules=spec.moduleCount*quantity;
          if(spec.memoryType!==board.memoryType||modules>board.memorySlots||
             capacity>board.maxMemoryGB||capacity>cpuSpec.maxMemoryGB||
             capacity<memoryMinimumGB||capacity>memoryTargetGB||
             (gaming&&modules<2)||row.offer.quantity<quantity)continue;
          const key=memoryKey(row,quantity);
          const previous=bestMemoryByProfile.get(key);
          const price=row.offer.price*quantity;
          const previousPrice=previous?.row.offer.price*previous?.quantity;
          if(!previous||price<previousPrice||
             (price===previousPrice&&(
               row.offer.days<previous.row.offer.days||
               (row.offer.days===previous.row.offer.days&&row.skuOver.localeCompare(previous.row.skuOver)<0))))
            bestMemoryByProfile.set(key,{row,quantity});
        }
      }
      for (const memoryRow of memoryMatches) {
        const ram = fact(memoryRow.component, CATEGORY_FACT['Оперативная память']);
        const quantities=[1,2,4].filter(quantity=>ram.capacityGB*quantity<=memoryTargetGB);
        for(const ramQuantity of quantities) {
        const totalRamGB=ram.capacityGB*ramQuantity;
        const totalRamModules=ram.moduleCount*ramQuantity;
        if (ram.memoryType !== board.memoryType || totalRamModules > board.memorySlots ||
            (Number.isFinite(board.maxMemoryGB) && totalRamGB > board.maxMemoryGB) ||
            (Number.isFinite(cpuSpec.maxMemoryGB) && totalRamGB > cpuSpec.maxMemoryGB) ||
            totalRamGB<memoryMinimumGB || totalRamGB>memoryTargetGB ||
            (gaming && totalRamModules<2) ||
            (memoryRow.offer.quantity<ramQuantity)) continue;
        const memoryChoice=bestMemoryByProfile.get(memoryKey(memoryRow,ramQuantity));
        if(memoryChoice?.row!==memoryRow||memoryChoice.quantity!==ramQuantity)continue;
        const ramProfile=profileFor(memoryRow,ramQuantity);
        const ramUtility=memoryCapacityUtility(totalRamGB)+(gaming?ramProfile.utility:ramProfile.tuningUtility);
        const partialPrice=cpuRow.offer.price+boardRow.offer.price+memoryRow.offer.price*ramQuantity;
        if(!canImproveOnPrice(partialPrice+minSsdPrice+minTailPrice))continue;
        for (const ssdRow of selectedSsds) {
            const ssd = fact(ssdRow.component, CATEGORY_FACT['Твердотельные диски (SSD)']);
            const storageUtility=storageUtilityFor(ssd.capacityGB);
            const ssdSpeedTier=Math.floor(Math.min(ssd.sequentialReadMBs||0,ssd.sequentialWriteMBs||0)/1000);
            if(ssd.capacityGB<minimumSsdGB)continue;
            const isM2 = /m\.2/i.test(ssd.formFactor);
            if(!isM2&&!/2[.,]5/.test(ssd.formFactor))continue;
            const boardM2Interfaces=[board.m2Interface,...(Array.isArray(board.m2Interfaces)?board.m2Interfaces:[])].filter(nonEmpty).join(' ');
            if(isM2){
              if(!Number.isInteger(board.m2Slots)){
                needs(`Плата ${boardRow.skuOver}: не подтверждено количество M.2 слотов`);continue;
              }
              if(!(board.m2Slots>0))continue;
              if(!boardM2Interfaces){
                needs(`Плата ${boardRow.skuOver}: подтверждено M.2 слотов: ${board.m2Slots}, но не подтверждены интерфейсы`);continue;
              }
              if(/sata/i.test(ssd.interface)){if(!/sata/i.test(boardM2Interfaces))continue;}
              else if(/pcie|nvme/i.test(ssd.interface)){if(!/pcie|nvme/i.test(boardM2Interfaces))continue;}
              else continue;
            }else {
              if(!Number.isInteger(board.sataPorts)){
                needs(`Плата ${boardRow.skuOver}: не подтверждено число портов SATA`);continue;
              }
              if(!(/sata/i.test(ssd.interface)&&board.sataPorts>0))continue;
            }
            for (const hddRow of hddOptions) {
              if(hddRow && (!Number.isInteger(board.sataPorts)||
                  board.sataPorts<(isM2?1:2)))continue;
            const storagePrice=partialPrice+ssdRow.offer.price+(hddRow?.offer.price||0);
            if(!canImproveOnPrice(storagePrice+minAfterGpu+minGpuPrice))continue;
            for (const gpuRow of graphicsMatches) {
              const gpu = gpuRow ? fact(gpuRow.component, CATEGORY_FACT['Видеокарты']) : null;
              const unratedCount=(gaming?Number(!cpuEvidenceBySku.get(cpuRow.skuOver))+
                Number(!!gpuRow&&!measuredGpu(gpuRow)):0)+
                workloadCpu.get(cpuRow.skuOver).tasks.filter(task=>task.priority==='primary'&&task.status!=='measured').length+
                (measuredWorkloadGpu(gpuRow)?.tasks.filter(task=>task.priority==='primary'&&task.status!=='measured').length||0);
              if (gpu && !nonEmpty(board.pcieX16)) continue;
              const baseUtility=cpuPriority.get(cpuRow.skuOver)*(competitive?1.5:gpuFocused?0.75:1)+
                graphicsScore(gpuRow)*(competitive?0.75:gpuFocused?1.25:1)+
                boardScore+storageUtility+ramUtility+Math.min(7,ssdSpeedTier)*0.1;
              // Only discard a branch when even its best possible tail cannot win.
              // Keep ties (and a rounding margin) for price and delivery tie-breaks.
              const cannotBeatUtility=upper=>best&&!best.build.overBudget&&
                unratedCount>=(best.build.unratedCount||0)&&upper+1e-9<best.utility;
              if(cannotBeatUtility(baseUtility+10))continue;
              const requiredPsuW = gpu ? gpu.recommendedPsuW : Math.max(400, Math.ceil(cpuPowerW / 0.75 / 50) * 50);
              const gpuPrice=storagePrice+(gpuRow?.offer.price||0);
              if(!canImproveOnPrice(gpuPrice+minAfterGpu))continue;
              for (const psuRow of psuRows) {
                const psu = fact(psuRow.component, CATEGORY_FACT['Блоки питания']);
                const efficiencyUtility = /platinum|titanium/i.test(psu?.efficiencyCertification||'')?3:
                  /gold/i.test(psu?.efficiencyCertification||'')?2:0;
                if(cannotBeatUtility(baseUtility+efficiencyUtility+7))continue;
                if(!Number.isFinite(psu?.ratedPowerW)||!Number.isFinite(psu.lengthMm)||
                   !nonEmpty(psu.formFactor)){
                  needs(`Блок питания ${psuRow.skuOver}: не подтверждены мощность, длина или форм-фактор`);continue;
                }
                if (!Number.isFinite(psu.ratedPowerW) || !Number.isFinite(psu.lengthMm) || psu.ratedPowerW < requiredPsuW ||
                    !/^(ATX|ATX12V|ATX\s)/i.test(psu.formFactor || '')) continue;
                if(!cpuPowerFits.has(psuRow))cpuPowerFits.set(psuRow,
                  cpuPowerConnectorFit(board.cpuPowerConnectors,psu.cpuConnectors));
                const cpuPowerFit=cpuPowerFits.get(psuRow);
                if(cpuPowerFit==='review'){
                  needs(`Плата ${boardRow.skuOver} / блок питания ${psuRow.skuOver}: не подтверждены разъёмы питания CPU`);continue;
                }
                if(cpuPowerFit==='no')continue;
                if(gpu){
                  const gpuFit=gpuPowerFit(gpu.powerConnectors,psu);
                  if(gpuFit==='review'){
                    needs(`Видеокарта ${gpuRow.skuOver} / БП ${psuRow.skuOver}: не подтверждены тип, число разъёмов или отдельных кабелей`);
                    continue;
                  }
                  if(gpuFit==='no')continue;
                }
                const psuPrice=gpuPrice+psuRow.offer.price;
                if(!canImproveOnPrice(psuPrice+minAfterPsu))continue;
                for (const caseRow of cooledCases) {
                  if(economicalGpuByFit.size&&!economicalGpuByFit.get(JSON.stringify([psuRow.skuOver,caseRow.skuOver]))?.has(gpuRow.skuOver))continue;
                  if(!canImproveOnPrice(psuPrice+caseRow.offer.price+minCoolerPrice))continue;
                  const enclosure = fact(caseRow.component, CATEGORY_FACT['Корпуса']);
                  for (const coolerRow of coolersByCase.get(caseRow)) {
                  const cooler = fact(coolerRow.component, CATEGORY_FACT[coolerRow.category]);
                  const liquidCooler = coolerRow.category === 'Системы водяного / жидкостного охлаждения (СЖО)';
                  const balanceUtility=balanceBonus(caseReferencePrices.get(caseRow.skuOver),budget,BALANCED_SPEND.caseShare,
                    caseCapability(enclosure,gpu,cooler))+
                    balanceBonus(coolerReferencePrices.get(coolerRow.skuOver),budget,BALANCED_SPEND.coolingShare,
                      Math.max(0,(cooler.tdpW/cpuPowerW-1)/0.5));
                  if(cannotBeatUtility(baseUtility+efficiencyUtility+coolingUtility(cooler,liquidCooler)+balanceUtility))continue;
                  const tailKey=JSON.stringify([boardRow.skuOver,gpuRow?.skuOver||null,psuRow.skuOver,caseRow.skuOver,coolerRow.skuOver,isM2,!!hddRow]);
                  let cooling=tailFitCache.get(tailKey);
                  if(cooling===undefined){
                    cooling=(()=>{
                      if(!Array.isArray(enclosure?.motherboardFormFactors)||
                         (!liquidCooler&&!Number.isFinite(enclosure.maxCpuCoolerHeightMm))||
                         (gpu&&!Number.isFinite(enclosure.maxGpuLengthMm))||
                         !Number.isFinite(enclosure.maxPsuLengthMm)||
                         (liquidCooler&&!Array.isArray(enclosure.radiatorSupport))){
                        needs(`Корпус ${caseRow.skuOver}: не подтверждены ограничения платы, охлаждения, GPU или БП`);return null;
                      }
                      const boardCaseFit=motherboardCaseFit(board,enclosure.motherboardFormFactors);
                      if(boardCaseFit==='review'){
                        needs(`Плата ${boardRow.skuOver} / корпус ${caseRow.skuOver}: не подтверждены обычное или Rear Connector исполнение`);return null;
                      }
                      const radiatorFit=liquidCooler?
                        caseSupportsRadiator(enclosure.radiatorSupport,cooler.radiatorSizeMm):'yes';
                      if(radiatorFit==='review'){
                        needs(`Корпус ${caseRow.skuOver}: расположение радиатора ${cooler.radiatorSizeMm} мм требует проверки`);
                        return null;
                      }
                      if (boardCaseFit==='no' ||
                          (!liquidCooler && !Number.isFinite(enclosure.maxCpuCoolerHeightMm)) ||
                          (!liquidCooler && cooler.dimensionsMm.heightMm > enclosure.maxCpuCoolerHeightMm) ||
                          radiatorFit==='no' ||
                          (gpu && !Number.isFinite(enclosure.maxGpuLengthMm)) ||
                          (gpu && gpu.dimensions.lengthMm > enclosure.maxGpuLengthMm) ||
                          !Number.isFinite(enclosure.maxPsuLengthMm) ||
                          (Number.isFinite(psu.lengthMm) && psu.lengthMm > enclosure.maxPsuLengthMm)) return null;
                      if(!enclosure.psuFormFactors){needs(`Корпус ${caseRow.skuOver}: не подтверждены поддерживаемые форм-факторы БП`);return null;}
                      const supported=Array.isArray(enclosure.psuFormFactors)?enclosure.psuFormFactors:[enclosure.psuFormFactors];
                      const psuFormat=String(psu.formFactor||'').toUpperCase().match(/ATX|SFX-L|SFX/)?.[0];
                      if(!psuFormat){needs(`Блок питания ${psuRow.skuOver}: не распознан форм-фактор`);return null;}
                      if(!supported.some(value=>String(value).toUpperCase().startsWith(psuFormat)))return null;
                      const bayFit=driveBayFit(enclosure,isM2?0:1,hddRow?1:0);
                      if(bayFit==='review'){
                        needs(`Корпус ${caseRow.skuOver}: не подтверждены общие места для HDD и SSD`);
                        return null;
                      }
                      if(bayFit==='no')return null;
                      const cooling = caseCooling(boardRow, caseRow, coolerRow);
                      if (!cooling) return null;

                      return cooling;
                    })();
                    tailFitCache.set(tailKey,cooling);
                  }
                  if(!cooling)continue;
                  const { caseFanRow, caseFanQuantity, coolingFit } = cooling;
                  const total = psuPrice+caseRow.offer.price+coolerRow.offer.price+(caseFanRow?caseFanRow.offer.price*caseFanQuantity:0);
                  if(preferred.maxTotal!==undefined&&total>preferred.maxTotal)continue;
                  const maxTransferBusinessDays = Math.max(cpuRow.offer.days,boardRow.offer.days,memoryRow.offer.days,ssdRow.offer.days,hddRow?.offer.days||0,gpuRow?.offer.days||0,psuRow.offer.days,caseRow.offer.days,coolerRow.offer.days,caseFanRow?.offer.days||0);
                  // Treat 1000/1024, 2000/2048 GB as the same capacity class.
                  // Capacity beyond the useful target is not a reason to spend more.
                  // Rated sequential throughput is a secondary SSD criterion,
                  // not a claim about application or sustained-write speed.
                   const performanceEvidence=gpuRow?measuredGpu(gpuRow):null;
                  const processorEvidence=cpuEvidenceBySku.get(cpuRow.skuOver);
                  const gpuUtility = graphicsScore(gpuRow);
                  const caseColor=namedColor(caseRow),coolerColor=namedColor(coolerRow),
                    memoryColor=namedColor(memoryRow);
                  const colorMismatchPenalty=(caseColor&&coolerColor&&caseColor!==coolerColor?0.5:0)+
                    (caseColor&&memoryColor&&caseColor!==memoryColor?0.5:0);
                  const unrequestedWhiteCasePenalty=!whiteBuild&&caseColor==='white'&&!isWhite(boardRow)?0.5:0;
                  // Spend share is a capped balance preference, not measured performance.
                  const utility = cpuPriority.get(cpuRow.skuOver)*(competitive?1.5:gpuFocused?0.75:1) +
                    gpuUtility*(competitive?0.75:gpuFocused?1.25:1) + boardScore + storageUtility + ramUtility +
                    Math.min(7,ssdSpeedTier)*0.1 + efficiencyUtility +
                    coolingUtility(cooler,liquidCooler)+balanceUtility-colorMismatchPenalty-unrequestedWhiteCasePenalty;
                  buildCount++;
                  const overBudget=total>budget;
                  if(best){
                    const previous=best.build;
                    if((overBudget&&!previous.overBudget)||
                       (overBudget&&previous.overBudget&&total>previous.total)||
                       (!overBudget&&!previous.overBudget&&unratedCount>(previous.unratedCount||0))||
                       (!overBudget&&!previous.overBudget&&unratedCount===(previous.unratedCount||0)&&utility<best.utility)||
                       (overBudget===previous.overBudget&&unratedCount===(previous.unratedCount||0)&&
                        (overBudget?total===previous.total:utility===best.utility)&&
                        (total>previous.total||(total===previous.total&&
                         maxTransferBusinessDays>previous.maxTransferBusinessDays))))continue;
                  }
                  const parts = [cpuRow,boardRow,{...memoryRow,quantity:ramQuantity},...(gpuRow?[gpuRow]:[]),ssdRow,
                    ...(hddRow?[hddRow]:[]),psuRow,caseRow,coolerRow,
                    ...(caseFanRow ? [{...caseFanRow,quantity:caseFanQuantity}] : [])];
                  if(Object.entries(preferred.skus).some(([category,sku])=>
                    !parts.some(row=>row.category===category&&row.skuOver===sku)))continue;
                  if ([...requiredCategories].some(category => !parts.some(row => row.category === category))) continue;
                  const candidate = {
                    city: destinationCity,purpose,tasks,budget,rulesVersion,total,overBudget,unratedCount,
                    workloadProfile,workloadAssessment:{cpu:workloadCpu.get(cpuRow.skuOver),gpu:measuredWorkloadGpu(gpuRow)},
                    ...(performanceEvidence?{performanceEvidence}:{}),
                    ...(gpuRow?{gpuAssessment:gpuAssessment(
                      fact(gpuRow.component,CATEGORY_FACT['Видеокарты']),performanceEvidence)}:{}),
                    cpuAssessment:{model:cpuModel(cpuRow.product.name,cpuRow.product.manufacturer),
                      status:processorEvidence?'measured':'not_evaluated',
                      label:processorEvidence?'Производительность оценена':'Производительность не оценена',
                      score:cpuUtilityFromEvidence(processorEvidence)},
                    ...(processorEvidence?{processorEvidence}:{}),
                    maxTransferBusinessDays,
                    warnings: [...frontUsbWarnings(enclosure.frontUsbHeaders,board.internalUsbHeaders),...coolingFit.warnings,
                      ...workloadGaps(workloadCpu.get(cpuRow.skuOver),measuredWorkloadGpu(gpuRow)),
                      ...(memoryProfileSupport(ram,board).advertised?[memoryProfileSupport(ram,board).common.length?
                        'Память и плата поддерживают общий профиль EXPO/XMP. Заявленная частота требует настройки BIOS и проверки стабильности сборки.':
                        'Поддержка заявленного профиля EXPO/XMP выбранной платой не подтверждена; частота и тайминги профиля не гарантированы.']:[]),
                      ...((gaming&&(!processorEvidence||gpuRow&&!performanceEvidence))||
                        workloadCpu.get(cpuRow.skuOver).tasks.some(task=>task.status!=='measured')||
                        measuredWorkloadGpu(gpuRow)?.tasks.some(task=>task.status!=='measured')?
                        ['Для выбранных задач нет подтверждённых тестов всех CPU/GPU этой сборки. Совместимость проверена; оптимальность по производительности не подтверждена.']:[])],
                    parts: parts.map(row => ({skuOver:row.product.skuOver,category:row.category,
                      name:row.product.name,productUrl:row.product.productUrl||null,quantity:row.quantity||1,price:row.offer.price*(row.quantity||1),supplier:row.offer.supplier,
                      transferBusinessDays:row.offer.days,stock:row.offer.quantity}))
                  };
                  const ranked = {build:candidate,utility};
                  if (!best || compareBuilds(ranked,best)<0) best=ranked;
                }
              }
            }
            }
          }
        }
        }
      }
    }
  }
  onProgress?.({completed:searchCpus.length,total:searchCpus.length});
  if (!best){
    if(resolutionMinimum&&!resolutionGpuAvailable)
      return {ok:false,code:'resolution_requirement_unmet',city:destinationCity,
        resolution,minimumReferenceFps:resolutionMinimum.referenceFps,
        minimumVramGB:resolutionMinimum.memoryGB,rulesVersion};
    const relevant=new Set(inventory.map(row=>row.category).filter(category=>gaming||category!=='Видеокарты'));
    const reasons=[...reviewReasons,...uncheckedRules(currentRules,relevant)];
    if(whiteBuild||preferred.colorPreference||preferred.platformPreference||preferred.coolerType||Object.keys(preferred.skus).length||preferred.includeGpu||preferred.includeHdd||
       preferred.includeCaseFans||preferred.minMemoryGB||preferred.maxTotal||
       preferred.maxCoolerNoiseDba!==undefined||preferred.maxFanNoiseDba!==undefined||
       Object.keys(preferred.cheaperThan||{}).length)
      return {ok:false,code:'requested_part_no_build',city:destinationCity,
        reasons:reasons.slice(0,20),rulesVersion};
    return reasons.length?{ok:false,code:'needs_review',city:destinationCity,
      reasons:reasons.slice(0,20),rulesVersion}:{ok:false,code:'no_verified_build',city:destinationCity};
  }
  const selected = best.build;
  if(gaming&&selected.cpuAssessment.status==='not_evaluated'&&!preferred.skus['Процессоры'])
    return {ok:false,code:'needs_review',city:destinationCity,rulesVersion,
      reasons:['Для совместимых процессоров этой сборки нет подтверждённых игровых тестов. Нужна оценка модели перед автоматической рекомендацией.']};
  if(resolutionMinimum&&selected.total>Math.floor(budget*1.05))
    return {ok:false,code:'resolution_budget_unmet',city:destinationCity,resolution,
      minimumTotal:selected.total,budgetLimit:Math.floor(budget*1.05),rulesVersion};
  const fpsEstimate=gaming?pcBuildsEstimate(selected.parts,tasks,
    requests1440p(tasks,resolution)?'1440p':resolution):null;
  const selectedCategories=new Set(selected.parts.map(part=>part.category));
  const coverageReasons=uncheckedRules(currentRules,selectedCategories);
  if(coverageReasons.length)return {ok:false,code:'needs_review',city:destinationCity,
    reasons:coverageReasons.slice(0,20),rulesVersion};
  const createdAt=new Date().toISOString();
  let schedule;
  try { schedule=buildSchedule(createdAt, selected.maxTransferBusinessDays, localData.getOperations?.() || {}, {parts:selected.parts,destinationCity,destinationBranch,requireBranches:typeof localData.getOperations==='function'}); }
  catch { return {ok:false,code:'needs_review',city:destinationCity,reasons:['Проверьте календари складов отправления и филиала сборки.'],rulesVersion}; }
  return {ok:true,utility:best.utility,build:{...selected,advantages:buildAdvantages(selected.parts,inventory),...schedule,...(fpsEstimate?{fpsEstimate}:{}),createdAt,expiresAt:new Date(Date.parse(createdAt)+86400000).toISOString(),priceValidDays:1,
    assemblyFree:true,alternatives:buildCount-1,
    remainingBudget:Math.max(0,budget-selected.total)}};
}

function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function caseSupportsRadiator(support, sizeMm) {
  if(!Array.isArray(support)||!Number.isFinite(sizeMm))return 'review';
  let uncertain=false;
  for(const row of support){
    for(const segment of String(row).split(';')){
      if(!/top|front|side|bottom/i.test(segment))continue;
      if(new RegExp(`(?:^|\\D)${Number(sizeMm)}(?:\\D|$)`).test(segment))return 'yes';
      const max=Number(segment.match(/up to\s*(\d+)|до\s*(\d+)/i)?.slice(1).find(Boolean));
      if(Number.isFinite(max)&&max>=sizeMm)uncertain=true;
    }
  }
  return uncertain?'review':'no';
}
function compareBuilds(a,b) {
  return Number(a.build.overBudget)-Number(b.build.overBudget) ||
    (!a.build.overBudget ? (a.build.unratedCount||0)-(b.build.unratedCount||0) : 0) ||
    (a.build.overBudget ? a.build.total-b.build.total : b.utility-a.utility) ||
    a.build.total-b.build.total || a.build.maxTransferBusinessDays-b.build.maxTransferBusinessDays ||
    a.build.parts.map(p=>p.skuOver).join(':').localeCompare(b.build.parts.map(p=>p.skuOver).join(':'));
}

module.exports = {buildPc, getOffer, driveBayFit, cpuPowerConnectorFit, gpuPowerFit, caseFanHeaderFit, motherboardCaseFit, CATEGORY_FACT,
  socketName,chipsetSocket,caseSupportsRadiator,frontUsbWarnings,isDesktopRamFormFactor,uncheckedRules,resolutionRequirements};
