'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createLocalData, LocalDataError} = require('../tools/local-data.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corelab-local-data-'));
  fs.mkdirSync(path.join(root, 'data'));
  const items = [
    {skuOver:'1001', article:'CPU-A', manufacturer:'Maker A', category:'Процессоры'},
    {skuOver:'1002', article:'BOARD-A', manufacturer:'Maker B', category:'Материнские платы'}
  ];
  const source = {manufacturer:'Maker',pageTitle:'Официальные характеристики',checkedAt:'2026-10-10T10:00:00Z',reviewedBy:'reviewer'};
  const component = (skuOver, article, manufacturer, factKey) => ({
    skuOver,category:'Test',article,manufacturer,officialModel:article,status:'verified',
    reviewedAt:'2026-10-10T10:00:00Z',reviewedBy:'reviewer',
    facts:{[factKey]:{value:'AM5',source}},
    merchantProductDetails:[{sectionName:'Processor',attributeName:'Socket',attributeValue:'AM5'}]
  });
  fs.writeFileSync(path.join(root,'data','p1-catalog.json'),JSON.stringify({
    downloadedAtUtc:'2026-10-10T10:00:00Z',totalElements:items.length,items
  }));
  fs.writeFileSync(path.join(root,'data','component-characteristics.json'),JSON.stringify({
    schemaVersion:1,
    components:[component('1001','CPU-A','Maker A','socket'),component('1002','BOARD-A','Maker B','socket')],
    compatibilityChecks:[{
      leftSkuOver:'1001',rightSkuOver:'1002',result:'compatible',reason:'Verified socket match',
      factReferences:['1001.socket','1002.socket'],sources:[source],checkedAt:'2026-10-10T10:00:00Z',reviewedBy:'reviewer'
    }]
  }));
  return root;
}

test('loads only exact SKU evidence and reports the local snapshot without claiming builds are ready', () => {
  const root = fixture();
  try {
    const local = createLocalData(root);
    assert.deepEqual(local.status(),{
      catalogLoaded:true,snapshotAt:'2026-10-10T10:00:00Z',itemCount:2,
      evidenceDatabaseLoaded:true,verifiedComponentCount:2,compatibilityCheckCount:1,buildEngineReady:false,buildsReady:false
    });
    assert.equal(local.getVerifiedComponent('1001').officialModel,'CPU-A');
    assert.equal(local.getVerifiedComponent('01001'),null);
    assert.equal(local.getCompatibility('1002','1001').result,'compatible');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('rejects evidence whose article does not exactly match the P1 item', () => {
  const root = fixture();
  try {
    const filename = path.join(root,'data','component-characteristics.json');
    const evidence = JSON.parse(fs.readFileSync(filename,'utf8'));
    evidence.components[0].article='CPU-A-OTHER';
    fs.writeFileSync(filename,JSON.stringify(evidence));
    assert.throws(()=>createLocalData(root),error=>error instanceof LocalDataError&&error.code==='local_evidence_identity_invalid');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('rejects URLs anywhere in the evidence database', () => {
  const root = fixture();
  try {
    const filename = path.join(root,'data','component-characteristics.json');
    const evidence = JSON.parse(fs.readFileSync(filename,'utf8'));
    evidence.components[0].facts.socket.source.url='https://example.invalid/spec';
    fs.writeFileSync(filename,JSON.stringify(evidence));
    assert.throws(()=>createLocalData(root),error=>error instanceof LocalDataError&&error.code==='local_data_invalid');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('rejects duplicate Google Merchant product detail attributes', () => {
  const root = fixture();
  try {
    const filename = path.join(root,'data','component-characteristics.json');
    const evidence = JSON.parse(fs.readFileSync(filename,'utf8'));
    evidence.components[0].merchantProductDetails.push({
      sectionName:'processor',attributeName:'socket',attributeValue:'AM5'
    });
    fs.writeFileSync(filename,JSON.stringify(evidence));
    assert.throws(()=>createLocalData(root),error=>error instanceof LocalDataError&&error.code==='local_evidence_review_invalid');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
