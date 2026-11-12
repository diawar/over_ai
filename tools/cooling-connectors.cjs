'use strict';

const MOTOR=new Set(['fan_pwm_4pin','fan_dc_3pin']);
function inventory(value){
  return Array.isArray(value)&&value.length&&value.every(row=>row&&typeof row.kind==='string'&&
    Number.isInteger(row.count)&&row.count>=0&&row.count<=32)?value:null;
}
function roles(row){
  return row.roles||({cpu_fan_header:['cpu_fan'],cpu_opt_header:['cpu_opt'],
    system_fan_header:['system_fan'],pump_header:['pump']}[row.kind])||[];
}
function coolingConnectionFit(board,cooler,{liquid=false,caseFan=null,quantity=1}={}){
  const warnings=[],demands=[];
  const add=(value,role,multiplier=1)=>{
    const rows=inventory(value);
    if(!rows)return false;
    if(rows.some(row=>row.kind==='none')&&rows.length!==1)return false;
    for(const row of rows){
      if(row.kind==='none'&&row.count===0)continue;
      if(role==='system'&&['argb_3pin_5v','rgb_4pin_12v'].includes(row.kind))continue;
      // Controllers, alternative/shared harnesses and external power need an
      // evidenced wiring path; their presence alone never certifies cooling.
      if(!MOTOR.has(row.kind)||row.count<1)return false;
      for(let n=0;n<row.count*multiplier;n++)demands.push({...row,role});
    }
    return true;
  };
  if(!add(cooler.fanConnectors,'cpu')||(liquid&&!add(cooler.pumpConnectors,'pump'))||
     (caseFan&&!add(caseFan.connector,'system',quantity)))return {fit:'review',warnings};
  if(!demands.some(row=>row.role==='cpu')||(liquid&&!demands.some(row=>row.role==='pump')))
    return {fit:'review',warnings};
  const headers=inventory(board.coolingHeaders);
  if(!headers||headers.some(row=>row.kind==='unresolved'))return {fit:'review',warnings};
  const slots=headers.flatMap(row=>Array.from({length:row.count},()=>row));
  if(demands.length>slots.length)return {fit:'no',warnings};
  const edge=(demand,header)=>{
    const allowed=roles(header);
    if(!allowed.some(role=>demand.role==='cpu'?['cpu_fan','cpu_opt'].includes(role):
      demand.role==='pump'?role==='pump':role==='system_fan'))return 'no';
    if(!Number.isInteger(header.pins))return 'review';
    if(demand.kind==='fan_pwm_4pin'&&header.pins!==4)return 'no';
    if(demand.kind==='fan_dc_3pin'&&![3,4].includes(header.pins))return 'no';
    const mode=demand.kind==='fan_pwm_4pin'?'pwm':'dc';
    if(!Array.isArray(header.control))return 'review';
    if(!header.control.includes(mode))return 'no';
    if(!Number.isFinite(demand.current_a)||!Number.isFinite(header.max_current_a)||
       demand.current_a<=0||header.max_current_a<=0)return 'review';
    return demand.current_a<=header.max_current_a?'yes':'no';
  };
  // A physical combo header is a single slot, regardless of its number of roles.
  const match=allowReview=>{
    const assigned=new Map();
    const visit=(index,seen)=>{
      for(let slot=0;slot<slots.length;slot++){
        const fit=edge(demands[index],slots[slot]);
        if(seen.has(slot)||fit==='no'||(!allowReview&&fit!=='yes'))continue;
        seen.add(slot);
        if(!assigned.has(slot)||visit(assigned.get(slot),seen)){
          assigned.set(slot,index);return true;
        }
      }
      return false;
    };
    return demands.every((_,index)=>visit(index,new Set()));
  };
  const fit=match(false)?'yes':match(true)?'review':'no';
  const lighting=[cooler.lightingConnectors,...(caseFan?[caseFan.connector]:[])];
  const lights=inventory(board.lightingHeaders),needed=new Map();
  for(let index=0;index<lighting.length;index++){
    const rows=inventory(lighting[index]);
    if(!rows){warnings.push('Подключение подсветки охлаждения ARGB/RGB требует проверки');continue;}
    for(const row of rows){
      if(['argb_3pin_5v','rgb_4pin_12v'].includes(row.kind))
        needed.set(row.kind,(needed.get(row.kind)||0)+row.count*(index===0?1:quantity));
      else if(row.kind==='unresolved')warnings.push('Не подтверждена схема подключения подсветки охлаждения');
    }
  }
  for(const [kind,count] of needed){
    const label=kind==='argb_3pin_5v'?'ARGB 3-pin 5V':'RGB 4-pin 12V';
    if(!lights||lights.some(row=>row.kind==='unresolved'))
      warnings.push(`Разъёмы платы для ${label} требуют проверки`);
    else if(lights.filter(row=>row.kind===kind).reduce((sum,row)=>sum+row.count,0)<count)
      warnings.push(`Не хватает разъёмов ${label} для подсветки охлаждения; нужен подтверждённый контроллер или разветвитель`);
  }
  return {fit,warnings:[...new Set(warnings)]};
}
module.exports={coolingConnectionFit};
