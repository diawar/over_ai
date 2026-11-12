'use strict';

// Keep the offline property template aligned with the comparisons implemented
// by the PC builder. Run without --apply to inspect changes first.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const builder = fs.readFileSync(path.join(root, 'tools', 'pc-builder.cjs'), 'utf8');
const match = builder.match(/const CHECKED_ATTRIBUTES = new Set\(\[([\s\S]*?)\]\)/);
if (!match) throw new Error('CHECKED_ATTRIBUTES was not found');
const checked = new Set([...match[1].matchAll(/'([a-z][a-z0-9_]+)'/g)].map(row => row[1]));
const file = path.join(root, 'corelab', 'backend', 'app', 'pc_property_templates.json');
const original = fs.readFileSync(file, 'utf8');
let category = null;
const changed = [];
const updated = original.split(/(?<=\n)/).map(line => {
  const group = line.match(/^  \{"code":"([^"]+)","label":.*"attributes":\[/);
  if (group) {
    category = group[1];
    return line;
  }
  const field = line.match(/^    \{"code":"([^"]+)"/);
  if (!field || !checked.has(field[1]) ||
      (category === 'aio_cooler' && field[1] === 'cpu_cooler_tdp_w')) return line;
  let next = line.replace('"level":"recommended"', '"level":"required"');
  if (!next.includes('"level":"required"')) throw new Error(`No level: ${category}/${field[1]}`);
  if (!next.includes('"required_for_selection":true')) {
    next = next.replace('"required_for_selection":false', '"required_for_selection":true');
    if (!next.includes('"required_for_selection":true'))
      next = next.replace('"level":"required"', '"level":"required","required_for_selection":true');
  }
  if (next !== line) changed.push(`${category}/${field[1]}`);
  return next;
}).join('');
JSON.parse(updated);
for (const item of changed) process.stdout.write(`${item}\n`);
process.stdout.write(`${changed.length} template rules to update\n`);
if (process.argv.includes('--apply') && changed.length) fs.writeFileSync(file, updated);
