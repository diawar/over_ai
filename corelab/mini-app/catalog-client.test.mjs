import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogClient } from './catalog-client.mjs';

test('stores only the chosen shop and uses bearer auth without cookies', async () => {
  const stored = new Map([['corelab:last-shop:corelab', '1']]);
  const calls = [];
  const client = createCatalogClient({ storage: {getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)},
    fetcher: async (url, options) => {
      calls.push({url, options});
      return {ok:true,json:async()=>url.endsWith('/session') ?
        {access_token:'token',organization:{id:2},campaign:'ad'} : {items:[],total:0}};
    }});
  assert.equal((await client.launch({initData:'signed'})).organization.id, 2);
  await client.products({organization_id:99,page:2});
  assert.equal(JSON.parse(calls[0].options.body).remembered_organization_id, 1);
  assert.equal(calls[1].url, '/api/v1/products?page=2');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer token');
  assert.equal(calls[1].options.credentials, 'omit');
  assert.deepEqual([...stored], [['corelab:last-shop:corelab','2']]);
});

test('discards in-flight responses when shop changes', async () => {
  let finish;
  const client = createCatalogClient({fetcher: async url => {
    if(url.endsWith('/products')) await new Promise(resolve=>{finish=resolve});
    return {ok:true,json:async()=>({access_token:'t',organization:{id:1}})};
  }});
  await client.launch({initData:'signed'});
  const pending = client.products();
  const rejected = assert.rejects(pending, /shop_changed/);
  await client.chooseShop(2);
  finish();
  await rejected;
});

test('no fallback data after authentication failure', async () => {
  const client = createCatalogClient({fetcher:async()=>({ok:false,status:401,json:async()=>({detail:'expired'})})});
  await assert.rejects(client.launch({initData:'invalid'}), /expired/);
  await assert.rejects(client.products(), /expired/);
});

test('failed shop switch cannot reuse the previous shop session', async () => {
  const calls = [];
  const client = createCatalogClient({fetcher:async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/mini-app/session')) return {ok:true,json:async()=>({access_token:'old',organization:{id:1}})};
    if (url.endsWith('/mini-app/organization')) return {ok:false,status:403,json:async()=>({detail:'unavailable'})};
    return {ok:false,status:401,json:async()=>({detail:'authentication required'})};
  }});
  await client.launch({initData:'signed'});
  await assert.rejects(client.chooseShop(2), /unavailable/);
  await assert.rejects(client.products(), /authentication required/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer old');
  assert.equal(calls[2].options.headers.Authorization, undefined);
});

test('browser preview uses the admin cookie once, then reads with a consumer bearer token', async () => {
  const calls = [];
  const stored = new Map();
  const client = createCatalogClient({storage:{setItem:(key,value)=>stored.set(key,value)},
    fetcher:async (url, options) => {
      calls.push({url,options});
      return {ok:true,json:async()=>url.endsWith('/preview') ?
        {access_token:'preview-token',organization:{id:1}} : {items:[],total:0}};
    }});
  await client.preview({csrfToken:'csrf'});
  await client.products();
  assert.equal(calls[0].url, '/api/v1/admin/mini-app/preview');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'csrf');
  assert.equal(calls[1].options.credentials, 'omit');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer preview-token');
  assert.equal(stored.size, 0);
});
