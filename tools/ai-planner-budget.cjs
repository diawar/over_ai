'use strict';
// Arithmetic over observed catalog facts, never a compatibility verdict or SKU selection.
function budgetMemory(request,cards,proposedParts){
 const requestedBudget=request.budget, maxTotal=request.partPreferences?.maxTotal;
 const budget=Number.isSafeInteger(maxTotal)&&maxTotal>0&&Number.isFinite(requestedBudget)?Math.min(requestedBudget,maxTotal):requestedBudget;
 const bySku=new Map(cards.filter(c=>typeof c.skuOver==='string'&&Number.isFinite(c.price)&&c.price>0).map(c=>[c.skuOver,c]));
 const groups=new Map();
 for(const c of bySku.values())if(c.category){if(!groups.has(c.category))groups.set(c.category,[]);groups.get(c.category).push(c);}
 const alternatives=[...groups].map(([category,items])=>{
  const cheapest=[...items].sort((a,b)=>a.price-b.price||a.skuOver.localeCompare(b.skuOver)).slice(0,3);
  const keep=new Map([...cheapest,...items.slice(-2)].map(c=>[c.skuOver,c]));
  return {category,observedMinimumUnitPrice:cheapest[0].price,items:[...keep.values()].map(c=>{
   const row={skuOver:c.skuOver,unitPrice:c.price};
   for(const k of ['socket','memoryType','capacityGB','moduleCount'])if(['string','number','boolean'].includes(typeof c.specifications?.[k]))row[k]=c.specifications[k];
   return row;
  })};
 });
 let proposal=null;
 if(Array.isArray(proposedParts)){
  const lines=proposedParts.map(p=>{const c=bySku.get(p?.skuOver);const valid=Number.isSafeInteger(p?.quantity)&&p.quantity>=1&&p.quantity<=32;
   return {skuOver:p?.skuOver??null,quantity:p?.quantity??null,...(c&&valid?{category:c.category,unitPrice:c.price,lineTotal:c.price*p.quantity}:{priceUnknown:true})};});
  const subtotal=lines.reduce((n,l)=>n+(l.lineTotal??0),0),complete=lines.every(l=>!l.priceUnknown);
  proposal={lines,pricedSubtotal:subtotal,completePrices:complete,...(complete?{total:subtotal,...(Number.isFinite(budget)?{overBudgetBy:Math.max(0,subtotal-budget),remainingBudget:budget-subtotal}:{})}:{})};
 }
 return {budget,requestedBudget,proposal,alternatives,scope:'Observed inspected items only, not the full catalog. Unit/kit prices; quantities multiply price. Cheaper is not better or compatible. These rows preserve price and identity when full details are omitted; reload omitted specifications before deciding. Only exact validation certifies the complete composition. Change optional search constraints or platform if inspected options cannot meet the total budget; do not repeat the same expensive allocation.'};
}
module.exports={budgetMemory};
