const test=require('node:test'),assert=require('node:assert/strict');
const command=require('../tools/ai-planner-command.cjs');
test('typed command uses plain JSON, strips unused null filters, preserves exact SKUs',()=>{assert.deepEqual(JSON.parse(command.decode({action:'batch',queries:[{category:'Процессоры',text:null,filters:[]}],skus:[],parts:[],explanation:''}).arguments),{queries:[{category:'Процессоры',filters:[]}]});assert.deepEqual(JSON.parse(command.decode({action:'propose',queries:[],skus:[],parts:[{skuOver:'001',quantity:2}],explanation:''}).arguments),{parts:[{skuOver:'001',quantity:2}]});assert.throws(()=>command.decode([]),/ai_invalid_response/);});

test('tool wire responses need no paid narrative and do not expose unverified prose',()=>{
 assert.deepEqual(command.schema.required,['action','queries','skus','parts']);
 assert.equal(command.schema.properties.explanation,undefined);
 const result=command.decode({action:'details',queries:[],skus:['001'],parts:[]});
 assert.equal(result.explanation,'');assert.deepEqual(JSON.parse(result.arguments),{skus:['001']});
});
