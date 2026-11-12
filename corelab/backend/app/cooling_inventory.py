"""Canonical cooling connections shared by manual editing and all loaders."""
import math
import re

COOLING_CODES = frozenset({
    'motherboard_fan_headers', 'motherboard_lighting_headers',
    'cooler_fan_connectors', 'aio_pump_connectors', 'cooling_lighting_connectors', 'case_fan_connector',
})
LABELS = {'fan_pwm_4pin': '4-pin PWM', 'fan_dc_3pin': '3-pin DC',
          'fan_4pin': '4-pin fan', 'fan_3pin': '3-pin fan',
          'argb_3pin_5v': '3-pin 5V ARGB', 'rgb_4pin_12v': '4-pin 12V RGB',
          'sata_power': 'SATA power', 'molex_4': 'Molex power',
          'usb2_9pin': 'USB 2.0 9-pin', 'none': 'none'}
ROLE_LABELS = {'cpu_fan': 'CPU_FAN', 'cpu_opt': 'CPU_OPT',
               'system_fan': 'SYS_FAN', 'pump': 'PUMP'}


def _header_ids(text):
    prefix = r'(?:cpu[_-]?fan|cpu[_-]?opt|sys[_-]?fan|cha[_-]?fan|aio[_-]?pump|pump[_-]?fan)'
    identifiers = set()
    for match in re.finditer(r'\b(' + prefix + r')(\d+)((?:/\d+)*)(?:_pump)?\b', text):
        numbers = [int(match[2])] + [int(value) for value in match[3].split('/') if value]
        identifiers.update(match[1].upper().replace('-', '_') + str(value) for value in numbers)
    for match in re.finditer(r'\b(' + prefix + r')(\d+)\s*(?:~|–|-|to)\s*(?:' + prefix + r')?(\d+)\b', text):
        start, end = int(match[2]), int(match[3])
        if not 0 < start <= end <= 32:
            raise ValueError('Некорректный диапазон физических разъёмов')
        identifiers.update(match[1].upper().replace('-', '_') + str(index) for index in range(start, end + 1))
    return sorted(identifiers)


def _lighting_ids(text):
    return sorted({name.upper() for name in re.findall(
        r'\b(?:d_led|led_c|cpu_led|jrgb|jargb(?:_v2_?)?|jrainbow|add_gen\d?_|addr_led|rgb_led)\d+\b', text)})


def normalize_cooling_inventory(code, value):
    board = code == 'motherboard_fan_headers'
    light_board = code == 'motherboard_lighting_headers'
    lighting = code in ('motherboard_lighting_headers', 'cooling_lighting_connectors')
    if board and type(value) is int and 0 <= value <= 32:
        return [{'kind': 'system_fan_header', 'count': value,
                 'raw': f'{value} SYS_FAN/CHA_FAN headers'}]
    parts = value if isinstance(value, list) else [value]
    if not parts:
        raise ValueError('Укажите разъёмы или явное отсутствие: none')
    result = {}
    for part in parts:
        if isinstance(part, str) and ';' in part and all(re.match(r'^\s*\d+\s*[x×]\s*', fragment)
                                                       for fragment in part.split(';')):
            fragments = normalize_cooling_inventory(code, part.split(';'))
        else:
            fragments = [part]
        for item in fragments:
            supplied = item if isinstance(item, dict) else {}
            if supplied and set(supplied) - {'kind', 'count', 'raw', 'roles', 'pins', 'control',
                                           'current_a', 'max_current_a', 'header_ids'}:
                raise ValueError('Неизвестное поле подключения')
            raw = supplied.get('raw') if supplied else item
            if not isinstance(raw, str) or not raw.strip():
                raise ValueError('Нужно исходное обозначение разъёма')
            text = re.sub(r'\s+', ' ', raw.strip()).casefold()
            first = re.match(r'^(\d+)\s*[x×]\s*', text)
            last = re.search(r'\s+[x×]\s*(\d+)$', text)
            if first and last:
                raise ValueError('Количество указано дважды')
            count = supplied.get('count', int(first[1] if first else last[1] if last else 1))
            if supplied and (first or last) and count != int(first[1] if first else last[1]):
                quantities = re.findall(r'(\d+)\s*[x×]\s*', text)
                if not board or len(quantities) < 2 or sum(map(int, quantities)) != count:
                    raise ValueError('Количество не соответствует обозначению')
            text = text[first.end():] if first else text[:last.start()] if last else text
            roles = sorted(role for role, pattern in (
                ('cpu_fan', r'cpu[_ -]*fan'), ('cpu_opt', r'cpu[_ -]*opt'),
                ('system_fan', r'(?:sys(?:tem)?|cha(?:ssis)?)[_ -]*fan'),
                ('pump', r'pump')) if re.search(pattern, text)) if board else []
            header_ids = _header_ids(text) if board else _lighting_ids(text) if light_board else []
            if supplied.get('header_ids', header_ids) != header_ids or len(header_ids) > count:
                raise ValueError('Количество или обозначения физических разъёмов не совпадают')
            pins_match = re.search(r'([349])\s*[- ]?pin', text)
            pins = int(pins_match[1]) if pins_match else None
            controls = sorted(mode for mode in ('dc', 'pwm') if re.search(r'\b' + mode + r'\b', text))
            kind = 'unresolved'
            if re.fullmatch(r'(?:0\s+)?(?:none|нет|no connectors|отсутствует)', text):
                kind, count = 'none', 0
            elif board and roles:
                kind = (roles[0] + '_header') if len(roles) == 1 else 'combo_fan_header'
            elif lighting or (code == 'case_fan_connector' and re.search(r'argb|\brgb\b|addressable', text)):
                if re.search(r'\bargb\b|addressable|a[- ]?rgb', text) and pins == 3 and re.search(r'\b5\s*v\b', text) and not re.search(r'\b12\s*v\b', text):
                    kind = 'argb_3pin_5v'
                elif re.search(r'\brgb\b', text) and not re.search(r'argb|addressable|a-rgb', text) and pins == 4 and re.search(r'\b12\s*v\b', text) and not re.search(r'\b5\s*v\b', text):
                    kind = 'rgb_4pin_12v'
            elif not re.search(r'argb|\brgb\b|addressable|/', text) and len(re.findall(r'[349]\s*[- ]?pin', text)) <= 1:
                if 'sata' in text:
                    kind = 'sata_power'
                elif 'molex' in text:
                    kind = 'molex_4'
                elif 'usb' in text and pins == 9:
                    kind = 'usb2_9pin'
                elif pins == 4 and 'pwm' in controls:
                    kind = 'fan_pwm_4pin'
                elif pins == 3 and 'dc' in controls:
                    kind = 'fan_dc_3pin'
                elif pins in (3, 4):
                    kind = f'fan_{pins}pin'
            if supplied.get('kind') == 'unresolved':
                kind = 'unresolved'
            elif supplied.get('kind', kind) != kind:
                raise ValueError('Тип не соответствует исходному обозначению')
            if type(count) is not int or not 0 <= count <= 32 or (kind != 'none' and count == 0 and not board):
                raise ValueError('Некорректное количество')
            if kind == 'none' and count != 0:
                raise ValueError('Отсутствие разъёмов требует count=0')
            if board and supplied.get('roles', roles) != roles:
                raise ValueError('Назначение не соответствует обозначению')
            if supplied.get('pins', pins) != pins or supplied.get('control', controls) != controls:
                raise ValueError('Пины или управление не подтверждены обозначением')
            entry = {'kind': kind, 'count': count}
            if board and roles:
                entry['roles'] = roles
            if header_ids:
                entry['header_ids'] = header_ids
            if board and pins is not None:
                entry['pins'] = pins
            if board and controls:
                entry['control'] = controls
            amp_key = 'max_current_a' if board else 'current_a'
            if ('current_a' if board else 'max_current_a') in supplied:
                raise ValueError('Ток устройства и предел разъёма хранятся раздельно')
            amp = supplied.get(amp_key)
            amp_match = re.search(r'\b(\d+(?:[.,]\d+)?)\s*a\b', text)
            if amp is None and amp_match and not lighting:
                amp = float(amp_match[1].replace(',', '.'))
            if amp is not None:
                if lighting or kind in ('argb_3pin_5v', 'rgb_4pin_12v', 'none') or isinstance(amp, bool) or not isinstance(amp, (float, int)) or not math.isfinite(amp) or not 0 < amp <= 100:
                    raise ValueError('Некорректный ток')
                entry[amp_key] = amp
            if board and roles:
                label = '/'.join(ROLE_LABELS[role] for role in roles)
                if pins:
                    label += f' {pins}-pin'
                if controls:
                    label += ' ' + ' '.join(mode.upper() for mode in controls)
                if header_ids:
                    label += ' [' + ', '.join(header_ids) + ']'
            else:
                label = LABELS.get(kind, raw.strip())
                if header_ids:
                    label += ' [' + ', '.join(header_ids) + ']'
            entry['raw'] = raw.strip() if kind == 'unresolved' else f'{count} x {label}'
            # Equivalent spelling and repeated listings never increase physical capacity.
            key = (kind, tuple(roles), pins if board else None,
                   tuple(controls) if board else (), tuple(header_ids), raw.casefold() if kind == 'unresolved' else '')
            previous = result.get(key)
            if previous is not None and previous != entry:
                raise ValueError('Противоречивые сведения об одном типе подключения')
            result[key] = entry
    if any(row['kind'] == 'none' for row in result.values()) and len(result) > 1:
        raise ValueError('Отсутствие разъёмов противоречит списку')
    # Distinct SYS_FAN and SYS_FAN/PUMP groups are legitimate. Explicit physical
    # identifiers, when published, must never appear in two groups.
    seen_ids = set()
    for row in result.values():
        identifiers = set(row.get('header_ids', []))
        if identifiers & seen_ids:
            raise ValueError('Один физический разъём указан в нескольких группах')
        seen_ids.update(identifiers)
    return sorted(result.values(), key=lambda row: (row['kind'], row['raw']))
