'use strict';

// Title recognition only. These labels do not claim FPS or hardware requirements.
const TITLES = [
  ['Counter-Strike 2',/\bcs\s*2\b|counter[ -]?strike(?:\s*2)?/iu,'competitive'],
  ['Valorant',/valorant|валорант/iu,'competitive'],
  ['Dota 2',/dota\s*2|дота\s*2/iu,'competitive'],
  ['League of Legends',/league of legends|\blol\b|лига легенд/iu,'competitive'],
  ['Rainbow Six Siege',/rainbow six(?: siege)?|\br6s\b/iu,'competitive'],
  ['Overwatch 2',/overwatch\s*2|оверватч\s*2/iu,'competitive'],
  ['PUBG',/\bpubg\b|пабг/iu,'general'],
  ['Apex Legends',/apex(?: legends)?|апекс/iu,'general'],
  ['Fortnite',/fortnite|фортнайт/iu,'general'],
  ['Call of Duty / Warzone',/call of duty|\bcod\b|warzone|варзон/iu,'general'],
  ['Battlefield',/battlefield|батлфилд/iu,'general'],
  ['Escape from Tarkov',/escape from tarkov|тарков/iu,'general'],
  ['Deadlock',/deadlock|дедлок/iu,'general'],
  ['Marvel Rivals',/marvel rivals/iu,'general'],
  ['Cyberpunk 2077',/cyberpunk(?:\s*2077)?|киберпанк/iu,'general'],
  ['Red Dead Redemption 2',/red dead redemption\s*2|\brdr\s*2\b/iu,'general'],
  ['Hogwarts Legacy',/hogwarts legacy|хогвартс легаси/iu,'general'],
  ['Starfield',/starfield|старфилд/iu,'general'],
  ['Elden Ring',/elden ring|элден ринг/iu,'general'],
  ['Grand Theft Auto V',/\bgta\s*(?:5|v)\b|гта\s*5/iu,'general'],
  ['Minecraft',/minecraft|майнкрафт/iu,'general'],
  ['World of Tanks',/world of tanks|мир танков|\bwot\b/iu,'general'],
];
const CHART_URL='https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/';
let popularNames=[];

function setPopularGames(names){
  if(!Array.isArray(names))return;
  popularNames=[...new Set(names.filter(name=>typeof name==='string'&&name.length>=3&&name.length<=80))].slice(0,50);
}

async function refreshPopularGames(fetcher=fetch){
  const chart=await fetcher(CHART_URL,{signal:AbortSignal.timeout(10000)});
  if(!chart.ok)throw Error('steam_chart_unavailable');
  const ranks=(await chart.json())?.response?.ranks;
  if(!Array.isArray(ranks)||ranks.length<5)throw Error('steam_chart_invalid');
  const ids=ranks.slice(0,40).map(row=>row.appid).filter(id=>Number.isSafeInteger(id)&&id>0);
  const names=[];
  for(let offset=0;offset<ids.length;offset+=5){
    const batch=await Promise.allSettled(ids.slice(offset,offset+5).map(async id=>{
      const url=`https://store.steampowered.com/api/appdetails?appids=${id}&cc=kz&l=english&filters=basic`;
      const response=await fetcher(url,{signal:AbortSignal.timeout(7000)});
      if(!response.ok)return null;
      const detail=(await response.json())?.[id];
      return detail?.success&&detail.data?.type==='game'?detail.data.name:null;
    }));
    for(const item of batch)if(item.status==='fulfilled'&&item.value)names.push(item.value);
  }
  if(names.length<5)throw Error('steam_names_unavailable');
  setPopularGames(names);
  return popularNames.length;
}

function analyzeGames(tasks){
  const text=String(tasks||'');
  const matches=TITLES.filter(([,pattern])=>pattern.test(text));
  const dynamic=popularNames.filter(name=>text.toLocaleLowerCase('ru-RU').includes(name.toLocaleLowerCase('ru-RU'))&&
    !TITLES.some(([,pattern])=>pattern.test(name)));
  const listed=text.split(/[,;\n]|\s+и\s+/iu).map(part=>part.trim()).filter(Boolean);
  const allListedKnown=listed.every(part=>TITLES.some(([,pattern])=>pattern.test(part))||
    popularNames.some(name=>part.toLocaleLowerCase('ru-RU').includes(name.toLocaleLowerCase('ru-RU'))));
  return {titles:[...matches.map(([title])=>title),...dynamic],
    competitiveOnly:matches.length>0&&dynamic.length===0&&allListedKnown&&
      matches.every(([, ,kind])=>kind==='competitive')};
}

module.exports={analyzeGames,setPopularGames,getPopularGames:()=>[...popularNames],refreshPopularGames};
