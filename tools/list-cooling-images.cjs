'use strict';
const fs=require('node:fs');
const root='data/cooling-source-cache-20261028/';
const index=JSON.parse(fs.readFileSync(root+'index.json'));
for(const id of process.argv.slice(2)){
  const url=Object.keys(index).find(url=>url.includes('id='+id)&&index[url].status===200);
  if(!url)continue;
  const html=fs.readFileSync(root+index[url].file,'utf8');
  const urls=[...new Set([...html.matchAll(/https?:[^\s"'<>]+\.(?:jpg|png)/gi)].map(match=>match[0])
    .filter(url=>url.includes('static.idcooling.com')))];
  console.log(id,JSON.stringify(urls.slice(-20),null,2));
}
