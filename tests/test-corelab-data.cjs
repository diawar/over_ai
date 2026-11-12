'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createCorelabData: createData}=require('../tools/corelab-data.cjs');
const operations={branches:[{code:'PAV',name:'PAV',city:'Павлодар',kind:'branch',active:true,source_label:'OVER PAV'},
  {code:'ALP',name:'ALP',city:'Алматы',kind:'branch',active:true,source_label:'OVER ALP'},
  {code:'AS',name:'AS',city:'Астана',kind:'branch',active:true,source_label:'OVER AS'},
  {code:'AZ',name:'Azerti',city:'Алматы',kind:'supplier_warehouse',active:true,source_label:'Azerti'}],
  routes:[{from_branch:'AZ',to_branch:'PAV',workdays:5},{from_branch:'AZ',to_branch:'ALP',workdays:1},{from_branch:'AZ',to_branch:'AS',workdays:5}]};
const createCorelabData=(items,root,settings)=>createData(items,root,{operations,...settings});

test('rated RAM timings and explicit motherboard profile support reach selection',()=>{
  const offers=[{price:10000,dealersData:['OVER PAV (2)']}];
  const rows=createCorelabData([
    {skuOver:'801',name:'RAM',category:'Оперативная память',offers,attributes:{memory_frequency:6000,memory_timings:'30-36-36-76',memory_profiles:['EXPO','XMP 3.0']}},
    {skuOver:'802',name:'Board',category:'Материнские платы',offers,attributes:{motherboard_memory_profiles:['EXPO']}}
  ]).getBuildCandidates('Павлодар');
  assert.equal(rows[0].component.facts.memorySpecifications.value.timings,'30-36-36-76');
  assert.deepEqual(rows[0].component.facts.memorySpecifications.value.profiles,['EXPO','XMP 3.0']);
  assert.deepEqual(rows[1].component.facts.motherboardSpecifications.value.memoryProfiles,['EXPO']);
});

test('cooling and lighting inventories reach the builder without counting CPU/PUMP as chassis headers',()=>{
  const cpu={kind:'cpu_fan_header',count:1,roles:['cpu_fan']};
  const shared={kind:'combo_fan_header',count:2,roles:['pump','system_fan']};
  const fan=[{kind:'fan_pwm_4pin',count:1,current_a:0.3}];
  const light=[{kind:'argb_3pin_5v',count:1}];
  const offers=[{price:5000,dealersData:['OVER PAV (1)']}];
  const rows=createCorelabData([
    {skuOver:'901',name:'Board',category:'Материнские платы',attributes:{motherboard_fan_headers:[cpu,shared],motherboard_lighting_headers:light},offers},
    {skuOver:'902',name:'AIO',category:'Системы водяного / жидкостного охлаждения (СЖО)',attributes:{cooler_fan_connectors:fan,aio_pump_connectors:fan,cooling_lighting_connectors:light},offers}
  ]).getBuildCandidates('Павлодар');
  const b=rows[0].component.facts.motherboardSpecifications.value;
  assert.equal(b.fanHeaders,2);
  assert.deepEqual(b.coolingHeaders,[cpu,shared]);
  const c=rows[1].component.facts.cpuCoolerSpecifications.value;
  assert.deepEqual(c.fanConnectors,fan);
  assert.deepEqual(c.pumpConnectors,fan);
  assert.deepEqual(c.lightingConnectors,light);
});

test('builder candidates use CoreLab name, current offer price and stock',()=>{
  const data=createCorelabData([{skuOver:'55398',name:'Текущее название CoreLab',
    productUrl:'https://over-shop.kz/catalog/example/55398/',
    article:'Core i5-12400 OEM',manufacturer:'Intel',category:'Процессоры',
    attributes:{socket:'LGA1700',cores:6,cpu_memory_type:'DDR4 / DDR5',integrated_graphics:true},
    offers:[{price:'91000.00',dealersData:['OVER PAV (1) - 71590 / 71590 / 88590']}]}]);
  const candidate=data.getBuildCandidates('Павлодар')[0];
  assert.equal(candidate.product.name,'Текущее название CoreLab');
  assert.equal(candidate.product.productUrl,'https://over-shop.kz/catalog/example/55398/');
  assert.equal(candidate.offer.price,91000);
  assert.equal(candidate.offer.quantity,1);
  assert.equal(candidate.component.facts.processorSpecifications.value.socket,'LGA1700');
  assert.deepEqual(candidate.component.facts.processorSpecifications.value.memoryTypes,['DDR4','DDR5']);
  assert.equal(candidate.component.facts.processorSpecifications.value.tdpW,undefined);
  assert.equal(data.status().catalogSource,'corelab');
  assert.equal(data.status().technicalSource,'corelab');
  assert.equal(createCorelabData([]).getBuildCandidates('Павлодар').length,0);
  assert.equal(createCorelabData([{skuOver:'55398',name:'Несовпадающий товар',
    article:'другой артикул',manufacturer:'Intel',category:'Процессоры',
    offers:[{price:'1.00',dealersData:['OVER PAV (1)']}]}]).getBuildCandidates('Павлодар').length,0);
});

test('PSU connector facts use the configured 12V-2x6 attribute code',()=>{
  const data=createCorelabData([{skuOver:'88900001',name:'FSP VITA GM 850W',
    article:'VITA-850GM',manufacturer:'FSP',category:'Блоки питания',
    attributes:{psu_power_w:850,psu_length_mm:140,psu_form_factor:'ATX',
      psu_pcie_6plus2_count:4,psu_connector12v2x6_count:1,
      psu_cpu_connectors:['2 x CPU 4+4-pin']},
    offers:[{price:'65000.00',dealersData:['OVER PAV (1)']}]}]);
  const spec=data.getBuildCandidates('Павлодар')[0].component.facts.powerSupplySpecifications.value;
  assert.equal(spec.pciE6Plus2Count,4);
  assert.equal(spec.connector12V2x6Count,1);
  assert.deepEqual(spec.cpuConnectors,['2 x CPU 4+4-pin']);
});

test('builder receives verified memory, GPU power and case PSU fit attributes',()=>{
  const offer=[{price:'50000.00',dealersData:['OVER PAV (1)']}];
  const items=[
    {skuOver:'1',name:'CPU',category:'Процессоры',attributes:{max_memory_gb:128},offers:offer},
    {skuOver:'2',name:'GPU',category:'Видеокарты',attributes:{gpu_board_power_w:250,
      gpu_pcie_interface:'PCIe 5.0',gpu_power_connectors:['8-pin x 2']},offers:offer},
    {skuOver:'3',name:'Case',category:'Корпуса',attributes:{case_psu_form_factor:['ATX','SFX'],
      case_drive_bays_25:6,case_drive_bays_35:2,case_drive_bays_shared_25_35:2},offers:offer}
  ];
  const rows=createCorelabData(items).getBuildCandidates('Павлодар');
  assert.equal(rows[0].component.facts.processorSpecifications.value.maxMemoryGB,128);
  assert.equal(rows[1].component.facts.graphicsCardSpecifications.value.boardPowerW,250);
  assert.deepEqual(rows[1].component.facts.graphicsCardSpecifications.value.powerConnectors,['8-pin x 2']);
  assert.deepEqual(rows[2].component.facts.caseSpecifications.value.psuFormFactors,['ATX','SFX']);
  assert.equal(rows[2].component.facts.caseSpecifications.value.driveBays25,6);
  assert.equal(rows[2].component.facts.caseSpecifications.value.sharedDriveBays,2);
});

test('case ventilation and motherboard fan headers reach the builder from CoreLab',()=>{
  const offers=[{price:'50000.00',dealersData:['OVER PAV (1)']}];
  const rows=createCorelabData([
    {skuOver:'4',name:'Board',category:'Материнские платы',attributes:{motherboard_fan_headers:2,
      motherboard_chipset:'B650',motherboard_cpu_power_connectors:['1 x CPU 8-pin']},offers},
    {skuOver:'5',name:'Case',category:'Корпуса',attributes:{case_preinstalled_fans:'0',
      case_fan_mounts:['Front: 120 mm','Rear: 120 mm']},offers}
  ]).getBuildCandidates('Павлодар');
  assert.equal(rows[0].component.facts.motherboardSpecifications.value.fanHeaders,2);
  assert.equal(rows[0].component.facts.motherboardSpecifications.value.chipset,'B650');
  assert.deepEqual(rows[0].component.facts.motherboardSpecifications.value.cpuPowerConnectors,['1 x CPU 8-pin']);
  assert.equal(rows[1].component.facts.caseSpecifications.value.preinstalledFans,'0');
  assert.deepEqual(rows[1].component.facts.caseSpecifications.value.fanMounts,
    ['Front: 120 mm','Rear: 120 mm']);
});

test('X870 platform features and Ryzen series reach the builder in comparable form',()=>{
  const offers=[{price:'255863.00',dealersData:['Azerti (4)']}];
  const rows=createCorelabData([{skuOver:'88956113',name:'ASUS X870E',
    category:'Материнские платы',attributes:{motherboard_chipset:'X870E',
      motherboard_supported_cpu_series:['AMD Ryzen 9000 Series'],
      motherboard_lan:'5 Gigabit Ethernet',motherboard_wifi_built_in:true,
      motherboard_wifi:'Wi-Fi 7',motherboard_usb4_ports:2},offers}])
    .getBuildCandidates('Алматы');
  assert.equal(rows.length,1);
  const spec=rows[0].component.facts.motherboardSpecifications.value;
  assert.deepEqual(spec.supportedCpuSeries,['Ryzen 9000']);
  assert.equal(spec.lan,'5 Gigabit Ethernet');
  assert.equal(spec.wifiBuiltIn,true);
  assert.equal(spec.wifi,'Wi-Fi 7');
  assert.equal(spec.usb4Ports,2);
});

test('front USB requirements and internal motherboard headers retain JSON inventories',()=>{
  const offers=[{price:'50000.00',dealersData:['OVER PAV (1)']}];
  const boardUsb=[{kind:'usb2_9pin',count:1,raw:'1 x USB 2.0 internal header'}];
  const caseUsb=[{kind:'usb2_9pin',count:1,ports:2,raw:'2 x USB 2.0'}];
  const rows=createCorelabData([
    {skuOver:'10',name:'Board',category:'Материнские платы',attributes:{
      motherboard_internal_usb_headers:boardUsb},offers},
    {skuOver:'11',name:'Case',category:'Корпуса',attributes:{
      case_front_usb_headers:caseUsb},offers}
  ]).getBuildCandidates('Павлодар');
  assert.deepEqual(rows[0].component.facts.motherboardSpecifications.value.internalUsbHeaders,boardUsb);
  assert.deepEqual(rows[1].component.facts.caseSpecifications.value.frontUsbHeaders,caseUsb);
});

test('3.5-inch HDD and SSD connection facts retain their mounting types',()=>{
  const offers=[{price:'50000.00',dealersData:['OVER PAV (1)']}];
  const rows=createCorelabData([
    {skuOver:'6',name:'HDD',category:'Жесткие диски 3.5" (для ПК)',attributes:{
      capacity:2000,storage_form_factor:'3.5 inch',storage_interface:'SATA 3',
      storage_connection:'SATA'},offers},
    {skuOver:'7',name:'SSD',category:'Твердотельные диски (SSD)',attributes:{
      capacity:1000,storage_form_factor:'2.5 inch',storage_interface:'SATA 3',
      storage_connection:'SATA'},offers}
  ]).getBuildCandidates('Павлодар');
  assert.equal(rows[0].component.facts.hardDriveSpecifications.value.formFactor,'3.5 inch');
  assert.equal(rows[0].component.facts.hardDriveSpecifications.value.connection,'SATA');
  assert.equal(rows[1].component.facts.solidStateDriveSpecifications.value.connection,'SATA');
});
