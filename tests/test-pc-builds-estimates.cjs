'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {pcBuildsEstimate}=require('../tools/pc-builds-estimates.cjs');

const parts=(cpu,gpu)=>[
  {category:'Процессоры',name:`Процессор ${cpu} OEM`},
  {category:'Видеокарты',name:`Видеокарта ${gpu}`}
];

test('pc-builds estimate requires exact CPU, GPU, VRAM, game and supported resolution',()=>{
  const first=parts('AMD Ryzen 7 7800X3D','Gigabyte GeForce RTX 5060 Ti 8GB');
  const estimate=pcBuildsEstimate(first,'Cyberpunk 2077','1440p');
  assert.equal(estimate.averageFps,67);
  assert.equal(estimate.source,'pc-builds.com');
  assert.equal(pcBuildsEstimate(first,'Cyberpunk','1440p').averageFps,67);
  assert.equal(pcBuildsEstimate(first,'Cyberpunk 2077','1080p'),null);
  assert.equal(pcBuildsEstimate(first,'Dota 2','1440p'),null);
  assert.equal(pcBuildsEstimate(parts('AMD Ryzen 7 7800X3D','GeForce RTX 5060 Ti 16GB'),'Cyberpunk 2077','1440p'),null);
  assert.equal(pcBuildsEstimate(parts('AMD Ryzen 5 7600','GeForce RTX 5060 Ti 16GB'),'Cyberpunk 2077','1440p').averageFps,67);
  assert.equal(pcBuildsEstimate(parts('AMD Ryzen 5 7600','GeForce RTX 5060 Ti 16GB'),'Cyberpunk 2077','4K').averageFps,45);
  assert.equal(pcBuildsEstimate(parts('AMD Ryzen 5 7600','GeForce RTX 5060 Ti 8GB'),'Cyberpunk 2077','1440p'),null);
  assert.equal(pcBuildsEstimate(parts('AMD Ryzen 5 4500','GeForce RTX 5070 12GB'),'Cyberpunk 2077','1440p').averageFps,68);
  assert.equal(pcBuildsEstimate(parts('AMD Ryzen 7 7800X3D','Gigabyte RTX 5060 OC Low Profile 8GB, GV-N5060OC-8GL'),'Cyberpunk 2077','4K').averageFps,41);
  assert.equal(pcBuildsEstimate(parts('AMD Ryzen 5 7600','GeForce RTX 5070 Ti 16GB'),'Cyberpunk 2077','4K').averageFps,64);
});
