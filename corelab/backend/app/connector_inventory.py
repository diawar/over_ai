"""Canonical connector inventories stored as JSON arrays in existing properties.

Keep the manufacturer's wording in ``raw``. Unknown descriptions are left in their
original form by callers; a guessed connector must never make a product eligible.
"""
import re
from .cooling_inventory import COOLING_CODES, normalize_cooling_inventory


CONNECTOR_CODES = frozenset({
    'gpu_power_connectors', 'psu_pcie_connectors', 'psu_cpu_connectors',
    'motherboard_cpu_power_connectors', 'motherboard_fan_headers', 'case_fan_connector',
    'case_front_usb_headers', 'motherboard_internal_usb_headers',
}) | COOLING_CODES


def _usb_kind(raw):
    text = raw.casefold()
    if re.match(r'^(?:no|none|нет|без)\b', text) and 'usb' in text:
        return 'none'
    if not re.search(r'usb|type\s*[- ]?c', text):
        return None
    if re.search(r'type\s*[- ]?c|usb\s*[- ]?c|type\s*[- ]?e', text):
        return 'usb_c_type_e'
    if re.search(r'usb\s*2(?:\.0)?\b', text):
        return 'usb2_9pin'
    if re.search(r'usb\s*3(?:\.[012])?|usb\s*3\.2\s*gen\s*[12]|usb\s*3\.1\s*gen\s*[12]|usb\s*5\s*gbps', text):
        return 'usb3_19pin'
    return None


def _normalize_usb_inventory(code, value):
    parts = value if isinstance(value, list) else [value]
    if not parts:
        raise ValueError('Expected USB connector inventory')
    result = {}
    for part in parts:
        if isinstance(part, str):
            raw = part.strip()
            if not raw:
                raise ValueError('Empty USB connector description')
            ports, label = _quantity(raw)
            kind = _usb_kind(label) or 'unresolved'
            if kind == 'none':
                count, ports = 0, None
            elif code == 'case_front_usb_headers':
                count = ports if kind == 'usb_c_type_e' else (ports + 1) // 2
            else:
                count = ports
                ports = None
        elif isinstance(part, dict):
            raw, kind, count = part.get('raw'), part.get('kind'), part.get('count')
            ports = part.get('ports') if code == 'case_front_usb_headers' else None
            if not isinstance(raw, str) or not raw.strip() or kind not in (
                    'usb2_9pin', 'usb3_19pin', 'usb_c_type_e', 'unresolved', 'none'):
                raise ValueError('Invalid USB connector description')
            if kind != 'unresolved' and _usb_kind(raw) != kind:
                raise ValueError('USB connector kind disagrees with manufacturer text')
            if type(count) is not int or not 0 <= count <= 32:
                raise ValueError('Invalid USB header count')
            if kind == 'none' and (count != 0 or ports is not None):
                raise ValueError('No USB headers cannot have a positive count')
            if ports is not None and (type(ports) is not int or not 1 <= ports <= 32 or
                                      count != (ports if kind == 'usb_c_type_e' else (ports + 1) // 2)):
                raise ValueError('USB port/header count mismatch')
        else:
            raise ValueError('Expected USB connector list')
        entry = {'kind': kind, 'count': count, 'raw': raw}
        if ports is not None:
            entry['ports'] = ports
        previous = result.get(kind)
        if previous is not None:
            raise ValueError('Duplicate USB connector type')
        result[kind] = entry
    if 'none' in result and len(result) > 1:
        raise ValueError('No USB headers contradicts listed USB headers')
    return list(result.values())


def _quantity(label):
    text = label.strip()
    first = re.match(r'^(\d+)\s*(?:x|×)\s*', text, re.I)
    last = re.search(r'\s+(?:x|×)\s*(\d+)\s*$', text, re.I)
    if first and last:
        raise ValueError('Количество разъёмов указано дважды')
    count = int(first.group(1) if first else last.group(1) if last else 1)
    if count < 1 or count > 32:
        raise ValueError('Некорректное количество разъёмов')
    return count, text[first.end():] if first else text[:last.start()] if last else text


def _kind(code, label):
    text = re.sub(r'\s+', ' ', label.casefold()).strip()
    if code in ('gpu_power_connectors', 'psu_pcie_connectors'):
        if text in ('нет', 'none', 'no'):
            return 'none'
        if re.search(r'12v\s*[- ]?2\s*[x×]\s*6|12vhpwr|12\s*\+\s*4|16\s*[- ]?pin', text):
            return 'pcie_16'
        if re.search(r'6\s*\+\s*2|8\s*[- ]?pin', text) and not re.search(r'cpu|eps|atx12v', text):
            return 'pcie_8'
        if re.search(r'6\s*[- ]?pin', text) and not re.search(r'cpu|eps|atx12v', text):
            return 'pcie_6'
    elif code in ('psu_cpu_connectors', 'motherboard_cpu_power_connectors'):
        if re.search(r'4\s*\+\s*4', text):
            return 'cpu_4plus4' if code == 'psu_cpu_connectors' else None
        if re.search(r'8\s*[- ]?pin|\beps\s*8\b', text):
            return 'cpu_8'
        if re.search(r'\bp4\b', text) and 'cpu' in text:
            return 'cpu_4'
        if re.search(r'4\s*[- ]?pin|\batx12v\s*4\b', text):
            return 'cpu_4'
    elif code == 'case_fan_connector':
        if re.search(r'(?:9\s*[- ]?pin.{0,12}usb(?:\s*2\.0)?|usb\s*2(?:\.0)?\b.{0,24}9\s*[- ]?pin)', text):
            return 'usb2_9pin'
        if 'sata' in text:
            return 'sata_power'
        if 'molex' in text:
            return 'molex_4'
        if 'argb' in text and re.search(r'3\s*[- ]?pin', text):
            return 'argb_3pin_5v'
        if re.search(r'\brgb\b', text) and re.search(r'4\s*[- ]?pin', text):
            return 'rgb_4pin_12v' if 'nzxt' not in text else 'proprietary_nzxt_rgb'
        if re.search(r'4\s*[- ]?pin', text) and ('pwm' in text or text == '4-pin'):
            return 'fan_pwm_4pin'
        if re.search(r'3\s*[- ]?pin', text):
            return 'fan_dc_3pin'
    elif code == 'motherboard_fan_headers':
        if not re.search(r'cpu[_\s-]*fan|pump|aio', text) and re.search(
                r'sys(?:tem)?[_\s-]*fan|cha(?:ssis)?[_\s-]*fan', text):
            return 'system_fan_header'
    return None


def normalize_connector_inventory(code, value):
    """Return unique typed entries; reject ambiguity instead of inventing counts."""
    if code not in CONNECTOR_CODES:
        return value
    if code in COOLING_CODES:
        return normalize_cooling_inventory(code, value)
    if code in ('case_front_usb_headers', 'motherboard_internal_usb_headers'):
        return _normalize_usb_inventory(code, value)
    if code == 'motherboard_fan_headers' and type(value) is int and 0 <= value <= 32:
        return [{'kind': 'system_fan_header', 'count': value,
                 'raw': f'{value} SYS_FAN/CHA_FAN headers'}]
    parts = value if isinstance(value, list) else [value]
    if not parts or not all(isinstance(part, (str, dict)) for part in parts):
        raise ValueError('Ожидается перечень разъёмов')
    result = {}
    for part in parts:
        if isinstance(part, dict):
            kind, count, raw = part.get('kind'), part.get('count'), part.get('raw')
            if not isinstance(raw, str) or not raw.strip() or (kind != 'unresolved' and _kind(code, raw) != kind):
                raise ValueError('Тип разъёма не подтверждён исходным обозначением')
            if type(count) is not int or not 0 <= count <= 32 or (
                    count == 0 and kind not in ('none', 'system_fan_header')) or (
                    kind == 'none' and count != 0):
                raise ValueError('Некорректное количество разъёмов')
            cables = part.get('cables')
            if cables is not None and (code != 'psu_pcie_connectors' or type(cables) is not int or
                                       not 1 <= cables <= count):
                raise ValueError('Некорректное количество кабелей')
        else:
            raw = part.strip()
            if not raw:
                raise ValueError('Пустое обозначение разъёма')
            # Semicolon means separate physical connections; slash can mean an
            # alternative cable and must be reviewed from the source.
            if ';' in raw:
                for fragment in raw.split(';'):
                    for entry in normalize_connector_inventory(code, fragment):
                        previous = result.get(entry['kind'])
                        if previous and previous['count'] != entry['count']:
                            raise ValueError('Разные количества одного типа разъёма')
                        result[entry['kind']] = previous or entry
                continue
            if '/' in raw and code == 'case_fan_connector':
                result['unresolved'] = {'kind': 'unresolved', 'count': 1, 'raw': raw}
                continue
            cable_match = re.search(r'\(\s*(\d+)\s*(?:cables?|кабел\w*)\s*\)', raw, re.I)
            cables = int(cable_match.group(1)) if cable_match else None
            label_text = raw[:cable_match.start()] + raw[cable_match.end():] if cable_match else raw
            count, label = _quantity(label_text.strip())
            kind = _kind(code, label)
            if kind is None:
                kind = 'unresolved'
            if kind == 'none':
                count = 0
            if cables is not None and (code != 'psu_pcie_connectors' or cables < 1 or cables > count):
                raise ValueError('Некорректное количество кабелей')
        entry = {'kind': kind, 'count': count, 'raw': raw}
        if code == 'psu_pcie_connectors':
            entry['cables'] = cables
        previous = result.get(kind)
        if previous is not None:
            if previous['count'] != count or previous.get('cables') != entry.get('cables'):
                raise ValueError('Разные количества одного типа разъёма')
            continue
        result[kind] = entry
    if 'none' in result and len(result) > 1:
        raise ValueError('Отсутствие разъёмов противоречит перечисленным разъёмам')
    return list(result.values())
