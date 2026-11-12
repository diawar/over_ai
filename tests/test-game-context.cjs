'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzeGames,setPopularGames,getPopularGames,refreshPopularGames}=require('../tools/game-context.cjs');
const {requests1440p}=require('../tools/performance-evidence.cjs');

test('mixed named games do not inherit the CS2-only CPU emphasis',()=>{
  assert.equal(analyzeGames('CS2 и Valorant').competitiveOnly,true);
  const mixed=analyzeGames('CS2, PUBG, Dota 2');
  assert.deepEqual(mixed.titles,['Counter-Strike 2','Dota 2','PUBG']);
  assert.equal(mixed.competitiveOnly,false);
  assert.equal(analyzeGames('CS2, неизвестная новая игра').competitiveOnly,false);
  assert.equal(analyzeGames('Cyberpunk 2077, Starfield, Hogwarts Legacy').titles.length,3);
});

test('selected resolution takes precedence over text and enables QHD evidence',()=>{
  assert.equal(requests1440p('CS2','1440p'),true);
  assert.equal(requests1440p('CS2 1440p','1080p'),false);
  assert.equal(requests1440p('PUBG QHD','unknown'),true);
});

test('public Steam chart refresh accepts game titles and keeps previous list on failure',async()=>{
  const ids=[11,12,13,14,15];
  const fetcher=async url=>({ok:true,json:async()=>url.includes('GetMostPlayedGames')
    ?{response:{ranks:ids.map(appid=>({appid}))}}
    :{[Number(new URL(url).searchParams.get('appids'))]:{success:true,data:{type:'game',
      name:`Sample Game ${new URL(url).searchParams.get('appids')}`}}}});
  assert.equal(await refreshPopularGames(fetcher),5);
  assert.equal(analyzeGames('Sample Game 13').titles.includes('Sample Game 13'),true);
  await assert.rejects(refreshPopularGames(async()=>({ok:false})),/steam_chart_unavailable/);
  assert.equal(getPopularGames().length,5);
  setPopularGames([]);
});
