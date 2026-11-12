'use strict';
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'backend', 'app', 'pc_property_templates.json');
const original = fs.readFileSync(file, 'utf8');
const definitions = {
  motherboard: {
    code: 'motherboard_internal_usb_headers',
    label: 'Внутренние разъёмы USB для передней панели',
    value_type: 'list', level: 'required', required_for_selection: true,
    note: 'JSON-массив {kind,count,raw}: usb2_9pin, usb3_19pin, usb_c_type_e. count — число физических внутренних разъёмов, не внешних портов. Указывать только подтверждённые типы; неизвестный тип не заменять нулём. Несовпадение с корпусом даёт предупреждение, не исключение из подбора.'
  },
  pc_case: {
    code: 'case_front_usb_headers',
    label: 'Подключение передних USB-портов корпуса',
    value_type: 'list', level: 'required', required_for_selection: true,
    note: 'JSON-массив {kind,count,ports,raw}: usb2_9pin, usb3_19pin, usb_c_type_e. ports — число внешних портов, count — требуемые внутренние разъёмы: один USB 2.0/3.x header на два Type-A порта, один Type-E на один USB-C. Если схема кабелей отличается, указывать подтверждённое число. Несовпадение предупреждает клиента и не исключает товар.'
  }
};
let category = null;
const lines = original.split(/(?<=\n)/);
const result = [];
for (const line of lines) {
  if (line.startsWith('    {"code":"motherboard_usb2_headers"')) continue;
  const group = line.match(/^  \{"code":"([^"]+)","label":.*"attributes":\[/);
  if (group) category = group[1];
  if (line.startsWith('  ]}') && definitions[category]) {
    const row = definitions[category];
    if (!original.includes(`"code":"${row.code}"`)) {
      const previous = result.at(-1);
      result[result.length - 1] = previous.replace(/\}\s*$/, '},' + (previous.endsWith('\r\n') ? '\r\n' : '\n'));
      result.push('    ' + JSON.stringify(row) + (line.endsWith('\r\n') ? '\r\n' : '\n'));
    }
  }
  result.push(line);
}
const updated = result.join('');
JSON.parse(updated);
if (updated !== original) fs.writeFileSync(file, updated);
process.stdout.write(updated === original ? 'UNCHANGED\n' : 'ADDED USB template rules\n');
