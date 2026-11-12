'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAiCatalogSession}=require('../tools/ai-catalog-session.cjs');
const {createBuildFixture}=require('./fixtures/pc-build-fixture.cjs');
const request={budget:1000000,cpu:'AMD',purpose:'Для офиса'};
test('PSU cable search uses documented cables, never the plug count',()=>{
 const rows=createBuildFixture().getBuildCandidates();const psu=rows.find(r=>r.category==='Блоки питания');
 psu.component.facts.powerSupplySpecifications.value.pcieConnectors=[{kind:'pcie_8',count:4,cables:2}];
 const unknown=structuredClone(psu);unknown.skuOver='unknown-cables';unknown.component.facts.powerSupplySpecifications.value.pcieConnectors[0].cables=null;rows.push(unknown);
 const session=createAiCatalogSession({localData:{getBuildCandidates:()=>rows},organizationId:1,city:'Алматы',request});
 const query={category:'Блоки питания',filters:[{field:'recordedPcie8CableCount',op:'gte',value:2}]};
 assert.deepEqual(session.search(query).items.map(i=>i.skuOver),[psu.skuOver]);
 assert.equal(session.search({...query,filters:[{field:'recordedPcie8CableCount',op:'gte',value:3}]}).total,0);
 assert.equal(session.details({skus:['unknown-cables']}).items[0].searchMetadata.recordedPcie8CableCount,null);
});
function setup(org=1){
 const rows=createBuildFixture().getBuildCandidates();
 const localData={getBuildCandidates:()=>rows};
 return {rows,session:createAiCatalogSession({localData,organizationId:org,city:'Алматы',request})};
}
test('catalog pages expose every candidate, not just the cheapest shortlist',()=>{
 const {rows,session}=setup();let offset=0,skus=[];
 do{const page=session.search({limit:2,offset});skus.push(...page.items.map(i=>i.skuOver));offset=page.nextOffset;}while(offset!==null);
 assert.deepEqual(skus.sort(),rows.map(r=>r.skuOver).sort());
 assert.equal(session.summary().total,rows.length);
 assert.ok(session.search({category:'Видеокарты',sort:'price_desc'}).items[0].price>session.search({category:'Видеокарты',sort:'price_asc'}).items[0].price);
});
test('filters use real attributes and unknown values never match a numeric floor',()=>{
 const {session}=setup();
 const page=session.search({category:'Видеокарты',filters:[{field:'memoryGB',op:'gte',value:12}]});
 assert.equal(page.items.length,1);assert.match(page.items[0].name,/5070/);
 assert.equal(session.search({filters:[{field:'nonexistent',op:'gte',value:0}]}).total,0);
 assert.equal(session.search({category:'Кулеры для процессоров',filters:[{field:'mountingSockets',op:'contains',value:'AM5'}]}).total,1);
});
test('model cannot switch organization or execute a query and page size is bounded',()=>{
 const {session}=setup();
 for(const query of [{organizationId:2},{limit:1000},{offset:-1},{filters:[{field:'constructor',op:'eq',value:'x'}]},{filters:[{field:'price',op:'eval',value:'x'}]}])
  assert.throws(()=>session.search(query),/invalid_catalog_query/);
 assert.throws(()=>session.details({skus:Array(9).fill('1')}),/invalid_catalog_query/);
});
test('details and validation share immutable snapshot and omit private fields',()=>{
 const {session,rows}=setup();const sku=rows[0].skuOver,price=rows[0].offer.price;
 rows[0].offer.price=1;rows[0].product.privateEmail='private';
 const detail=session.details({skus:[sku,'foreign']});
 assert.equal(detail.items[0].price,price);assert.equal(detail.items[0].privateEmail,undefined);
 assert.deepEqual(detail.missing,['foreign']);
 detail.items[0].specifications.socket='WRONG';
 assert.equal(session.details({skus:[sku]}).items[0].specifications.socket,'AM5');
 const parts=rows.filter(r=>r.category!=='Видеокарты').map(r=>({skuOver:r.skuOver,quantity:1}));
 const report=session.validate({snapshotId:session.snapshotId,parts});
 assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.total,240000);
 const other=setup(2).session;
 assert.equal(other.validate({snapshotId:session.snapshotId,parts}).violations[0].code,'snapshot_mismatch');
});
test('evidence distinguishes unknown tests and exact VRAM variants',()=>{
 const {session}=setup();const gpu=session.search({category:'Видеокарты'}).items[0];
 const detail=session.details({skus:[gpu.skuOver]}).items[0];
 assert.equal(detail.performance.workload.status,'not_evaluated');
 assert.equal(detail.missingValuesAreUnknown,true);
});
test('search uses all words in any order and distinguishes price cap from absent stock',()=>{const {session}=setup();const page=session.search({category:'Оперативная память',text:'DIMM DDR5',maxPrice:1});assert.equal(page.total,0);assert.equal(page.outsidePriceRange.minPrice,40000);assert.equal(session.search({category:'Оперативная память',text:'DIMM DDR5'}).total,1);assert.equal(session.search({text:'DIMM impossible'}).total,0);});
test('real filter schema and unknown field diagnostics are exposed',()=>{const {session}=setup();assert.equal(session.summary().categories.find(c=>c.category==='Оперативная память').filterFields.capacityGB,'number');assert.deepEqual(session.search({filters:[{field:'invented',op:'eq',value:32}]}).unknownFilterFields,['invented']);});
test('text search includes verified socket values even when missing from product title',()=>{const {session}=setup();assert.ok(session.search({category:'Материнские платы',text:'B650 AM5'}).total>0);assert.equal(session.search({category:'Материнские платы',text:'LGA1851'}).total,0);});

test('recorded CPU header search requires explicit control and current, not just four pins',()=>{
 const rows=createBuildFixture().getBuildCandidates(),board=rows.find(r=>r.category==='Материнские платы');
 const incomplete=structuredClone(board);incomplete.skuOver='incomplete';
 for(const h of incomplete.component.facts.motherboardSpecifications.value.coolingHeaders)delete h.control;
 rows.push(incomplete);
 const session=createAiCatalogSession({localData:{getBuildCandidates:()=>rows},organizationId:1,city:'Алматы',request});
 const result=session.search({category:'Материнские платы',filters:[{field:'hasRecordedCpuFanHeader',op:'eq',value:true}]});
 assert.deepEqual(result.items.map(i=>i.skuOver),[board.skuOver]);
 assert.equal(session.summary().categories.find(c=>c.category==='Материнские платы').filterFields.hasRecordedCpuFanHeader,'boolean');
 assert.deepEqual(session.summary().categories.find(c=>c.category==='Материнские платы').filterValues.formFactor,['mATX']);
 assert.equal(session.details({skus:['incomplete']}).items[0].searchMetadata.hasRecordedCpuFanHeader,false);
 assert.equal(session.details({skus:[board.skuOver]}).items[0].searchMetadata.hasRecordedCpuFanHeader,true);
 assert.match(session.search({category:'Материнские платы',filters:[{field:'formFactor',op:'eq',value:'not a recorded value'}]}).hint,/No matches/);
 assert.equal(session.details({skus:[board.skuOver]}).items[0].specifications.hasRecordedCpuFanHeader,undefined);
});

test('empty AND text offers an explicit retry without weakening price or structured filters',()=>{
 const {session}=setup();const filters=[{field:'memoryGB',op:'gte',value:12}];
 const page=session.search({category:'Видеокарты',text:'5070 5080',maxPrice:260000,filters});
 assert.equal(page.total,0);assert.deepEqual(page.items,[]);assert.equal(page.textRestriction.matchesWithoutText,1);
 assert.equal(page.textRestriction.suggestedQuery.maxPrice,260000);assert.deepEqual(page.textRestriction.suggestedQuery.filters,filters);
 assert.equal(page.textRestriction.suggestedQuery.text,'');
 assert.equal(session.search({category:'Видеокарты',text:'5070 5080',maxPrice:100,filters}).textRestriction,undefined);
});

test('price distribution covers all matching stock before price caps and pagination',()=>{
 const {session}=setup();
 const page=session.search({category:'Видеокарты',maxPrice:160000,limit:1});
 assert.equal(page.total,1);assert.equal(page.matchingPriceDistribution.count,2);
 assert.equal(page.matchingPriceDistribution.min,150000);assert.equal(page.matchingPriceDistribution.max,250000);
 const filtered=session.search({category:'Видеокарты',maxPrice:1,filters:[{field:'memoryGB',op:'gte',value:12}]});
 assert.equal(filtered.total,0);assert.equal(filtered.matchingPriceDistribution.count,1);
 assert.equal(filtered.matchingPriceDistribution.min,250000);
 assert.equal(session.search({text:'nonexistent'}).matchingPriceDistribution,null);
 assert.deepEqual(session.summary().categories.find(c=>c.category==='Видеокарты').priceDistribution,page.matchingPriceDistribution);
});
