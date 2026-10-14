"""Bounded pilot: search by manufacturer + article, verify exact property values."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://over-shop.kz'
CATEGORIES = [
    'Процессоры', 'Материнские платы', 'Оперативная память', 'Видеокарты',
    'Твердотельные диски (SSD)', 'Блоки питания', 'Корпуса',
    'Кулеры для процессоров', 'Охлаждение для корпусов ПК',
    'Системы водяного / жидкостного охлаждения (СЖО)', 'Мониторы',
    'Клавиатуры', 'Мыши', 'Наушники и гарнитуры', 'Ноутбуки',
    'Источники бесперебойного питания', 'Маршрутизаторы',
    'Акустические системы', 'USB Flash накопители', 'Внешние HDD/SSD',
]


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def has_class(self, name):
        return name in self.attrs.get('class', '').split()

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        if self.tag in ('script', 'style'):
            return ''
        return ''.join(child.text() if isinstance(child, Node) else child for child in self.children)


class Document(HTMLParser):
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def properties(html):
    """Read only property-table rows, never product titles or internal header SKU."""
    tree = Document(html).root
    result = {}
    for row in tree.walk():
        if row.tag != 'tr' or not row.has_class('js-prop-replace'):
            continue
        names = [n.text().strip() for n in row.walk() if n.has_class('js-prop-title')]
        values = [n.text().strip() for n in row.walk() if n.has_class('js-prop-value')]
        if len(names) == 1 and len(values) == 1:
            result.setdefault(names[0], []).append(values[0])
    if result:
        return result
    # Some cards expose only the compact characteristics block.
    for row in tree.walk():
        if not row.has_class('properties__item') or not row.has_class('js-prop-replace'):
            continue
        names = [n.text().strip() for n in row.walk() if n.has_class('js-prop-title')]
        values = [n.text().strip() for n in row.walk() if n.has_class('js-prop-value')]
        if len(names) == 1 and len(values) == 1:
            result.setdefault(names[0], []).append(values[0])
    return result


def identity_check(item, props):
    missing, different = [], []
    for field, label in [('article', 'Артикул'), ('manufacturer', 'Производитель')]:
        values = props.get(label, [])
        if not values or any(not value for value in values):
            missing.append(label)
        if any(value and value != item[field] for value in values):
            different.append(label)
    if different:
        return 'mismatch', different
    if missing:
        return 'missing_identity', missing
    return 'exact', []


def exact_pair(item, props):
    # Strip only surrounding HTML layout whitespace in extraction; do not modify
    # source identifiers, case, internal whitespace, punctuation or Unicode form.
    for source, label in [('article', 'Артикул'), ('manufacturer', 'Производитель')]:
        expected = item.get(source)
        observed = props.get(label, [])
        if not isinstance(expected, str) or not expected or not observed:
            return False
        if any(value != expected for value in observed):
            return False
    return True


def search_candidates(html):
    urls = set()
    paginated = False
    for node in Document(html).root.walk():
        if node.tag != 'a' or not node.attrs.get('href'):
            continue
        href = urljoin(BASE, node.attrs['href'])
        parts = urlsplit(href)
        if parts.hostname != 'over-shop.kz' or parts.scheme != 'https':
            continue
        if 'PAGEN_' in parts.query:
            paginated = True
        if re.fullmatch(r'/catalog/(?:[^/]+/)+\d+/', parts.path):
            urls.add(BASE + parts.path)
    return sorted(urls), paginated


def pagination_links(html, current_url, query):
    """Follow only numeric pager links retaining the exact manufacturer/article query."""
    pages = set()
    for node in Document(html).root.walk():
        if node.tag != 'a' or not node.attrs.get('href'):
            continue
        parts = urlsplit(urljoin(current_url, node.attrs['href']))
        params = parse_qs(parts.query, keep_blank_values=True)
        pager = [(key, values) for key, values in params.items() if key.startswith('PAGEN_')]
        if parts.scheme != 'https' or parts.hostname != 'over-shop.kz' or parts.path != '/catalog/' or not pager:
            continue
        if params.get('q', [query]) != [query] or params.get('type', ['catalog']) != ['catalog']:
            continue
        if len(pager) != 1:
            raise ValueError('Ambiguous pagination parameters')
        key, values = pager[0]
        if not re.fullmatch(r'PAGEN_\d+', key) or len(values) != 1 or not re.fullmatch(r'[1-9]\d*', values[0]):
            raise ValueError('Invalid pagination parameter')
        clean = {'q': query, 'type': 'catalog'}
        if values[0] != '1':
            clean[key] = str(int(values[0]))
        pages.add(BASE + '/catalog/?' + urlencode(clean))
    return sorted(pages)


def discover_candidates(search_url, query, fetcher, max_pages, max_candidates):
    pending = [search_url]
    visited, urls = set(), set()
    searches, warnings = [], []
    fingerprints = set()
    while pending:
        url = pending.pop(0)
        if url in visited:
            continue
        if len(visited) >= max_pages:
            warnings.append('search_page_limit')
            break
        visited.add(url)
        html, final_url, evidence = fetcher.get(url)
        actual_query = parse_qs(urlsplit(final_url).query).get('q')
        if actual_query != [query]:
            raise ValueError('Search redirect changed or removed query')
        candidates, _ = search_candidates(html)
        next_pages = pagination_links(html, url, query)
        fingerprint = tuple(candidates)
        if candidates and fingerprint in fingerprints:
            warnings.append('repeated_search_page')
        fingerprints.add(fingerprint)
        searches.append({'url': url, 'finalUrl': final_url, 'evidence': evidence,
                         'candidateCount': len(candidates)})
        urls.update(candidates)
        if len(urls) > max_candidates:
            warnings.append('candidate_limit')
            break
        pending.extend(link for link in next_pages if link not in visited and link not in pending)
    return sorted(urls)[:max_candidates], searches, warnings


def select_sample(catalog):
    sample = []
    for category in CATEGORIES:
        candidates = [x for x in catalog['items'] if x.get('category') == category
                      and not x.get('isArchived') and x.get('article') and x.get('manufacturer')]
        if not candidates:
            raise ValueError('No eligible product in category: ' + category)
        # Retain the previously verified APC as a control case.
        chosen = next((x for x in candidates if x['skuOver'] == '88947637'), candidates[0])
        sample.append({key: chosen[key] for key in ('skuOver', 'article', 'manufacturer', 'category', 'name')})
    return sample


class Fetcher:
    def __init__(self, directory):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.cache = {}

    def get(self, url):
        if url in self.cache:
            return self.cache[url]
        time.sleep(0.3)
        request = Request(url, headers={'User-Agent': 'OVER-catalog-pilot/0.1', 'Accept': 'text/html'})
        with urlopen(request, timeout=40) as response:
            final_url = response.geturl()
            if urlsplit(final_url).hostname != 'over-shop.kz':
                raise ValueError('Unexpected response host')
            if response.headers.get_content_type() != 'text/html':
                raise ValueError('Expected HTML')
            html = response.read().decode('utf-8', errors='strict')
        filename = hashlib.sha256(url.encode()).hexdigest() + '.html'
        (self.directory / filename).write_text(html, encoding='utf-8')
        result = (html, final_url, str((self.directory / filename).relative_to(ROOT)))
        self.cache[url] = result
        return result


def match_one(item, fetcher, max_pages=10, max_candidates=250):
    if any(not isinstance(item.get(key), str) or not item[key] for key in ('article', 'manufacturer')):
        raise ValueError('Both article and manufacturer are mandatory')
    query = item['manufacturer'] + ' ' + item['article']
    search_url = BASE + '/catalog/?' + urlencode({'q': query, 'type': 'catalog'})
    result = {**item, 'query': query, 'searchUrl': search_url,
              'checkedAtUtc': datetime.now(timezone.utc).isoformat(),
              'status': 'error', 'url': None, 'candidates': []}
    try:
        urls, searches, warnings = discover_candidates(search_url, query, fetcher, max_pages, max_candidates)
        result['searchEvidence'] = searches[0]['evidence']
        result['searchPages'] = searches
        result['searchPagesFetched'] = len(searches)
        result['searchHasPagination'] = len(searches) > 1 or 'search_page_limit' in warnings
        result['warnings'] = warnings
        result['candidateCount'] = len(urls)
        incomplete = bool(warnings)
        seen_ids = set()
        for index, url in enumerate(urls, 1):
            candidate = {'url': url}
            try:
                card, final_url, evidence = fetcher.get(url)
                props = properties(card)
                candidate.update(url=final_url, evidence=evidence, properties=props,
                                 exactMatch=exact_pair(item, props))
                check, fields = identity_check(item, props)
                candidate.update(identityStatus=check, identityFields=fields)
                if check == 'missing_identity':
                    candidate['error'] = 'Required characteristic missing: ' + ', '.join(fields)
                    incomplete = True
                product_id = re.search(r'/(\d+)/?$', urlsplit(final_url).path)
                identity = product_id.group(1) if product_id else final_url
                candidate['sameCardAlreadySeen'] = identity in seen_ids
                seen_ids.add(identity)
            except Exception as exc:
                candidate['error'] = type(exc).__name__ + ': ' + str(exc)
                incomplete = True
            result['candidates'].append(candidate)
            if len(urls) > 10 and index % 20 == 0:
                print(f"  {item.get('skuOver', '?')}: checked {index}/{len(urls)} candidates", flush=True)
        matches = [c for c in result['candidates'] if c.get('exactMatch') and not c.get('sameCardAlreadySeen')]
        if len(matches) > 1:
            result['status'] = 'ambiguous'
        elif incomplete:
            result['status'] = 'needs_review'
        elif len(matches) == 1:
            result['status'], result['url'] = 'matched', matches[0]['url']
        else:
            result['status'] = 'not_found' if not urls else 'mismatch'
        result['searchTraversalComplete'] = not warnings
        result['verificationComplete'] = not incomplete
    except Exception as exc:
        result['error'] = type(exc).__name__ + ': ' + str(exc)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--select-only', action='store_true')
    parser.add_argument('--sku', action='append', help='Recheck selected pilot SKU; repeatable')
    args = parser.parse_args()
    catalog = json.loads((ROOT / 'data/p1-catalog.json').read_text(encoding='utf-8-sig'))
    sample = select_sample(catalog)
    if args.sku:
        known = {item['skuOver'] for item in sample}
        if not set(args.sku) <= known:
            parser.error('Requested SKU is not in the pilot sample')
        sample = [item for item in sample if item['skuOver'] in args.sku]
    sample_path = ROOT / 'data/shop-sample.json'
    if not args.sku:
        sample_path.write_text(json.dumps(sample, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.select_only:
        print(json.dumps(sample, ensure_ascii=False, indent=2))
        return
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    fetcher = Fetcher(ROOT / 'data/shop-evidence' / stamp)
    results = []
    output = ROOT / ('data/shop-matches-followup.json' if args.sku else 'data/shop-matches-pilot.json')
    for index, item in enumerate(sample, 1):
        result = match_one(item, fetcher)
        results.append(result)
        report = {'catalogDownloadedAtUtc': catalog['downloadedAtUtc'],
                  'scope': f'{len(sample)}-item pilot; search results are not proof of store-wide uniqueness',
                  'complete': len(results) == len(sample), 'items': results,
                  'counts': dict(Counter(x['status'] for x in results))}
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(output)
        print(f"{index}/{len(sample)} {item['skuOver']}: {result['status']}", flush=True)
    print(json.dumps(report['counts']), flush=True)


if __name__ == '__main__':
    main()
