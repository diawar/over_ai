'use strict';
// SKU is an exact organization-owned identifier, not necessarily an Over number.
function validSku(value){
  return typeof value==='string'&&value.length>0&&value.length<=120&&
    value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);
}
module.exports={validSku};
