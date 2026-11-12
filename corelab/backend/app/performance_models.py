"""Read-only model coverage. The same evidence files are used by the Mini App.

Model identity is separate from product identity. No score is inferred from a name.
"""
import json
from pathlib import Path
import re


def files():
    root = Path('/performance')
    if not root.is_dir():
        root = Path(__file__).resolve().parents[3] / 'tools'
    return (json.loads((root / 'performance-models.json').read_text(encoding='utf-8')),
            json.loads((root / 'benchmark-observations.json').read_text(encoding='utf-8')))


def normalize(value):
    value = re.sub(r'\s+', ' ', str(value or '').replace('®', '').replace('™', '')).strip()
    value = re.sub(r'^(AMD|NVIDIA)\s+(?=Radeon|GeForce)', '', value, flags=re.I)
    return re.sub(r'\bi([3579])-\s*(?=\d)', r'i\1 ', value, flags=re.I).lower()


def identify(kind, name, manufacturer, attrs, registry):
    if kind == 'gpu':
        model = str(attrs.get('gpu_graphics_processor') or '').strip()
        memory = attrs.get('gpu_memory_gb')
        for row in registry['models']:
            if row['type'] == kind and row.get('memoryGB') == memory and any(
                    normalize(alias) == normalize(model) for alias in [row['name'], *row.get('aliases', [])]):
                model = row['name']
                break
        return model or None, memory
    registered = [row for row in registry['models'] if row['type'] == 'cpu' and any(
        re.search(r'(?:^|[^a-z0-9])'+re.escape(normalize(alias))+r'(?=$|[^a-z0-9-])', normalize(name), re.I)
        for alias in [row['name'], *row.get('aliases', [])])]
    if len(registered) == 1:
        row = registered[0]
        if manufacturer and normalize(manufacturer) != normalize(row.get('manufacturer') or row['name'].split(' ')[0]):
            return None, None
        return row['name'], None
    if registered:
        return None, None
    matches = re.findall(registry['cpuPattern'], name.replace('®', '').replace('™', ''), re.I)
    if len(matches) != 1:
        return None, None
    model = matches[0]
    if not re.match(r'^(AMD|Intel)\s', model, re.I):
        model = ('AMD ' if model.lower().startswith('ryzen') else 'Intel ') + model
    if manufacturer and normalize(manufacturer) != model.split(' ')[0].lower():
        return None, None
    return re.sub(r'\bi([3579])-\s*(?=\d)', r'i\1 ', model, flags=re.I), None


def assessment(kind, model, memory, attrs, scenario, registry, data):
    if not model:
        return 'identity_missing', []
    # Game measurements cannot establish Photoshop or rendering performance.
    if scenario != 'gaming':
        application, operation = {'photoshop': ('photoshop', 'interactive'),
            'blender_cpu': ('blender', 'cpu_render'), 'blender_gpu': ('blender', 'gpu_render'),
            'twinmotion': ('twinmotion', 'gpu_render')}.get(scenario, (None, None))
        evidence = []
        reference_only = False
        for cohort in sorted(registry.get('workloadObservations', []), key=lambda c: bool(c.get('referenceOnly'))):
            if (cohort.get('application'), cohort.get('operation'), cohort.get('component')) != (application, operation, kind):
                continue
            if not all(cohort.get(key) for key in ('id', 'version', 'url', 'date', 'metric', 'baseValue')) or cohort.get('direction') not in ('higher', 'lower'):
                continue
            if any(normalize(row.get('model')) == normalize(model) and
                   (kind != 'gpu' or row.get('memoryGB') == memory) and
                   isinstance(row.get('value'), (int, float)) and row['value'] > 0
                   for row in cohort.get('observations', [])):
                reference_only = bool(cohort.get('referenceOnly'))
                evidence.append(dict(scenario=f'{application} · {operation}', url=cohort['url'],
                    checked_at=cohort['date'], metric=f"{cohort['metric']} · {cohort['version']}",
                    scope=cohort.get('scope')))
            # One fixed cohort per scenario, as in the selection service.
            break
        return ('reference_only' if reference_only else 'measured' if evidence else 'not_evaluated'), evidence
    source = data['computerbase']
    evidence = []
    if kind == 'gpu':
        for resolution, cohort in source['resolutions'].items():
            for row in cohort['observations']:
                if normalize(row['gpu']) == normalize(model) and row['memoryGB'] == memory:
                    evidence.append(dict(scenario=f'Игры · {resolution}', url=source['url'],
                                         checked_at=source['checkedAt'], metric=source['metric']))
    else:
        cpu = source.get('cpu', {})
        if any(normalize(row['model']) == normalize(model) for row in cpu.get('observations', [])):
            evidence.append(dict(scenario='Игры · CPU', url=cpu['url'], checked_at=source['checkedAt'], metric=cpu['metric']))
        else:
            legacy = registry.get('cpuGamingLegacy', {})
            row = next((row for key, row in legacy.get('observations', {}).items() if normalize(key) == normalize(model)), None)
            if row and attrs.get('socket') == row['socket'] and attrs.get('cores') == row['cores']:
                evidence.append(dict(scenario='Игры · CPU', url=legacy['url'], checked_at=legacy['reviewedAt'], metric=legacy['metric']))
    return ('measured' if evidence else 'not_evaluated'), evidence


def group_models(products, scenario, registry, data):
    groups = {}
    for product in products:
        kind, attrs = product['type'], product['attributes']
        model, memory = identify(kind, product['name'], product.get('manufacturer'), attrs, registry)
        status, evidence = assessment(kind, model, memory, attrs, scenario, registry, data)
        # Missing identity remains a product-specific review item, never a match.
        key = (kind, normalize(model) if model else f"product:{product['id']}", memory, status)
        group = groups.setdefault(key, dict(type=kind, model=model, memory_gb=memory,
            status=status, evidence=evidence, products=[]))
        group['products'].append({k: product[k] for k in ('id', 'name', 'sku', 'selection_enabled', 'validity_check')})
    return sorted(groups.values(), key=lambda row: (row['status'] == 'measured', row['type'], normalize(row['model'])))
