'use strict';

// Manually checked calculator results for exact CPU, GPU, VRAM, game and preset.
// These are predictions from pc-builds.com, not measured benchmarks or ranking inputs.
const ESTIMATES = Object.freeze([
  Object.freeze({
    cpu:'AMD Ryzen 7 7800X3D',gpu:'RTX 5060 Ti',memoryGB:8,
    game:'Cyberpunk 2077',preset:'Medium',fps:{'1440p':67,'4K':44},
    url:'https://pc-builds.com/fps-calculator/result/1nt1Bm02g/ryzen-7-7800x3d/geforce-rtx-5060-ti/cyberpunk-2077/',
    checkedAt:'2026-10-26'
  }),
  Object.freeze({
    cpu:'AMD Ryzen 5 7600',gpu:'RTX 5060 Ti',memoryGB:16,
    game:'Cyberpunk 2077',preset:'Medium',fps:{'1440p':67,'4K':45},
    url:'https://pc-builds.com/fps-calculator/result/1lq1FT02g/ryzen-5-7600/geforce-rtx-5060-ti/cyberpunk-2077/',
    checkedAt:'2026-10-26'
  }),
  Object.freeze({
    cpu:'AMD Ryzen 5 4500',gpu:'RTX 5070',memoryGB:12,
    game:'Cyberpunk 2077',preset:'Medium',fps:{'1440p':68,'4K':56},
    url:'https://pc-builds.com/fps-calculator/result/1fG1xO02g/ryzen-5-4500/geforce-rtx-5070/cyberpunk-2077/',
    checkedAt:'2026-10-26'
  }),
  Object.freeze({
    cpu:'AMD Ryzen 5 7600',gpu:'RTX 5070 Ti',memoryGB:16,
    game:'Cyberpunk 2077',preset:'Medium',fps:{'1440p':97,'4K':64},
    url:'https://pc-builds.com/fps-calculator/result/1lq1wO02g/ryzen-5-7600/geforce-rtx-5070-ti/cyberpunk-2077/',
    checkedAt:'2026-10-26'
  }),
  Object.freeze({
    cpu:'AMD Ryzen 7 7800X3D',gpu:'RTX 5060',memoryGB:8,
    game:'Cyberpunk 2077',preset:'Medium',fps:{'1440p':62,'4K':41},
    url:'https://pc-builds.com/fps-calculator/result/1nt1sm02g/ryzen-7-7800x3d/geforce-rtx-5060/cyberpunk-2077/',
    checkedAt:'2026-10-26'
  })
]);

function pcBuildsEstimate(parts,tasks,resolution){
  if(!['1440p','4K'].includes(resolution)||
    !/(?:^|\W)cyberpunk(?:\s*2077)?(?!\s*:\s*ultimate)(?:\W|$)/iu.test(String(tasks||'')))return null;
  const cpu=parts?.find(part=>part.category==='Процессоры')?.name||'';
  const gpu=parts?.find(part=>part.category==='Видеокарты')?.name||'';
  const match=ESTIMATES.find(row=>
    new RegExp(`\\b${row.cpu.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(cpu)&&
    new RegExp(`\\b${row.gpu.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b${['RTX 5060','RTX 5070'].includes(row.gpu)?'(?!\\s*Ti)':''}`,'i').test(gpu)&&
    new RegExp(`\\b${row.memoryGB}\\s*GB\\b`,'i').test(gpu));
  return match?{source:'pc-builds.com',game:match.game,resolution,
    preset:match.preset,averageFps:match.fps[resolution],url:match.url,checkedAt:match.checkedAt,
    scope:'Оценка калькулятора для модели CPU и GPU при средних настройках; не измерение этой сборки.'}:null;
}

module.exports={pcBuildsEstimate};
