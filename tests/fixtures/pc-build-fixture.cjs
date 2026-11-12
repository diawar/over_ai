'use strict';

function createBuildFixture(){
  let next=1;
  const rows=[];
  function add(category,name,officialModel,key,value,price){
    const skuOver=String(next++);
    rows.push({skuOver,category,component:{officialModel,facts:{[key]:{value}}},
      product:{skuOver,name,manufacturer:'AMD'},
      offer:{price,quantity:10,days:0,supplier:'OVER PAV',local:true}});
  }
  add('Процессоры','AMD Ryzen 5 7600','AMD Ryzen 5 7600','processorSpecifications',
    {socket:'AM5',cores:6,threads:12,tdpW:65,memoryTypes:['DDR5'],integratedGraphics:true,maxMemoryGB:128},50000);
  add('Материнские платы','AM5 mATX board','Board A','motherboardSpecifications',
    {socket:'AM5',chipset:'B650',memoryType:'DDR5',formFactor:'mATX',rearConnector:false,
      dimensionsMmReported:true,memorySlots:4,
      maxMemoryGB:128,pcieX16:'PCIe 4.0 x16',m2Slots:2,m2Interface:'PCIe NVMe',sataPorts:4,
      lan:'Gigabit Ethernet',wifiBuiltIn:false,cpuPowerConnectors:['1 x CPU 8-pin'],
      coolingHeaders:[{kind:'cpu_fan_header',count:1,roles:['cpu_fan'],pins:4,control:['pwm'],max_current_a:1},
        {kind:'system_fan_header',count:2,roles:['system_fan'],pins:4,control:['pwm'],max_current_a:1},
        {kind:'pump_header',count:1,roles:['pump'],pins:4,control:['pwm'],max_current_a:2}],
      lightingHeaders:[{kind:'none',count:0}]},50000);
  add('Оперативная память','DDR5 16 GB DIMM','RAM A','memorySpecifications',
    {memoryType:'DDR5',capacityGB:16,moduleCount:1,formFactor:'DIMM'},40000);
  add('Видеокарты','GeForce RTX 5060','GPU A','graphicsCardSpecifications',
    {gpu:'GeForce RTX 5060',memoryGB:8,dimensions:{lengthMm:250},recommendedPsuW:650,powerConnectors:'8-pin'},150000);
  add('Видеокарты','GeForce RTX 5070','GPU B','graphicsCardSpecifications',
    {gpu:'GeForce RTX 5070',memoryGB:12,dimensions:{lengthMm:260},recommendedPsuW:650,powerConnectors:'8-pin'},250000);
  add('Твердотельные диски (SSD)','NVMe 1 TB','SSD A','solidStateDriveSpecifications',
    {capacityGB:1000,formFactor:'M.2 2280',interface:'PCIe NVMe',connection:'M.2',sequentialReadMBs:3000,
      sequentialWriteMBs:2500},30000);
  add('Блоки питания','750 W ATX PSU','PSU A','powerSupplySpecifications',
    {ratedPowerW:750,lengthMm:140,formFactor:'ATX',pciE8PinCount:2,efficiencyCertification:'Gold',
      cpuConnectors:['2 x CPU 4+4-pin']},30000);
  add('Корпуса','mATX case','Case A','caseSpecifications',
    {motherboardFormFactors:['mATX'],maxCpuCoolerHeightMm:170,maxGpuLengthMm:350,
      maxPsuLengthMm:180,psuFormFactors:['ATX'],driveBays25:2,driveBays35:1,
      sharedDriveBays:0,preinstalledFans:'front and rear'},30000);
  add('Кулеры для процессоров','DeepCool AK620 G2','DeepCool AK620 G2','cpuCoolerSpecifications',
    {mountingSockets:['AM5'],dimensionsMm:{heightMm:155},tdpW:150,type:'tower',
      fanConnectors:[{kind:'fan_pwm_4pin',count:1,current_a:0.3}],
      lightingConnectors:[{kind:'none',count:0}]},10000);
  return {getBuildCandidates:()=>structuredClone(rows),status:()=>({catalogLoaded:true,catalogSource:'test',
    itemCount:rows.length,buildEngineReady:true,buildsReady:false})};
}

module.exports={createBuildFixture};
