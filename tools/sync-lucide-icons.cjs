// Generate the local, framework-free subset used by the PC selection Mini App.
// Run after npm ci in corelab/frontend: node tools/sync-lucide-icons.cjs
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = path.join(root, 'corelab/frontend/node_modules/lucide-static');
const names = ['arrow-up-right', 'arrow-up', 'arrow-left', 'check', 'sparkles'];
function svg(name) {
  return fs.readFileSync(path.join(pkg, 'icons', name + '.svg'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '').trim()
    .replace(/\s+/g, ' ')
    .replace('class="lucide ', 'aria-hidden="true" focusable="false" class="app-icon lucide ')
    .replace('width="24"', 'width="1em"').replace('height="24"', 'height="1em"');
}
const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
const license = fs.readFileSync(path.join(pkg, 'LICENSE'), 'utf8');
const icons = Object.fromEntries(names.map(name => [name, svg(name)]));
fs.writeFileSync(path.join(root, 'app/lucide-icons.js'),
  `/*! Lucide ${version} - ISC\n${license}*/\n` +
  `(function () {\n  'use strict';\n  const icons = Object.freeze(${JSON.stringify(icons, null, 2)});\n` +
  `  globalThis.corelabIcon = name => { if (!icons[name]) throw new Error('Unknown icon: ' + name); return icons[name]; };\n})();\n`);
// Static HTML placeholders are replaced at build time, so icons need no CDN or runtime scan.
for (const filename of ['app/index.html', 'corelab/mini-app/index.html']) {
  const file = path.join(root, filename);
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<!-- lucide:([a-z-]+) -->[\s\S]*?<!-- \/lucide -->/g,
    (_, name) => `<!-- lucide:${name} -->${svg(name)}<!-- /lucide -->`);
  fs.writeFileSync(file, html);
  fs.writeFileSync(path.join(path.dirname(file), 'lucide-LICENSE.txt'), license);
}
