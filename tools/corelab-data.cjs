'use strict';

const path = require('node:path');
const {validSku}=require('./catalog-sku.cjs');
const {getOffer} = require('./pc-builder.cjs');
const {organizationWarehouses} = require('./organization-logistics.cjs');

function createCorelabData(items, root=path.join(__dirname,'..'), settings=null) {
  if(!Array.isArray(items)||items.length>100000)throw new Error('corelab_catalog_invalid');
  const warehouses=organizationWarehouses(settings?.operations);
  const products=[];
  const seen=new Set();
  for(const item of items){
    const sku=String(item?.skuOver??'');
    if(!validSku(sku)||seen.has(sku))throw new Error('corelab_catalog_invalid');
    seen.add(sku);
    if(!item.attributes||typeof item.attributes!=='object'||Array.isArray(item.attributes)||!Array.isArray(item.offers))continue;
    const component=componentFromAttributes(item.category,item.attributes);
    if(!component)continue;
    products.push({item,component});
  }
  const branchWarehouses = new Map();
  function getBuildCandidates(city, branchCode){
    const targets = getBranches(city);
    if (!branchCode && targets.length > 1) {
      const bySku = new Map();
      for (const target of targets) for (const row of getBuildCandidates(city, target.code)) {
        const previous = bySku.get(row.skuOver);
        if (!previous || row.offer.price < previous.offer.price || (row.offer.price === previous.offer.price && row.offer.days < previous.offer.days)) bySku.set(row.skuOver, row);
      }
      return [...bySku.values()];
    }
    if (branchCode && !branchWarehouses.has(branchCode)) branchWarehouses.set(branchCode, organizationWarehouses(settings?.operations, branchCode));
    const destinationWarehouses = branchCode ? branchWarehouses.get(branchCode) : warehouses;
    const result=[];
    for(const {item,component} of products){
      let best=null;
      for(const source of item.offers){
        const price=Number(source?.price);
        if(!Number.isSafeInteger(price)||price<=0)continue;
        const offer=getOffer({priceLoan:price,dealersData:source.dealersData},destinationWarehouses,city,{organizationPolicy:true});
        if(!offer)continue;
        if(!best||Number(offer.local)>Number(best.local)||
           (offer.local===best.local&&(offer.days<best.days||
             (offer.days===best.days&&offer.price<best.price))))best=offer;
      }
      if(best)result.push({skuOver:item.skuOver,category:item.category,component,
        product:{skuOver:item.skuOver,name:item.name,article:item.article,manufacturer:item.manufacturer,
          productUrl:typeof item.productUrl==='string'&&/^https:\/\//i.test(item.productUrl)?item.productUrl:null},offer:best});
    }
    return result;
  }
  function status(){return {catalogLoaded:true,catalogSource:'corelab',itemCount:items.length,
    technicalSource:'corelab',pcProductCount:products.length,
    buildEngineReady:warehouses.size>0,buildsReady:false};}
  function getRules(){return settings?.rules || null;}
  function getRulesVersion(){return settings?.rulesVersion || null;}
  function getOperations(){return settings?.operations || {};}
  function getBranches(city){return (settings?.operations?.branches || []).filter(b=>b.active&&(b.kind??'branch')==='branch'&&b.city&&(!city||b.city===city));}
  return {getBuildCandidates,status,getRules,getRulesVersion,getOperations,getBranches};
}

function componentFromAttributes(category, attrs){
  const n=key=>typeof attrs[key]==='number'&&Number.isFinite(attrs[key])?attrs[key]:undefined;
  const s=key=>typeof attrs[key]==='string'&&attrs[key].trim()?attrs[key].trim():undefined;
  const b=key=>typeof attrs[key]==='boolean'?attrs[key]:undefined;
  const list=key=>Array.isArray(attrs[key])&&attrs[key].every(value=>typeof value==='string')?attrs[key]:undefined;
  const connectors=key=>Array.isArray(attrs[key])&&attrs[key].every(value=>
    value&&typeof value==='object'&&typeof value.kind==='string'&&Number.isInteger(value.count))?
    attrs[key]:list(key)||s(key);
  const fanHeaders=()=>{
    const value=attrs.motherboard_fan_headers;
    if(Array.isArray(value)&&value.length&&value.every(row=>row&&Number.isInteger(row.count)&&row.count>=0))
      return value.filter(row=>row.kind==='system_fan_header'||row.roles?.includes('system_fan'))
        .reduce((sum,row)=>sum+row.count,0);
    return n('motherboard_fan_headers');
  };
  let key, value;
  switch(category){
    case 'Процессоры':
      key='processorSpecifications';value={socket:s('socket'),cores:n('cores'),threads:n('threads'),
        tdpW:n('cpu_tdp_w'),maxTurboPowerW:n('cpu_max_turbo_power_w'),pptW:n('cpu_ppt_w'),
        memoryTypes:s('cpu_memory_type')?.match(/DDR[345]/gi)?.map(type=>type.toUpperCase()),
        integratedGraphics:b('integrated_graphics'),series:s('cpu_series'),
        maxMemoryGB:n('max_memory_gb')};break;
    case 'Материнские платы':
      key='motherboardSpecifications';value={color:s('component_color'),socket:s('motherboard_socket'),chipset:s('motherboard_chipset'),
        memoryType:s('memory_type'),
        supportedCpuSeries:list('motherboard_supported_cpu_series')?.map(series=>
          series.replace(/^AMD\s+/i,'').replace(/\s+Series$/i,'').trim()),formFactor:s('motherboard_form_factor'),
        rearConnector:b('motherboard_rear_connector'),
        dimensionsMmReported:b('motherboard_dimensions_reported'),memorySlots:n('motherboard_memory_slots'),
        maxMemoryGB:n('motherboard_max_memory_gb'),pcieX16:s('motherboard_pcie_x16'),
        m2Slots:n('motherboard_m2_slots'),m2Interface:s('motherboard_m2_interface'),
        m2Interfaces:list('motherboard_m2_interfaces'),sataPorts:n('motherboard_sata_ports'),
        lan:s('motherboard_lan'),wifiBuiltIn:b('motherboard_wifi_built_in'),wifi:s('motherboard_wifi'),
        usb4Ports:n('motherboard_usb4_ports'),
        fanHeaders:fanHeaders(),
        coolingHeaders:connectors('motherboard_fan_headers'),
        lightingHeaders:connectors('motherboard_lighting_headers'),
        usb2Headers:connectors('motherboard_internal_usb_headers')?.find?.(row=>row.kind==='usb2_9pin')?.count ?? n('motherboard_usb2_headers'),
        internalUsbHeaders:connectors('motherboard_internal_usb_headers'),
        cpuPowerConnectors:connectors('motherboard_cpu_power_connectors'),memoryProfiles:list('motherboard_memory_profiles')};break;
    case 'Оперативная память':
      key='memorySpecifications';value={color:s('component_color'),memoryType:s('memory_type'),capacityGB:n('capacity'),
        moduleCount:n('module_count'),formFactor:s('memory_form_factor'),speedMTs:n('memory_frequency'),timings:s('memory_timings'),profiles:list('memory_profiles')};break;
    case 'Видеокарты':
      key='graphicsCardSpecifications';value={color:s('component_color'),gpu:s('gpu_graphics_processor'),
        memoryGB:n('gpu_memory_gb'),
        dimensions:{lengthMm:n('gpu_length_mm')},recommendedPsuW:n('gpu_recommended_psu_w'),
        boardPowerW:n('gpu_board_power_w'),pcieInterface:s('gpu_pcie_interface'),
        powerConnectors:connectors('gpu_power_connectors')};break;
    case 'Блоки питания':
      key='powerSupplySpecifications';value={color:s('component_color'),ratedPowerW:n('psu_power_w'),lengthMm:n('psu_length_mm'),
        formFactor:s('psu_form_factor'),efficiencyCertification:s('psu_efficiency_rating'),
        cpuConnectors:connectors('psu_cpu_connectors'),
        pcieConnectors:connectors('psu_pcie_connectors'),
        connector16PinCount:n('psu_connector_16pin_count'),connector12V2x6Count:n('psu_connector12v2x6_count'),
        pciE12Plus4Count:n('psu_pcie_12plus4_count'),pciE6Plus2Count:n('psu_pcie_6plus2_count'),
        pciE8PinCount:n('psu_pcie_8pin_count')};break;
    case 'Корпуса':
      key='caseSpecifications';value={color:s('component_color'),motherboardFormFactors:list('case_motherboard_form_factors'),
        maxCpuCoolerHeightMm:n('case_cpu_cooler_max_height_mm'),maxGpuLengthMm:n('case_gpu_max_length_mm'),
        maxPsuLengthMm:n('case_psu_max_length_mm'),psuFormFactors:list('case_psu_form_factor')||s('case_psu_form_factor'),
        driveBays25:n('case_drive_bays_25'),driveBays35:n('case_drive_bays_35'),
        sharedDriveBays:n('case_drive_bays_shared_25_35'),preinstalledFans:s('case_preinstalled_fans'),
        frontUsbHeaders:connectors('case_front_usb_headers'),
        radiatorSupport:list('case_radiator_support'),fanMounts:list('case_fan_mounts')};break;
    case 'Жесткие диски 3.5" (для ПК)':
      key='hardDriveSpecifications';value={capacityGB:n('capacity'),formFactor:s('storage_form_factor'),
        interface:s('storage_interface'),connection:s('storage_connection')};break;
    case 'Вентиляторы для корпуса':
    case 'Корпусные вентиляторы':
    case 'Вентиляторы корпуса':
    case 'Охлаждение для корпусов ПК':
      key='caseFanSpecifications';value={color:s('component_color'),size:s('case_fan_size'),connector:connectors('case_fan_connector'),
        noiseDba:n('case_fan_noise_dba')};break;
    case 'Твердотельные диски (SSD)':
      key='solidStateDriveSpecifications';value={capacityGB:n('capacity'),formFactor:s('storage_form_factor'),
        interface:s('storage_interface'),connection:s('storage_connection'),
        sequentialReadMBs:n('storage_sequential_read_mbs'),
        sequentialWriteMBs:n('storage_sequential_write_mbs')};break;
    case 'Кулеры для процессоров':
      key='cpuCoolerSpecifications';value={color:s('component_color'),mountingSockets:list('cpu_cooler_sockets'),
        fanConnectors:connectors('cooler_fan_connectors'),lightingConnectors:connectors('cooling_lighting_connectors'),
        dimensionsMm:{heightMm:n('cpu_cooler_height_mm')},tdpW:n('cpu_cooler_tdp_w'),
        type:coolerType(s('cpu_cooler_type')),noiseDba:n('cpu_cooler_fan_noise_dba')};break;
    case 'Системы водяного / жидкостного охлаждения (СЖО)':
      key='cpuCoolerSpecifications';value={color:s('component_color'),mountingSockets:list('cpu_cooler_sockets'),
        fanConnectors:connectors('cooler_fan_connectors'),pumpConnectors:connectors('aio_pump_connectors'),
        lightingConnectors:connectors('cooling_lighting_connectors'),
        tdpW:n('cpu_cooler_tdp_w'),radiatorSizeMm:n('aio_radiator_size_mm'),
        type:'aio',noiseDba:n('aio_fan_noise_dba')};break;
    default:return null;
  }
  return {officialModel:s('official_model')||'',facts:{[key]:{value}}};
}

function coolerType(value){
  if(!value)return undefined;
  const normalized=value.trim().toLocaleLowerCase('ru-RU');
  if(/башенн|tower/.test(normalized))return 'tower';
  if(/сжо|жидкост|aio|liquid/.test(normalized))return 'aio';
  if(/низкопрофил|top.?flow|down.?flow/.test(normalized))return 'low_profile';
  return 'other';
}

module.exports={createCorelabData};
