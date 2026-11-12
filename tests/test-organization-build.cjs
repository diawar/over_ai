'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createServer}=require('../tools/preview-app.cjs');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
const {createCorelabData}=require('../tools/corelab-data.cjs');
const {validatePartPreferences}=require('../tools/part-preferences.cjs');
test('catalog accepts exact nonnumeric identifiers and still rejects duplicates and control characters',()=>{
  const item={skuOver:'RAM:001/А',category:'Оперативная память',name:'RAM',attributes:{},offers:[]};
  assert.doesNotThrow(()=>createCorelabData([item]));
  assert.throws(()=>createCorelabData([item,item]),/invalid/);
  assert.throws(()=>createCorelabData([{...item,skuOver:'bad\nSKU'}]),/invalid/);
  assert.equal(validatePartPreferences({skus:{'Оперативная память':item.skuOver}}).skus['Оперативная память'],item.skuOver);
});
test('concurrent organizations with identical SKUs retain their own prices, links and pinned selections',async()=>{
  const inventories=new Map([1,2].map(id=>{
    const rows=createBuildFixture().getBuildCandidates().map(row=>{
      row.skuOver=row.product.skuOver='SHOP:'+row.skuOver;
      row.offer.price+=id*1000;row.product.productUrl=`https://shop${id}.example/product/${encodeURIComponent(row.skuOver)}`;
      return row;
    });return [id,rows];
  }));
  const server=createServer({chatService:{},buildDataProvider:async id=>({getBuildCandidates:()=>inventories.get(id)})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const build=async(id,skus={})=>{
    const response=await fetch(base+`/api/pc-build?organization_id=${id}`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
      body:JSON.stringify({city:'Алматы',purpose:'Для игр',tasks:'CS2',cpu:'AMD',budget:1000000,partPreferences:{skus}})});
    assert.equal(response.status,200);return (await response.json()).build;
  };
  try{
    const [first,second]=await Promise.all([build(1),build(2)]);
    for(const [id,result] of [[1,first],[2,second]])for(const part of result.parts){
      assert.ok(part.productUrl.startsWith(`https://shop${id}.example/`));
      const row=inventories.get(id).find(row=>row.skuOver===part.skuOver);
      assert.equal(part.price,row.offer.price*part.quantity);
    }
    assert.notEqual(first.total,second.total);
    const ram=first.parts.find(part=>part.category==='Оперативная память');
    const pinned=await build(1,{'Оперативная память':ram.skuOver});
    assert.equal(pinned.parts.find(part=>part.category==='Оперативная память').skuOver,ram.skuOver);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
