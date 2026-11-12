'use strict';
const fs=require('node:fs');
const path=require('node:path');
const data=path.join(__dirname,'..','data');
const products=JSON.parse(fs.readFileSync(path.join(data,'cooling-recovery-20261028.json'),'utf8')).products;
const records=new Map();
const unresolved=raw=>[{kind:'unresolved',count:1,raw}];
function add(id,url,values,note=''){
  const p=products.find(row=>row.product_id===id);
  if(!p)throw Error('Outside recovery cohort');
  const row=records.get(id)||{product_id:id,category_id:p.category_id,manufacturer:p.manufacturer,
    article:p.article,official_model:p.name,source_url:url,checked_at:'2026-10-28',
    reviewed_by:'Codex',values:{},value_sources:{},evidence_notes:[]};
  for(const [code,value] of Object.entries(values)){
    if(row.values[code]&&JSON.stringify(row.values[code])!==JSON.stringify(value))throw Error('Conflicting evidence '+id+':'+code);
    row.values[code]=value;row.value_sources[code]=url;
  }
  if(note)row.evidence_notes.push(note);
  records.set(id,row);
}
function source(id,match){
  const p=products.find(p=>p.product_id===id);
  return p.sources.find(url=>match.test(url))||p.sources[0];
}
function air(id,url,current,lighting='none'){
  add(id,url,{cooler_fan_connectors:[`1 x 4-pin PWM ${current} A`],
    cooling_lighting_connectors:lighting==='none'?['none']:lighting},
    'Один комплектный вентилятор; разъём и ток по таблице производителя. Отсутствие отдельного подключения подсветки — по полному перечню интерфейсов точной модели.');
}
function replace(id,url,values,note=''){
  const old=records.get(id);
  if(old)for(const code of Object.keys(values))delete old.values[code];
  add(id,url,values,note);
}
air(1222,source(1222,/22909/),0.18,['1 x 3-pin 5V ARGB']);
air(1396,source(1396,/22803/),0.18,['1 x 3-pin 5V ARGB']);
air(1370,source(1370,/id=319/),0.2);
air(3377,source(3377,/id=411/),0.25);
air(21477,source(21477,/id=328/),0.2);
air(7194,source(7194,/jonsbo/),0.19);
air(25786,source(25786,/jonsbo/),0.16);
air(22716,source(22716,/www\.deepcool/),0.18);
air(5416,'https://www.bequiet.com/en/cpucooler/5591',0.45);
add(4465,'https://www.bequiet.com/en/cpucooler/5599',{
  cooler_fan_connectors:['1 x 4-pin PWM 0.9 A'],cooling_lighting_connectors:['none']},
  'BK041: два вентилятора, комплектный Y-кабель; верхняя граница Safety current 0.45 A на вентилятор, суммарно 0.90 A.');
air(1990,source(1990,/ocypus/),0.1,unresolved('Fan LED и Heatsink LED: ARGB, 3-Pin, 5VDC; количество внешних подключений в комплектной схеме требует проверки'));
air(1872,source(1872,/id=446/),0.25,unresolved('FROZN A410 DW: цифровой дисплей; полный перечень внешних подключений дисплея/подсветки требует проверки'));
air(2524,source(2524,/id=322/),0.2,unresolved('SE-224-XTS ARGB WHITE: ARGB; разъём подсветки не указан в текстовой таблице, требуется проверка схемы'));
air(21481,source(21481,/id=281/),0.28,unresolved('SE-214-XT ARGB WHITE: ARGB; разъём подсветки не указан в текстовой таблице, требуется проверка схемы'));
for(const [id,description] of [[1298,'Два вентилятора 4Pin PWM, 0.25 A каждый'],[2526,'Два вентилятора 4Pin PWM, 0.2 A каждый'],[21498,'Два вентилятора 4Pin PWM: 0.28 A и 0.25 A (0.3 A max)']])
  add(id,source(id,/idcooling/),{cooler_fan_connectors:unresolved(description+'; число внешних подключений после комплектных кабелей не подтверждено'),cooling_lighting_connectors:['none']});
add(22299,source(22299,/id=602/),{
  cooler_fan_connectors:unresolved('Два XF-120S-ARGB, 4Pin PWM, 0.15 A каждый; внешняя схема подключения требует проверки'),
  cooling_lighting_connectors:unresolved('5V 3Pin ARGB; внешняя схема двух вентиляторов требует проверки')});
add(1187,source(1187,/21604/),{
  cooler_fan_connectors:unresolved('Два вентилятора 4-pin PWM, 0.12 A каждый; число внешних подключений требует проверки'),
  cooling_lighting_connectors:['1 x 3-pin 5V ARGB',...unresolved('9-pin USB 2.0 для цифрового дисплея')]});
add(5669,source(5669,/18964/),{
  cooler_fan_connectors:unresolved('Вентиляторы 4-pin PWM, 0.2 A / 0.2 A; комплектный контроллер/кабели требуют проверки'),
  cooling_lighting_connectors:unresolved('Цифровой модуль дисплея 5VDC, 0.08 A; полный перечень внешних кабелей требует проверки')});

// Complete connector lists published by the exact motherboard manufacturer.
for(const [id,model] of [[757,'A520M-HVS'],[31388,'B550M-HDV']])
  add(id,`https://www.asrock.com/MB/AMD/${model}/index.us.asp`,{
    motherboard_fan_headers:['1 x CPU_FAN1 4-pin 1 A','2 x CHA_FAN1~2 4-pin 1 A'],
    motherboard_lighting_headers:['none']},'Полный перечень внутренних разъёмов, примечания о предельном токе; режим PWM/DC не выведен из количества пинов.');
add(16268,'https://www.asrock.com/MB/AMD/B650M-HM.2%2B/index.us.asp',{
  motherboard_fan_headers:['1 x CPU_FAN1 4-pin 1 A','3 x CHA_FAN1~3/PUMP 4-pin 2 A'],
  motherboard_lighting_headers:['none']});
add(24430,'https://www.asrock.com/MB/Intel/B760M-HDVM.2/index.us.asp',{
  motherboard_fan_headers:['1 x CPU_FAN1 4-pin 1 A','1 x CPU_FAN2/PUMP 4-pin 2 A','2 x CHA_FAN1~2/PUMP 4-pin 2 A'],
  motherboard_lighting_headers:['1 x 4-pin 12V RGB','3 x 3-pin 5V ARGB']});
add(29992,'https://www.asrock.com/MB/Intel/B860M%20Pro-A/index.us.asp',{
  motherboard_fan_headers:['1 x CPU_FAN1 4-pin 1 A','1 x CPU_FAN2 4-pin 3 A','3 x CHA_FAN1~3 4-pin 3 A','1 x AIO_PUMP 4-pin 3 A'],
  motherboard_lighting_headers:['1 x 4-pin 12V RGB','3 x 3-pin 5V ARGB']});
add(26512,source(26512,/techspec/),{motherboard_fan_headers:['1 x CPU_FAN 4-pin','1 x CHA_FAN 4-pin'],motherboard_lighting_headers:['none']});
add(9714,source(9714,/\/sp/),{motherboard_fan_headers:['1 x CPU_FAN','1 x SYS_FAN'],motherboard_lighting_headers:['none']});
add(19330,source(19330,/maxsun.com\/products/),{motherboard_fan_headers:['1 x CPU_FAN','1 x SYS_FAN'],motherboard_lighting_headers:['none']});
add(22857,'https://www.maxsun.com/products/challenger-a520m-k',{motherboard_fan_headers:['1 x CPU_FAN','1 x SYS_FAN'],motherboard_lighting_headers:['none']});
add(11511,source(11511,/rog.asus/),{motherboard_fan_headers:['1 x CPU_FAN 4-pin','1 x CPU_OPT 4-pin','1 x AIO_PUMP 4-pin','5 x CHA_FAN 4-pin']});
add(16225,source(16225,/techspec/),{motherboard_fan_headers:['1 x CPU_FAN 4-pin','1 x CPU_OPT 4-pin','1 x AIO_PUMP 4-pin','3 x CHA_FAN 4-pin']});

// Exact model's explicit external controller is recorded, not substituted with ARGB.
add(3154,source(3154,/corsair.com\/us/),{
  cooler_fan_connectors:unresolved('RX RGB fans подключаются к iCUE LINK System Hub комплектным iCUE LINK кабелем'),
  aio_pump_connectors:unresolved('iCUE LINK System Hub управляет помпой; комплектные кабели питания и USB требуют сверки по руководству'),
  cooling_lighting_connectors:unresolved('Подсветка вентиляторов и помпы управляется iCUE LINK; не является стандартным ARGB-разъёмом платы')});
add(2122,source(2122,/nzxt/),{
  cooler_fan_connectors:unresolved('F360 RGB Core single-frame fan: один 8-pin для PWM & RGB, питание 12V 0.79 A / 5V 0.81 A'),
  aio_pump_connectors:unresolved('NZXT Turbine pump, комплектный breakout cable; полный путь питания требует сверки по руководству'),
  cooling_lighting_connectors:unresolved('NZXT 8-pin PWM & RGB и RGB ring; требуется комплектная схема контроллера, не стандартный ARGB платы')});
add(3210,source(3210,/lian-li/),{
  cooler_fan_connectors:unresolved('UNI FAN TL FLEX: комплектный TL FLEX Receiver, беспроводное управление L-Connect 3; схема питания требует проверки'),
  aio_pump_connectors:unresolved('HydroShift II OLED Curved: помпа и магнитный OLED-модуль с pogo-pin; внешняя схема требует проверки'),
  cooling_lighting_connectors:unresolved('UNI FAN TL FLEX Receiver поддерживает отдельный 5V 3-pin ARGB кабель; режим L-Connect 3 альтернативный')});

replace(1187,source(1187,/21604/),{cooler_fan_connectors:['1 x 4-pin PWM 0.24 A']},
  'AK620 DIGITAL SE manual, стр.20: два вентилятора через комплектный Y-кабель в один CPU_FAN; 2 × 0.12 A = 0.24 A. https://www.deepcool.com/download/pdf/AK620_DIGITAL_SE_Series.pdf');
replace(5669,source(5669,/18964/),{cooler_fan_connectors:['1 x 4-pin PWM 0.4 A'],
  cooling_lighting_connectors:unresolved('9-pin USB 2.0 для цифрового дисплея')},
  'ASSASSIN IV VC VISION manual, стр.32: одно внешнее 4-pin подключение и USB 2.0. Суммарный ток двух вентиляторов 0.2 + 0.2 = 0.4 A. https://www.deepcool.com/download/pdf/ASSASSIN_IV_VC_VISION.pdf');
add(3580,'https://download.gigabyte.com/FileList/Manual/mb_manual_b650m-aorus-elite-ax-ice_1102_e.pdf',{
  motherboard_lighting_headers:['2 x 3-pin 5V ARGB','3 x 4-pin 12V RGB']},
  'Manual, стр.21–22: D_LED1/2 по 5V; CPU_LED и LED_C1/2 — 12V RGB, всего три независимых RGB-разъёма.');
add(8513,source(8513,/\/sp/),{motherboard_lighting_headers:[
  {kind:'unresolved',count:3,raw:'3 x GIGABYTE Addressable RGB Gen2 LED strip headers'},
  {kind:'unresolved',count:1,raw:'1 x GIGABYTE RGB LED strip header'}]},
  'Количество и названия по полному Internal I/O; пины и напряжение не добавлены без руководства точной ревизии.');
add(6034,'https://www.maxsun.com/products/ms-challenger-h610m-h',{motherboard_lighting_headers:['none']},
  'В полном перечне внутренних подключений точной MS-Challenger H610M-H отсутствуют отдельные разъёмы подсветки.');
add(15314,'https://download.msi.com/archive/mnu_exe/mb/MAGX870TOMAHAWKWIFI_English.pdf',{
  motherboard_fan_headers:['1 x CPU_FAN1 4-pin PWM DC 2 A','1 x SYS_FAN/PUMP 4-pin PWM 3 A','6 x SYS_FAN1~6 4-pin PWM DC 1 A'],
  motherboard_lighting_headers:['3 x 3-pin 5V ARGB','1 x 4-pin 12V RGB']},
  'Manual стр.50: CPU/SYS Auto mode поддерживает PWM и DC; PUMP_SYS1 отдельная совмещённая физическая колодка. Стр.52–53: JRGB1 12V и JARGB_V2_1~3 5V.');
add(11511,source(11511,/rog.asus/),{motherboard_lighting_headers:[
  {kind:'unresolved',count:3,raw:'3 x ASUS Addressable Gen2 ARGB headers'}]});
add(16225,source(16225,/techspec/),{motherboard_lighting_headers:[
  {kind:'unresolved',count:3,raw:'3 x ASUS Addressable Gen2 ARGB headers'},
  {kind:'unresolved',count:1,raw:'1 x ASUS Aura RGB header'}]});

const proartManual='https://dlcdnets.asus.com/pub/ASUS/Accessory/ProArt/ProArt_LC_Series/ProArt_LC_420/Q22504_ProArt_LC_Series_QSG_WEB.pdf';
add(3540,proartManual,{cooler_fan_connectors:['1 x 4-pin PWM'],
  aio_pump_connectors:['1 x 4-pin'],cooling_lighting_connectors:unresolved('9-pin USB 2.0 для управляющего модуля светового индикатора')},
  'Manual стр.14–17: USB 2.0, отдельный 4-pin кабель блока, 3 вентилятора через комплектный 3-way кабель в один разъём. PWM вентиляторов подтверждён techspec ASUS. Ток не выведен из модели вентилятора.');
add(3557,'https://www.montechpc.com/pureflow-argb-360',{
  cooler_fan_connectors:['1 x 4-pin PWM 0.84 A'],aio_pump_connectors:['1 x 4-pin PWM 0.35 A'],
  cooling_lighting_connectors:unresolved('Pump LED 5V 3Pin ARGB и Fan LED 5V 3Pin ARGB; внешняя схема объединения требует проверки')},
  'Один unibody-блок вентиляторов 360×120×25 мм, 0.28 A × 3 = 0.84 A; отдельный насос PWM 4Pin 0.35 A.');
add(3394,source(3394,/ru.msi/),{
  cooler_fan_connectors:unresolved('Два вентилятора, PWM Yes, PWM cable 450 mm, максимальный ток 0.18 A на вентилятор; число внешних разъёмов требует проверки'),
  aio_pump_connectors:['1 x 3-pin 0.24 A'],
  cooling_lighting_connectors:unresolved('Помпа и вентиляторы: ARGB Gen2, 5V ARGB 3-PIN Header; внешняя схема объединения требует проверки')});
add(5354,source(5354,/pccooler/),{
  cooler_fan_connectors:unresolved('Три вентилятора 4PIN PWM, 0.2±0.03 A каждый; комплектная схема внешних подключений требует проверки'),
  aio_pump_connectors:['1 x 4-pin 0.31 A'],
  cooling_lighting_connectors:unresolved('Waterblock Lighting Connector 5V-3PIN ARGB; Fan Lighting Connector 5V-3PIN ARGB; число внешних подключений требует проверки')});
add(8471,'https://jp.pccooler.com/details/DA240-V2-ARGB?id=358',{
  cooler_fan_connectors:unresolved('Вентиляторы 4Pin PWM, 0.3 A; комплектная схема внешних подключений требует проверки'),
  aio_pump_connectors:['1 x 4-pin 0.3 A'],
  cooling_lighting_connectors:unresolved('Waterblock и Fan Lighting Connector: 5V-3PIN ARGB; схема объединения требует проверки')});
add(17016,source(17016,/pccooler/),{
  cooler_fan_connectors:['1 x 4-pin PWM 0.6 A'],aio_pump_connectors:['1 x 4-pin 0.3 A'],
  cooling_lighting_connectors:unresolved('Fan Lighting Connector 5V-3Pin ARGB и IPS-дисплей; комплектные внешние подключения требуют проверки')},
  'Производитель прямо указывает Hidden Cable Routing, Single-line Direct Output; 3 вентилятора × максимальные 0.2 A = 0.6 A на общем моторном подключении.');
add(818,'https://www.pccooler.com/details/370',{
  cooler_fan_connectors:['1 x 4-pin PWM','1 x SATA power'],
  aio_pump_connectors:['1 x 4-pin 0.3 A','1 x USB 2.0 9-pin'],
  cooling_lighting_connectors:unresolved('5V-3Pin ARGB: комплектный SATA-hub и водоблок; схема подключений показана в DV Series manual, требуется проверка контроллера')},
  'Проверена чёрная DV360-BKAWAY-GL (не белая details/371). DV Series manual, схема9: более двух вентиляторов только через комплектный хаб с POWER_SATA, FAN1 и ARGB; не считать 3×0.38 A нагрузкой разъёма платы. https://www.pccooler.com/documents/127/202604031107016832.pdf');
add(15315,source(15315,/ocypus/),{
  cooler_fan_connectors:unresolved('Вентиляторы 4-Pin PWM 0.2 A каждый; внешняя кабельная схема требует проверки'),
  aio_pump_connectors:['1 x 3-pin 0.53 A'],
  cooling_lighting_connectors:unresolved('Pump LED и Fan LED: ARGB, 3-Pin 5VDC; число внешних подключений требует проверки')});
add(12463,'https://www.deepcool.com/products/Cooling/cpuliquidcoolers/LE360-V2-Liquid-CPU-Cooler-1851-1700-AM5/2025/20138.shtml',{
  cooler_fan_connectors:['1 x 4-pin PWM 0.51 A'],aio_pump_connectors:['1 x 4-pin PWM 0.29 A'],
  cooling_lighting_connectors:['1 x 3-pin 5V ARGB']},
  'LE V2 manual, стр.16: три вентилятора объединены комплектным кабелем в один 4-pin; подсветка объединена в один 5V-D-G. Суммарный ток 3 × 0.17 A = 0.51 A. https://www.deepcool.com/download/pdf/LE_V2.pdf');
add(8118,'https://www.deepcool.com/products/Cooling/cpuliquidcoolers/LT360-VISION-ARGB-4.5-Ultrawide-LCD-Liquid-Cooler-with-Adjustable-Viewing-Angle/2026/22717.shtml',{
  cooler_fan_connectors:['1 x 4-pin PWM 0.84 A'],aio_pump_connectors:['1 x 4-pin PWM 0.29 A'],
  cooling_lighting_connectors:['1 x 3-pin 5V ARGB',...unresolved('9-pin USB 2.0 для цифрового дисплея')]},
  'LT VISION ARGB manual стр.14–15: объединённые вентиляторы и ARGB, отдельный PWM помпы и USB дисплея. 3 × 0.28 A = 0.84 A. https://www.deepcool.com/download/pdf/LT_VISION_ARGB.pdf');
add(21309,source(21309,/sharkoon/),{
  cooler_fan_connectors:['1 x 4-pin PWM 0.42 A'],aio_pump_connectors:['1 x 4-pin PWM 0.35 A'],
  cooling_lighting_connectors:unresolved('Fan и Pump LED Connector: 4-Pin (5V-D-coded-G), 5V; схема объединения требует проверки')},
  'Производитель подтверждает daisy chain двух вентиляторов, суммарно 2 × 0.21 A = 0.42 A. 4-Pin с coded-позицией не подменён на обычный 12V RGB.');

add(7330,source(7330,/idcooling/),{cooler_fan_connectors:unresolved('Два TF-12025-PRO BLACK, 4Pin PWM, 0.25 A каждый; внешняя схема требует проверки')});
add(7330,'https://www.dns-shop.kz/product/characteristics/523dfc575f98d582/sistema-ohlazdenia-id-cooling-fx240-pro-cernaa/',{
  aio_pump_connectors:['1 x 3-pin'],cooling_lighting_connectors:['none']},
  'У производителя не опубликован разъём помпы; резервная точная FX240 PRO в DNS прямо указывает помпу 3 pin и отсутствие подсветки.');
records.get(7330).official_unavailable=true;
add(23292,'https://shop.kz/offer/kuler-deepcool-ck-11508/',{
  cooler_fan_connectors:['1 x 3-pin'],cooling_lighting_connectors:['none']},
  'На официальной странице CK-11508 разъём не указан; Белый Ветер явно подтверждает 3 pin и Подсветка: Нет.');
Object.assign(records.get(23292),{official_unavailable:true,source_kind:'retailer_site'});
add(28691,'https://shop.kz/offer/kuler-pccooler-r94-v2/',{cooler_fan_connectors:['1 x 4-pin']},
  'Разъём 4 pin подтверждён точной моделью в Белом Ветре; отсутствие отдельного подключения подсветки пока не подтверждено.');
Object.assign(records.get(28691),{official_unavailable:true,source_kind:'retailer_site'});

fs.writeFileSync(path.join(data,'official-cooling-recovery-20261028.json'),JSON.stringify({products:[...records.values()]},null,2)+'\n');
console.log(`PREPARED ${records.size} exact models, ${[...records.values()].reduce((n,p)=>n+Object.keys(p.values).length,0)} properties; no API calls`);
