'use strict';
const preferences = require('../config/build-preferences.json');

const CATEGORY_FACT = {
  'Процессоры': 'processorSpecifications',
  'Материнские платы': 'motherboardSpecifications',
  'Оперативная память': 'memorySpecifications',
  'Видеокарты': 'graphicsCardSpecifications',
  'Блоки питания': 'powerSupplySpecifications',
  'Корпуса': 'caseSpecifications',
  'Твердотельные диски (SSD)': 'solidStateDriveSpecifications',
  'Кулеры для процессоров': 'cpuCoolerSpecifications'
};
const EXCLUDED_SUPPLIERS = new Set(['OVER ALB', 'VENDER_P_S']);
const CITY_ALIAS = {'Другой город': 'Алматы'};

function amount(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function fact(component, key) { return component?.facts?.[key]?.value ?? null; }
function normalized(value) { return String(value || '').toLocaleLowerCase('en-US'); }
function componentDimension(value, index) {
  const dimensions = value?.dimensions;
  if (dimensions && Number.isFinite(dimensions.lengthMm)) return dimensions.lengthMm;
  const nums = String(value?.dimensionsMm || '').match(/\d+(?:\.\d+)?/g);
  return nums?.length > index ? Number(nums[index]) : null;
}
function gpuTier(gpu) {
  const model = String(gpu?.gpu || '');
  const match = model.match(/(RTX|RX)\s*(\d{4})\s*(Ti|XT)?/i);
  if (!match) return 0;
  const family = match[1].toUpperCase() === 'RTX' ? 1000000 : 500000;
  const suffix = match[3] ? 1 : 0;
  return family + Number(match[2]) * 2 + suffix;
}
function getOffer(product, warehouses, destinationCity) {
  if (!Array.isArray(product?.dealersData)) return null;
  const offers = [];
  for (const row of product.dealersData) {
    const match = String(row).match(/^(.*?)\s+\((\d+)\)/);
    if (!match) continue;
    const supplier = match[1].trim();
    const quantity = Number(match[2]);
    if (quantity < 1 || EXCLUDED_SUPPLIERS.has(supplier)) continue;
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

function buildPc({localData, city, budget, cpu, purpose, tasks = '', graphicsPreference = null}) {
  const destinationCity = CITY_ALIAS[city] || city;
  if (!['Алматы', 'Астана', 'Павлодар'].includes(destinationCity) || !amount(budget) ||
      !['AMD', 'Intel', 'На усмотрение специалиста'].includes(cpu) ||
      !(graphicsPreference==null||['RTX 5060','RTX 5060 Ti','RTX 5070','RTX 5080'].includes(graphicsPreference)) ||
      !['Для игр', 'Для офиса', 'Для работы и творчества'].includes(purpose)) {
    return {ok:false, code:'invalid_build_request'};
  }
  const inventory = localData.getBuildCandidates(destinationCity);
  const gaming = purpose === 'Для игр';
  const cpuRows = inventory.filter(row => row.category === 'Процессоры' &&
    (cpu === 'На усмотрение специалиста' || row.product.manufacturer === cpu));
  const motherboardRows = inventory.filter(row => row.category === 'Материнские платы');
  const memoryRows = inventory.filter(row => row.category === 'Оперативная память');
  const gpuRows = gaming ? inventory.filter(row => row.category === 'Видеокарты') : [];
  const psuRows = inventory.filter(row => row.category === 'Блоки питания');
  const caseRows = inventory.filter(row => row.category === 'Корпуса');
  const ssdRows = inventory.filter(row => row.category === 'Твердотельные диски (SSD)');
  const coolerRows = inventory.filter(row => row.category === 'Кулеры для процессоров');
  // Compare complete configurations. No CPU/GPU pair is frozen in advance.
  let best = null;
  let buildCount = 0;
  const memoryTargetGB = purpose === 'Для офиса' ? 16 : purpose === 'Для работы и творчества' ? 64 : 32;
  const storageTargetTB = purpose === 'Для офиса' ? 1 : 4;
  const competitive = gaming && /\bcs\s*2\b|counter[ -]?strike|valorant|киберспорт/i.test(tasks);
  const cpuPriority = new Map(cpuRows.map(row=>[row.skuOver,cpuPreference(row.component,purpose)]));

  for (const cpuRow of cpuRows) {
    const cpuSpec = fact(cpuRow.component, CATEGORY_FACT['Процессоры']);
    const cpuPowerW = cpuSpec?.maxTurboPowerW ?? cpuSpec?.tdpW;
    if (!cpuSpec?.socket || !Array.isArray(cpuSpec.memoryTypes) || !Number.isFinite(cpuPowerW)) continue;
    if (purpose !== 'Для игр' && !cpuSpec.integratedGraphics) continue;
    if (gaming && (!Number.isFinite(cpuSpec.cores) || cpuSpec.cores < 6 || cpuPowerW > 125)) continue;
    const boardRows = motherboardRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Материнские платы']);
      return spec?.socket === cpuSpec.socket && cpuSpec.memoryTypes.includes(spec.memoryType) &&
        (!cpuSpec.series || spec.supportedCpuSeries?.includes(cpuSpec.series)) &&
        spec.formFactor && spec.dimensionsMmReported && Number.isFinite(spec.memorySlots) &&
        Number.isFinite(spec.maxMemoryGB) && nonEmpty(spec.pcieX16);
    });
    const coolerMatches = coolerRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Кулеры для процессоров']);
      // AMD recommends a premium air cooler for 9700X; do not pair it with AG300.
      const premiumRequired = cpuRow.component.officialModel === 'AMD Ryzen 7 9700X';
      return (!premiumRequired || row.component.officialModel === 'DeepCool AK620 G2') &&
        Array.isArray(spec?.mountingSockets) && spec.mountingSockets.includes(cpuSpec.socket) &&
        Number.isFinite(spec.dimensionsMm?.heightMm);
    });
    const memoryMatches = memoryRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Оперативная память']);
      return spec?.memoryType && cpuSpec.memoryTypes.includes(spec.memoryType) &&
        Number.isFinite(spec.capacityGB) && Number.isFinite(spec.moduleCount) &&
        nonEmpty(spec.formFactor) && /DIMM/i.test(spec.formFactor) && !/SO-DIMM/i.test(spec.formFactor) &&
        (gaming ? spec.capacityGB >= 16 : spec.capacityGB >= 8);
    });
    const ssdMatches = ssdRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Твердотельные диски (SSD)']);
      return Number.isFinite(spec?.capacityGB) && nonEmpty(spec.formFactor) && nonEmpty(spec.interface);
    });
    const graphicsMatches = gaming ? gpuRows.filter(row => {
      const spec = fact(row.component, CATEGORY_FACT['Видеокарты']);
      return /^GeForce RTX 50(60|70|80)(?: Ti)?$/i.test(spec?.gpu || '') &&
        (!graphicsPreference || gpuTier(spec)>=gpuTier({gpu:`GeForce ${graphicsPreference}`})) &&
        gpuTier(spec) > 0 && Number.isFinite(spec.dimensions?.lengthMm) &&
        Number.isFinite(spec.recommendedPsuW) && nonEmpty(spec.powerConnectors);
    }) : [null];

    for (const boardRow of boardRows) {
      const board = fact(boardRow.component, CATEGORY_FACT['Материнские платы']);
      for (const memoryRow of memoryMatches) {
        const ram = fact(memoryRow.component, CATEGORY_FACT['Оперативная память']);
        const quantities=purpose==='Для работы и творчества'?[1,2,4]:[gaming&&ram.capacityGB>=16&&ram.moduleCount===1?2:1];
        for(const ramQuantity of quantities) {
        const totalRamGB=ram.capacityGB*ramQuantity;
        const totalRamModules=ram.moduleCount*ramQuantity;
        if (ram.memoryType !== board.memoryType || totalRamModules > board.memorySlots ||
            (Number.isFinite(board.maxMemoryGB) && totalRamGB > board.maxMemoryGB) ||
            (gaming && (totalRamGB<32 || totalRamModules<2)) ||
            (memoryRow.offer.quantity<ramQuantity)) continue;
        for (const coolerRow of coolerMatches) {
          const cooler = fact(coolerRow.component, CATEGORY_FACT['Кулеры для процессоров']);
          for (const ssdRow of ssdMatches) {
            const ssd = fact(ssdRow.component, CATEGORY_FACT['Твердотельные диски (SSD)']);
            const minimumSsdGB=gaming||purpose==='Для работы и творчества'?1000:500;
            if(ssd.capacityGB<minimumSsdGB)continue;
            const isM2 = /m\.2/i.test(ssd.formFactor);
            const boardM2Interfaces=[board.m2Interface,...(Array.isArray(board.m2Interfaces)?board.m2Interfaces:[])].filter(nonEmpty).join(' ');
            if(isM2){
              if(!(board.m2Slots>0))continue;
              if(/sata/i.test(ssd.interface)){if(!/sata/i.test(boardM2Interfaces))continue;}
              else if(/pcie|nvme/i.test(ssd.interface)){if(!/pcie|nvme/i.test(boardM2Interfaces))continue;}
              else continue;
            }else if(!(/sata/i.test(ssd.interface)&&board.sataPorts>0))continue;
            for (const gpuRow of graphicsMatches) {
              const gpu = gpuRow ? fact(gpuRow.component, CATEGORY_FACT['Видеокарты']) : null;
              const requiredPsuW = gpu ? gpu.recommendedPsuW : Math.max(400, Math.ceil(cpuPowerW / 0.75 / 50) * 50);
              for (const psuRow of psuRows) {
                const psu = fact(psuRow.component, CATEGORY_FACT['Блоки питания']);
                if (!Number.isFinite(psu.ratedPowerW) || !Number.isFinite(psu.lengthMm) || psu.ratedPowerW < requiredPsuW ||
                    !/^(ATX|ATX12V|ATX\s)/i.test(psu.formFactor || '')) continue;
                const gpuConnector = normalized(gpu?.powerConnectors);
                if (gpuConnector.includes('16-pin') && !((psu.connector16PinCount || 0) +
                    (psu.connector12V2x6Count || 0) + (psu.pciE12Plus4Count || 0) > 0)) continue;
                if (gpuConnector.includes('8-pin') && !((psu.pciE6Plus2Count || 0) + (psu.pciE8PinCount || 0) > 0)) continue;
                for (const caseRow of caseRows) {
                  const enclosure = fact(caseRow.component, CATEGORY_FACT['Корпуса']);
                  if (!Array.isArray(enclosure.motherboardFormFactors) ||
                      !enclosure.motherboardFormFactors.some(value => normalized(value).replace(/[\s-]/g,'').startsWith(normalized(board.formFactor).replace(/[\s-]/g,''))) ||
                      !Number.isFinite(enclosure.maxCpuCoolerHeightMm) ||
                      cooler.dimensionsMm.heightMm > enclosure.maxCpuCoolerHeightMm ||
                      !Number.isFinite(enclosure.maxGpuLengthMm) ||
                      (gpu && gpu.dimensions.lengthMm > enclosure.maxGpuLengthMm) ||
                      !Number.isFinite(enclosure.maxPsuLengthMm) ||
                      (Number.isFinite(psu.lengthMm) && psu.lengthMm > enclosure.maxPsuLengthMm)) continue;
                  // Side-mounted case fans share clearance with the motherboard. Until the
                  // manufacturer has confirmed that clearance, never use such a case.
                  const fanLayout = normalized(enclosure.preinstalledFans || '');
                  if (!fanLayout || /side/i.test(fanLayout) && !Number.isFinite(enclosure.motherboardFanClearanceMm) ||
                      !/front|rear|top|bottom/i.test(fanLayout)) continue;
                  if (gaming && !nonEmpty(enclosure.preinstalledFans)) continue;
                  const parts = [cpuRow,boardRow,{...memoryRow,quantity:ramQuantity},...(gpuRow?[gpuRow]:[]),ssdRow,psuRow,caseRow,coolerRow];
                  const total = parts.reduce((sum, row) => sum + row.offer.price*(row.quantity||1), 0);
                  const maxTransferBusinessDays = Math.max(...parts.map(row => row.offer.days));
                  // Treat 1000/1024, 2000/2048 GB as the same capacity class.
                  // Capacity beyond the useful target is not a reason to spend more.
                  const storageTier = Math.min(storageTargetTB, Math.floor(ssd.capacityGB / 1000));
                  const memoryTier = Math.min(memoryTargetGB, totalRamGB);
                  // Rated sequential throughput is a secondary SSD criterion,
                  // not a claim about application or sustained-write speed.
                  const ssdSpeedTier = Math.floor(Math.min(
                    ssd.sequentialReadMBs || 0, ssd.sequentialWriteMBs || 0) / 1000);
                  const candidate = {
                    city: destinationCity,
                    purpose,
                    tasks,
                    budget,
                    total,
                    overBudget: total > budget,
                    maxTransferBusinessDays,
                    assemblyCalendarDays: 2,
                    parts: parts.map(row => ({skuOver:row.product.skuOver,category:row.category,
                      name:row.product.name,quantity:row.quantity||1,price:row.offer.price*(row.quantity||1),supplier:row.offer.supplier,
                      transferBusinessDays:row.offer.days,stock:row.offer.quantity}))
                  };
                  const boardUtility = Math.min(4,board.memorySlots)/2 + Math.min(3,board.m2Slots||0) +
                    (/2\.5|5\s*Gigabit|10\s*Gigabit/i.test(board.lan||'')?2:0) +
                    (board.wifiBuiltIn===true||nonEmpty(board.wifi)?1:0);
                  const storageUtility = storageTier>=4?14:storageTier>=2?8:storageTier>=1?2:1;
                  const ramUtility = 8*memoryTier/memoryTargetGB;
                  const gpuUtility = preferences.gpu[gpu?.gpu]||0;
                  const airflowUtility = /front/.test(fanLayout)&&/rear/.test(fanLayout)?2:0;
                  const efficiencyUtility = /platinum|titanium/i.test(psu.efficiencyCertification||'')?3:
                    /gold/i.test(psu.efficiencyCertification||'')?2:0;
                  // Explicit editorial priorities, not invented FPS/benchmark scores.
                  const utility = cpuPriority.get(cpuRow.skuOver)*(competitive?1.5:1) +
                    gpuUtility*(competitive?0.75:1) + boardUtility + storageUtility + ramUtility +
                    Math.min(7,ssdSpeedTier)*0.1 + airflowUtility + efficiencyUtility;
                  const ranked = {build:candidate,utility};
                  buildCount++;
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
  if (!best) return {ok:false,code:'no_verified_build',city:destinationCity};
  const selected = best.build;
  const createdAt=new Date().toISOString();
  return {ok:true,build:{...selected,createdAt,expiresAt:new Date(Date.parse(createdAt)+86400000).toISOString(),priceValidDays:1,
    assemblyFree:true,alternatives:buildCount-1,
    remainingBudget:Math.max(0,budget-selected.total)}};
}

function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function cpuPreference(component,purpose) {
  // Match full model names; do not confuse 7600 with 7600X or 7700 with 7700X.
  const model=component.officialModel.replace(/\s+(BOX|OEM)$/i,'');
  const profile=preferences.cpu[model];
  return profile?.[purpose==='Для игр'?0:purpose==='Для работы и творчества'?1:2] || 0;
}
function compareBuilds(a,b) {
  return Number(a.build.overBudget)-Number(b.build.overBudget) ||
    (a.build.overBudget ? a.build.total-b.build.total : b.utility-a.utility) ||
    a.build.total-b.build.total || a.build.maxTransferBusinessDays-b.build.maxTransferBusinessDays ||
    a.build.parts.map(p=>p.skuOver).join(':').localeCompare(b.build.parts.map(p=>p.skuOver).join(':'));
}

module.exports = {buildPc, getOffer, CATEGORY_FACT};
