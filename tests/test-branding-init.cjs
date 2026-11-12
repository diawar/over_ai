const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname,'../app/branding-init.js'),'utf8');
function bootstrap(search, entries = {}, denied = false) {
  const store = new Map(Object.entries(entries)), styles = {}, classes = new Set();
  let timeout;
  const context = vm.createContext({location:{search},URLSearchParams,window:{addEventListener(){}},
    localStorage:{getItem:k=>{if(denied)throw Error('denied');return store.get(k)},setItem:(k,v)=>store.set(k,v)},
    document:{documentElement:{style:{setProperty:(k,v)=>styles[k]=v},classList:{toggle:(k,on)=>on?classes.add(k):classes.delete(k),remove:k=>classes.delete(k)}}},
    setTimeout:fn=>{timeout=fn;return 1},clearTimeout(){} });
  vm.runInContext(code,context);
  return {context,store,styles,classes,timeout};
}
test('branding is restored before app execution and isolated by organization',()=>{
  const a=bootstrap('?organization_id=1',{'corelab:brand-color:1':'#fb7602','corelab:brand-color:2':'#123456'});
  assert.equal(a.styles['--accent'],'#fb7602'); assert.equal(a.classes.size,0);
  a.context.corelabTheme.apply('#00aa00');
  assert.equal(a.store.get('corelab:brand-color:1'),'#00aa00'); assert.equal(a.store.get('corelab:brand-color:2'),'#123456');
  const b=bootstrap('?organization_id=3',{'corelab:brand-color:1':'#fb7602'});
  assert.equal(b.styles['--accent'],undefined); assert.ok(b.classes.has('brand-pending'));
  b.context.corelabTheme.apply('#223344'); b.context.corelabTheme.ready(); assert.equal(b.classes.size,0);
});
test('invalid or blocked storage and branding failure cannot leave a blank page',()=>{
  for(const b of [bootstrap('',{'corelab:brand-color:1':'red; color: blue'}),bootstrap('',{},true)]) {
    assert.equal(b.styles['--accent'],undefined); assert.ok(b.classes.has('brand-pending'));
    b.timeout(); assert.equal(b.classes.size,0);
  }
});
test('old default is revalidated without blocking an explicitly chosen indigo from the server',()=>{
  const b=bootstrap('?organization_id=2',{'corelab:brand-color:2':'#5146e5'});
  assert.equal(b.styles['--accent'],undefined);
  assert.ok(b.classes.has('brand-pending'));
  b.context.corelabTheme.apply('#ff416c'); b.context.corelabTheme.ready();
  assert.equal(b.styles['--accent'],'#ff416c');
  b.context.corelabTheme.apply('#5146e5');
  assert.equal(b.styles['--accent'],'#5146e5');
});
