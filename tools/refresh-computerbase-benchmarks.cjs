'use strict';

const fs=require('node:fs');
const path=require('node:path');
const bundled=require('./benchmark-observations.json');

function chartObservations(html,id){
  const start=html.indexOf(`id="${id}"`);
  if(start<0)throw Error(`benchmark_chart_missing:${id}`);
  const end=html.indexOf('class="chart__unit"',start);
  if(end<0)throw Error(`benchmark_chart_incomplete:${id}`);
  const chart=html.slice(start,end);
  const observations=[];
  for(const row of chart.matchAll(/<li class="chart__row">([\s\S]*?)<\/li>/g)){
    const label=row[1].match(/<div class="chart__item">([\s\S]*?)<\/div>/)?.[1]
      ?.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
      .replace(/\s+/g,' ').trim();
    const match=label?.match(/^(.+?)\s*\((\d+)\s*GB\)$/i);
    const fps=Number(row[1].match(/class="chart__label"\s+data-value="([\d.]+)"/)?.[1]);
    if(match&&Number.isFinite(fps)&&fps>0&&fps<500)
      observations.push({gpu:match[1].trim(),memoryGB:Number(match[2]),fps:Math.round(fps*10)/10});
  }
  if(observations.length<8)throw Error(`benchmark_chart_too_small:${id}`);
  return observations;
}

function cpuChartObservations(html){
  const id='diagramm-leistungsrating-720p-plus-astral-rtx-5090-durchschnitts-fps';
  const start=html.indexOf(`id="${id}"`);
  const end=html.indexOf('class="chart__unit"',start);
  if(start<0||end<0)throw Error('cpu_benchmark_chart_missing');
  const observations=new Map();
  for(const row of html.slice(start,end).matchAll(/<li class="chart__row">([\s\S]*?)<\/li>/g)){
    const raw=row[1].match(/<div class="chart__item">([\s\S]*?)<\/div>/)?.[1];
    if(!raw||/Single-Chan/i.test(raw))continue;
    const name=raw.split(/<br\s*\/?\s*>/i)[0].replace(/<[^>]+>/g,' ')
      .replace(/\bDual-Chan\b/ig,'').replace(/\s+/g,' ').trim();
    const fps=Number(row[1].match(/class="chart__label"\s+data-value="([\d.]+)"/)?.[1]);
    if(name&&Number.isFinite(fps)&&fps>0&&fps<1000&&!observations.has(name))
      observations.set(name,{model:name,fps:Math.round(fps*10)/10});
  }
  if(observations.size<6)throw Error('cpu_benchmark_chart_too_small');
  return [...observations.values()];
}

async function refreshComputerBaseBenchmarks(current=bundled,fetcher=fetch){
  const url=current.computerbase.url;
  const cpuUrl='https://www.computerbase.de/artikel/prozessoren/rangliste.89909/';
  const [response,cpuResponse]=await Promise.all([url,cpuUrl].map(target=>
    fetcher(target,{signal:AbortSignal.timeout(15000)})));
  if(!response.ok||!cpuResponse.ok)
    throw Error(`computerbase_http_${response.status}_${cpuResponse.status}`);
  const [html,cpuHtml]=await Promise.all([response.text(),cpuResponse.text()]);
  const resolutions={...current.computerbase.resolutions};
  for(const [resolution,id] of Object.entries({
    '1440p':'diagramm-performancerating-rasterizer-2560-1440',
    '4K':'diagramm-performancerating-rasterizer-3840-2160'
  })){
    resolutions[resolution]={...resolutions[resolution],observations:chartObservations(html,id)};
  }
  return {...current,computerbase:{...current.computerbase,
    checkedAt:new Date().toISOString().slice(0,10),resolutions,
    cpu:{url:cpuUrl,metric:'720p CPU-limited games, geometric mean FPS on one reference system',
      baseFps:120,baseScore:24,observations:cpuChartObservations(cpuHtml)}}};
}

if(require.main===module){
  refreshComputerBaseBenchmarks().then(data=>{
    const target=path.join(__dirname,'benchmark-observations.json');
    const staging=`${target}.tmp`;
    fs.writeFileSync(staging,`${JSON.stringify(data,null,2)}\n`);
    fs.renameSync(staging,target);
    console.log(`ComputerBase charts refreshed: ${Object.values(data.computerbase.resolutions)
      .map(row=>row.observations.length).join(', ')} GPUs; ${data.computerbase.cpu.observations.length} CPUs`);
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}

module.exports={chartObservations,cpuChartObservations,refreshComputerBaseBenchmarks};
