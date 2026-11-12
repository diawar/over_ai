'use strict';
const {memoryProfileSupport}=require('./component-budget.cjs');
function buildAdvantages(parts,inventory){
  const selected=parts.map(part=>({part,row:inventory.find(row=>row.skuOver===part.skuOver)}));
  const find=key=>selected.find(item=>item.row?.component?.facts?.[key]);
  const spec=key=>find(key)?.row.component.facts[key].value;
  const ram=spec('memorySpecifications'),board=spec('motherboardSpecifications'),ssd=spec('solidStateDriveSpecifications');
  const enclosure=spec('caseSpecifications'),psu=spec('powerSupplySpecifications');
  const benefits=[];
  if(ram){
    const part=find('memorySpecifications').part,total=ram.capacityGB*part.quantity,modules=ram.moduleCount*part.quantity;
    benefits.push(`${total} ГБ оперативной памяти${modules===2?' в двух модулях':''} — объём для одновременной работы программ и хранения рабочих данных в памяти.`);
    const support=memoryProfileSupport(ram,board);
    if(support.common.length)benefits.push(`Память и плата поддерживают ${support.common.join(' / ')}: профиль упрощает настройку частоты и таймингов в BIOS; стабильность проверяется при сборке.`);
    if(ram.timings&&ram.speedMTs&&support.tuningAllowed)
      benefits.push(`Для ОЗУ учтены вместе частота ${ram.speedMTs} MT/s и тайминги ${ram.timings}, а не одна частота.`);
  }
  if(ssd)benefits.push(`SSD ${ssd.capacityGB} ГБ — место для системы, программ и файлов${/NVMe/i.test(ssd.interface||'')?'; используется интерфейс NVMe':''}.`);
  if(board){
    if(board.wifiBuiltIn===true)benefits.push('Встроенный Wi-Fi — отдельный адаптер для беспроводного подключения не требуется.');
    if(/\b(?:2\.5|5|10)\s*Gigabit/i.test(board.lan||''))benefits.push(`Сеть ${board.lan} — возможность быстрого обмена данными при подходящих роутере и сетевой инфраструктуре.`);
    const used=ram?ram.moduleCount*find('memorySpecifications').part.quantity:0;
    if(used&&board.memorySlots>used)benefits.push(`Свободных слотов ОЗУ: ${board.memorySlots-used}. Есть возможность расширения; совместимость будущих модулей проверяется отдельно.`);
    if(board.usb4Ports>0)benefits.push(`Портов USB4: ${board.usb4Ports} — дополнительные возможности подключения совместимой периферии.`);
  }
  if(enclosure&&/front|side|bottom/i.test(enclosure.preinstalledFans||'')&&/rear|top/i.test(enclosure.preinstalledFans||''))
    benefits.push('В корпусе предусмотрены штатные вентиляторы в разных зонах — они уже включены в стоимость корпуса.');
  if(psu&&/gold|platinum|titanium/i.test(psu.efficiencyCertification||''))
    benefits.push(`Блок питания с сертификатом эффективности ${psu.efficiencyCertification}. Сертификат характеризует эффективность, а не все аспекты качества БП.`);
  return benefits;
}
module.exports={buildAdvantages};
