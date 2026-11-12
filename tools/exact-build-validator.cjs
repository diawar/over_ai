'use strict';
// Experimental: no production route calls this module yet. No ranking or search.
const {createHash}=require('node:crypto');
const {CATEGORY_FACT,socketName,chipsetSocket,driveBayFit,cpuPowerConnectorFit,gpuPowerFit,
  motherboardCaseFit,caseSupportsRadiator,frontUsbWarnings,isDesktopRamFormFactor,uncheckedRules,
  caseFanHeaderFit,resolutionRequirements}=require('./pc-builder.cjs');
const {cpuCoolingPower}=require('./cpu-cooling-power.cjs');
const {coolingConnectionFit}=require('./cooling-connectors.cjs');
const {buildSchedule}=require('./branch-calendar.cjs');
const {validSku}=require('./catalog-sku.cjs');
const {validatePartPreferences}=require('./part-preferences.cjs');
const {profileFor,workloadRequirements}=require('./workload-profile.cjs');
const {gpuEvidence,cpuEvidence,cpuUtilityFromEvidence,getBenchmarkData}=require('./performance-evidence.cjs');
const {normalizeModel}=require('./model-identity.cjs');
const C={cpu:'Процессоры',board:'Материнские платы',ram:'Оперативная память',gpu:'Видеокарты',
  ssd:'Твердотельные диски (SSD)',hdd:'Жесткие диски 3.5" (для ПК)',psu:'Блоки питания',
  case:'Корпуса',air:'Кулеры для процессоров',aio:'Системы водяного / жидкостного охлаждения (СЖО)',fan:'Охлаждение для корпусов ПК'};
const positive=v=>Number.isFinite(v)&&v>0;

function createExactBuildValidator({localData,organizationId,city,pickupBranch,request}){
  if(!Number.isSafeInteger(organizationId)||organizationId<1||typeof city!=='string'||!city.trim())throw Error('invalid_scope');
  if(!request||!Number.isSafeInteger(request.budget)||request.budget<1||
    !['AMD','Intel','На усмотрение специалиста'].includes(request.cpu)||
    !['Для офиса','Для игр','Для работы и творчества'].includes(request.purpose))throw Error('invalid_customer_request');
  request=structuredClone(request);
  const preferences=validatePartPreferences(request.partPreferences);
  const workload=workloadRequirements(profileFor(request.purpose,preferences));
  const branches=localData.getBranches?.(city);
  if(branches&&!branches.some(b=>b.code===pickupBranch))throw Error('exact_destination_required');
  // One branch only: never merge mutually unreachable stock from several destinations.
  const rows=structuredClone(localData.getBuildCandidates(city,pickupBranch));
  const rules=structuredClone(localData.getRules?.()||[]),operations=structuredClone(localData.getOperations?.()||{});
  const rulesVersion=localData.getRulesVersion?.()||null;
  const index=new Map();
  for(const row of rows){
    if(!validSku(row.skuOver)||index.has(row.skuOver))throw Error('invalid_catalog_snapshot');
    index.set(row.skuOver,row);
  }
  const snapshotId=createHash('sha256').update(JSON.stringify({organizationId,city,pickupBranch,rows,rules,operations,rulesVersion,request})).digest('hex');
  function validate(proposal){
    const violations=[],unknowns=[],warnings=[];
    const issue=(code,detail)=>violations.push({code,detail});
    const unknown=(code,detail)=>unknowns.push({code,detail});
    const fit=(code,result)=>result==='review'?unknown(code,'Недостаточно подтверждённых характеристик'):result!=='yes'?issue(code,'Несовместимо'):null;
    const result=()=>({ok:!violations.length&&!unknowns.length,snapshotId,organizationId,city,pickupBranch,rulesVersion,violations,unknowns,warnings});
    if(!proposal||proposal.snapshotId!==snapshotId){issue('snapshot_mismatch','Нужен актуальный снимок выбранной организации и филиала');return result();}
    if(proposal.budget!==undefined&&proposal.budget!==request.budget){issue('customer_budget_mismatch','AI не может менять бюджет клиента');return result();}
    if(!Array.isArray(proposal.parts)||!proposal.parts.length||proposal.parts.length>12){issue('invalid_proposal','Неверный список товаров');return result();}
    const selected=new Map(),seen=new Set();
    for(const part of proposal.parts){
      if(!part||!validSku(part.skuOver)||!Number.isSafeInteger(part.quantity)||part.quantity<1||part.quantity>32){issue('invalid_part','Неверный SKU или количество');continue;}
      if(seen.has(part.skuOver)){issue('duplicate_sku',part.skuOver);continue;}seen.add(part.skuOver);
      const row=index.get(part.skuOver);
      if(!row){issue('sku_unavailable',part.skuOver);continue;}
      if(!Object.values(C).includes(row.category)||selected.has(row.category)){issue('unsupported_composition',row.category);continue;}
      if(part.category!==undefined&&part.category!==row.category)issue('category_mismatch',part.skuOver);
      if(![C.ram,C.fan].includes(row.category)&&part.quantity!==1)issue('unsupported_quantity',part.skuOver);
      if(!positive(row.offer?.price)||!Number.isSafeInteger(row.offer?.quantity)||row.offer.quantity<part.quantity)issue('offer_unavailable',part.skuOver);
      if(!Number.isInteger(row.offer?.days)||row.offer.days<0)unknown('delivery_unknown',part.skuOver);
      const spec=row.component?.facts?.[CATEGORY_FACT[row.category]]?.value;
      if(!spec)unknown('specifications_missing',part.skuOver);
      selected.set(row.category,{row,spec:spec||{},quantity:part.quantity});
    }
    for(const cat of [C.cpu,C.board,C.ram,C.ssd,C.psu,C.case,...rules.filter(r=>r.required).map(r=>r.category)])
      if(!selected.has(cat))issue('missing_category',cat);
    if(Number(selected.has(C.air))+Number(selected.has(C.aio))!==1)issue('cooling_required','Нужно ровно одно охлаждение CPU');
    if(violations.length||unknowns.length)return result();
    const item=k=>selected.get(C[k]);
    const cpu=item('cpu').spec,board=item('board').spec,ram=item('ram').spec,ssd=item('ssd').spec,
      psu=item('psu').spec,enclosure=item('case').spec,gpu=item('gpu')?.spec,
      cooling=item('air')||item('aio'),cooler=cooling.spec,liquid=selected.has(C.aio),fan=item('fan');
    for(const [category,sku] of Object.entries(preferences.skus))
      if(selected.get(category)?.row.skuOver!==sku)issue('pinned_part_mismatch',category);
    if(request.cpu!=='На усмотрение специалиста'&&item('cpu').row.product.manufacturer!==request.cpu)issue('cpu_brand_mismatch',request.cpu);
    if(preferences.platformPreference&&socketName(cpu.socket)!==preferences.platformPreference)issue('platform_preference_mismatch',preferences.platformPreference);
    if(preferences.coolerType&&liquid!==(preferences.coolerType==='aio'))issue('cooler_preference_mismatch',preferences.coolerType);
    for(const [key,cat] of [['includeGpu',C.gpu],['includeHdd',C.hdd],['includeCaseFans',C.fan]])
      if(preferences[key]===true&&!selected.has(cat))issue('required_optional_part',cat);
    const gpuRequired=request.purpose==='Для игр'||workload.requiresGpu||preferences.workloadGpu?.mode==='required'||
      preferences.workloadProfile?.tasks.some(t=>t.application==='gaming'||t.operation==='gpu_render');
    if(gpuRequired&&!gpu)issue('workload_gpu_required','Для задач клиента нужна GPU');
    const minVram=Math.max(workload.minVramGB,preferences.workloadGpu?.minVramGB||0);
    if(minVram&&gpu){if(!positive(gpu.memoryGB))unknown('vram_unknown','Объём VRAM');else if(gpu.memoryGB<minVram)issue('vram_insufficient',String(minVram));}
    if(preferences.workloadGpu?.technology==='cuda'&&gpu&&!/\b(?:GeForce|Quadro|NVIDIA)\b/i.test(gpu.gpu||''))issue('cuda_required','Требуется CUDA');
    if(ram.capacityGB*item('ram').quantity<Math.max(workload.minMemoryGB,preferences.minMemoryGB||0))issue('requested_memory_insufficient','Объём RAM');
    if(preferences.colorPreference==='white')for(const cat of [C.board,C.ram,C.psu,C.case,C.gpu,C.air,C.aio,C.fan]){
      const part=selected.get(cat);if(!part)continue;
      if(!part.spec.color)unknown('color_unknown',cat);
      else if(String(part.spec.color).trim().toLowerCase()!=='белый')issue('color_mismatch',cat);
    }
    for(const [limit,part] of [[preferences.maxCoolerNoiseDba,cooling],[preferences.maxFanNoiseDba,fan]])if(limit!==undefined){
      if(!positive(part?.spec.noiseDba))unknown('noise_unknown','Нет подтверждённого уровня шума');
      else if(part.spec.noiseDba>=limit)issue('noise_limit','Не выполнено требование снизить шум');
    }
    for(const [cat,limit] of Object.entries(preferences.cheaperThan||{})){
      const part=[C.air,C.aio].includes(cat)?cooling:selected.get(cat);
      if(!part||part.row.offer.price>=limit)issue('cheaper_part_required',cat);
    }
    const gaming=request.purpose==='Для игр'||preferences.workloadProfile?.tasks.some(t=>t.application==='gaming');
    if(gaming&&gpu){
      const resolution=preferences.gamingResolution;
      const evidence=gpuEvidence(gpu,request.tasks||'',resolution);
      const floor=resolutionRequirements(resolution);
      if(!evidence)warnings.push('Нет подтверждённого игрового теста GPU; производительность не оценена.');
      if(floor){
        if(!positive(gpu.memoryGB))unknown('resolution_vram_unknown','Нет подтверждённого объёма VRAM');
        else if(gpu.memoryGB<floor.memoryGB)issue('resolution_requirement_unmet',resolution);
        if(!Number.isFinite(evidence?.rankingFps))unknown('resolution_evidence_unknown','Нет подтверждённого теста для требуемого разрешения');
        else if(evidence.rankingFps<floor.referenceFps)issue('resolution_requirement_unmet',resolution);
        if(floor.cpuScore){
          const score=cpuUtilityFromEvidence(cpuEvidence(item('cpu').row.product,cpu,item('cpu').row.component.officialModel));
          if(!Number.isFinite(score))unknown('resolution_cpu_unknown','Нет подтверждённого теста CPU');
          else if(score<floor.cpuScore)issue('resolution_cpu_insufficient',resolution);
        }
      }
    }
    if(request.graphicsPreference){
      const resolution=preferences.gamingResolution;
      const reference=getBenchmarkData().computerbase.resolutions[resolution==='4K'?'4K':'1440p']?.observations.find(r=>
        normalizeModel(r.gpu)===normalizeModel(`GeForce ${request.graphicsPreference}`));
      const evidence=gpu&&gpuEvidence(gpu,request.tasks||'',resolution);
      if(!reference||!Number.isFinite(evidence?.rankingFps))unknown('graphics_preference_unknown','Нет сопоставимого теста запрошенного уровня GPU');
      else if(evidence.rankingFps<reference.fps)issue('graphics_preference_unmet',request.graphicsPreference);
    }
    for(const reason of uncheckedRules(rules,new Set(selected.keys())))unknown('unchecked_required_rule',reason);
    const socket=socketName(cpu.socket),boardSocket=socketName(board.socket),chipset=chipsetSocket(board.chipset);
    if(!socket||!boardSocket||!chipset)unknown('platform_unknown','Сокет CPU/платы или чипсет');
    else if(socket!==boardSocket||socket!==chipset)issue('platform_mismatch','Сокет CPU, платы и чипсет');
    if(!gpu){if(cpu.integratedGraphics===false)issue('graphics_missing','Нет дискретной или встроенной графики');else if(cpu.integratedGraphics!==true)unknown('graphics_unknown','Встроенная графика');}
    if(!Array.isArray(cpu.memoryTypes)||!board.memoryType||!ram.memoryType||!ram.formFactor)unknown('memory_type_unknown','Тип памяти');
    else if(!cpu.memoryTypes.includes(ram.memoryType)||ram.memoryType!==board.memoryType||!isDesktopRamFormFactor(ram.formFactor))issue('memory_type_mismatch','Тип/форм-фактор памяти');
    if(![ram.capacityGB,ram.moduleCount,board.memorySlots,board.maxMemoryGB,cpu.maxMemoryGB].every(positive))unknown('memory_capacity_unknown','Объём и слоты памяти');
    else if(ram.moduleCount*item('ram').quantity>board.memorySlots||ram.capacityGB*item('ram').quantity>Math.min(board.maxMemoryGB,cpu.maxMemoryGB))issue('memory_capacity_exceeded','Превышены слоты или предел RAM');
    const power=cpuCoolingPower(cpu,`${item('cpu').row.component.officialModel||''} ${item('cpu').row.product?.name||''}`);
    if(!positive(power)||!positive(cooler.tdpW)||!Array.isArray(cooler.mountingSockets))unknown('cooling_unknown','Мощность или крепление охлаждения');
    else if(cooler.tdpW<power||!cooler.mountingSockets.some(s=>socketName(s)===socket))issue('cooling_mismatch','Крепление или недостаточная мощность охлаждения');
    fit('board_case_fit',motherboardCaseFit(board,enclosure.motherboardFormFactors));
    if(liquid)fit('radiator_fit',caseSupportsRadiator(enclosure.radiatorSupport,cooler.radiatorSizeMm));
    else if(!positive(cooler.dimensionsMm?.heightMm)||!positive(enclosure.maxCpuCoolerHeightMm))unknown('cooler_height_unknown','Высота охлаждения');
    else if(cooler.dimensionsMm.heightMm>enclosure.maxCpuCoolerHeightMm)issue('cooler_too_tall','Высота охлаждения');
    fit('cpu_power_connectors',cpuPowerConnectorFit(board.cpuPowerConnectors,psu.cpuConnectors));
    if(gpu){
      fit('gpu_power_connectors',gpuPowerFit(gpu.powerConnectors,psu));
      const powerFinding=[...unknowns,...violations].find(v=>v.code==='gpu_power_connectors');
      if(powerFinding)powerFinding.context={gpuSku:item('gpu').row.skuOver,psuSku:item('psu').row.skuOver,
        gpuPowerConnectors:gpu.powerConnectors??null,psuPcieConnectors:psu.pcieConnectors??null,
        hint:'Check connector kinds, plug counts AND separately documented cable counts. Multiple GPU sockets require the existing validator cable rule; cables:null is unknown, not equal to count. More PSU watts does not resolve missing cables. Inspect another PSU with recorded cables or another GPU, keeping workload and budget constraints. Never invent cables from raw text.'};
      if(!board.pcieX16)unknown('gpu_slot_unknown','Слот PCIe x16');
      if(!positive(gpu.dimensions?.lengthMm)||!positive(enclosure.maxGpuLengthMm))unknown('gpu_length_unknown','Длина GPU');
      else if(gpu.dimensions.lengthMm>enclosure.maxGpuLengthMm)issue('gpu_too_long','Длина GPU');
    }
    const requiredPower=gpu?gpu.recommendedPsuW:positive(power)?Math.max(400,Math.ceil(power/0.75/50)*50):null;
    if(!positive(requiredPower)||!positive(psu.ratedPowerW))unknown('psu_power_unknown','Мощность БП');
    else if(psu.ratedPowerW<requiredPower)issue('psu_insufficient','Мощность БП');
    if(!positive(psu.lengthMm)||!positive(enclosure.maxPsuLengthMm))unknown('psu_length_unknown','Длина БП');
    else if(psu.lengthMm>enclosure.maxPsuLengthMm)issue('psu_too_long','Длина БП');
    const formats=Array.isArray(enclosure.psuFormFactors)?enclosure.psuFormFactors:[enclosure.psuFormFactors];
    const format=String(psu.formFactor||'').toUpperCase().match(/ATX|SFX-L|SFX/)?.[0];
    if(!format||!formats.some(Boolean))unknown('psu_format_unknown','Форм-фактор БП');
    else if(!formats.some(v=>String(v).toUpperCase().startsWith(format)))issue('psu_format_mismatch','Форм-фактор БП');
    const m2=/m\.2/i.test(ssd.formFactor||'');
    if(!ssd.formFactor||!ssd.interface||!positive(ssd.capacityGB))unknown('storage_unknown','Интерфейс/форм-фактор SSD');
    else if(m2){
      const interfaces=[board.m2Interface,...(Array.isArray(board.m2Interfaces)?board.m2Interfaces:[])].filter(Boolean).join(' ');
      if(!Number.isInteger(board.m2Slots)||!interfaces)unknown('m2_unknown','Слоты/интерфейсы M.2');
      else if(board.m2Slots<1||(/sata/i.test(ssd.interface)?!/sata/i.test(interfaces):/pcie|nvme/i.test(ssd.interface)?!/pcie|nvme/i.test(interfaces):true))issue('m2_mismatch','Интерфейс M.2');
    }else if(!/2[.,]5/.test(ssd.formFactor)||!/sata/i.test(ssd.interface))unknown('storage_unsupported','Неподдерживаемый интерфейс SSD');
    const sata=(m2?0:1)+(item('hdd')?1:0);
    if(sata){if(!Number.isInteger(board.sataPorts))unknown('sata_unknown','Порты SATA');else if(board.sataPorts<sata)issue('sata_insufficient','Порты SATA');}
    fit('drive_bays',driveBayFit(enclosure,m2?0:1,item('hdd')?1:0));
    if(item('hdd')){
      const hdd=item('hdd').spec;
      if(!positive(hdd.capacityGB)||!hdd.formFactor||!hdd.interface||!hdd.connection)unknown('hdd_unknown','Ёмкость, интерфейс или форм-фактор HDD');
      else if(!/3[.,]5/.test(hdd.formFactor)||!/sata/i.test(hdd.interface)||!/sata/i.test(hdd.connection))issue('hdd_interface_mismatch','Нужен HDD 3.5 SATA');
    }
    if(fan){
      fit('case_fan_headers',caseFanHeaderFit(fan.spec.connector,fan.quantity,board.fanHeaders,board.usb2Headers));
      const size=Number(String(fan.spec.size||'').match(/\d{2,3}/)?.[0]);
      if(!size||!Array.isArray(enclosure.fanMounts))unknown('fan_mounts_unknown','Крепления вентиляторов');
      else if(enclosure.fanMounts.filter(m=>new RegExp(`(?:^|\\D)${size}(?:\\D|$)`).test(String(m))).length<fan.quantity)issue('fan_mounts_insufficient','Крепления вентиляторов');
    }
    if(!enclosure.preinstalledFans)unknown('case_fans_unknown','Штатные вентиляторы корпуса');
    const wiring=coolingConnectionFit(board,cooler,{liquid,caseFan:fan?.spec||null,quantity:fan?.quantity||0});
    fit('cooling_wiring',wiring.fit);
    if(wiring.fit!=='yes'){
      const finding=[...unknowns,...violations].find(v=>v.code==='cooling_wiring');
      const missingEvidence=[];
      if(!Array.isArray(board.coolingHeaders))missingEvidence.push('board.coolingHeaders');
      else board.coolingHeaders.forEach((h,i)=>{if(!Array.isArray(h.control))missingEvidence.push(`board.coolingHeaders[${i}].control`);if(!Number.isInteger(h.pins))missingEvidence.push(`board.coolingHeaders[${i}].pins`);if(!Number.isFinite(h.max_current_a))missingEvidence.push(`board.coolingHeaders[${i}].max_current_a`);});
      for(const [path,connectors] of [['cooler.fanConnectors',cooler.fanConnectors],
        ...(liquid?[['cooler.pumpConnectors',cooler.pumpConnectors]]:[]),
        ...(fan?[['caseFan.connector',fan.spec.connector]]:[])]){
        if(!Array.isArray(connectors)){missingEvidence.push(path);continue;}
        connectors.forEach((connector,i)=>{
          if(connector.kind==='none')return;
          if(!['fan_pwm_4pin','fan_dc_3pin'].includes(connector.kind))missingEvidence.push(`${path}[${i}].kind`);
          if(!Number.isFinite(connector.current_a)||connector.current_a<=0)missingEvidence.push(`${path}[${i}].current_a`);
        });
      }
      const hint='Review missingEvidence for the exact device or motherboard that lacks recorded data. A 4-pin label alone does not confirm control mode or current. Inspect documented alternatives and submit the complete composition for validation. Do not invent values.'
        +(missingEvidence.some(path=>path.startsWith('board.'))?' Search motherboards using hasRecordedCpuFanHeader eq true for recorded CPU header pins, control and current; this filter does not certify the complete wiring. Changing only the cooler cannot fill missing board fields.':'');
      if(finding)finding.context={missingEvidence,hint,
        boardSku:selected.get(C.board).row.skuOver,boardCoolingHeaders:board.coolingHeaders??null,
        coolerFanConnectors:cooler.fanConnectors??null,coolerPumpConnectors:liquid?(cooler.pumpConnectors??null):null};
    }
    warnings.push(...(wiring.warnings||[]),...frontUsbWarnings(enclosure.frontUsbHeaders,board.internalUsbHeaders));
    const parts=[...selected.values()].map(({row,quantity})=>({skuOver:row.skuOver,category:row.category,name:row.product.name,
      quantity,price:row.offer.price*quantity,supplier:row.offer.supplier,transferBusinessDays:row.offer.days}));
    const total=parts.reduce((sum,p)=>sum+p.price,0);
    const budget=Math.min(request.budget,preferences.maxTotal??Infinity);
    if(total>budget)issue('budget_exceeded',`${total} > ${budget}`);
    let schedule;
    try{schedule=buildSchedule(new Date().toISOString(),Math.max(...parts.map(p=>p.transferBusinessDays)),operations,
      {parts,destinationCity:city,destinationBranch:pickupBranch,requireBranches:!!branches});}
    catch{unknown('calendar_unknown','Календарь склада/филиала');}
    return {...result(),total,parts,...(schedule?{schedule}:{})};
  }
  return {snapshotId,organizationId,city,pickupBranch,validate};
}
module.exports={createExactBuildValidator};
