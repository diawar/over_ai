import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('shop_match', Path(__file__).resolve().parents[1] / 'tools/shop_match.py')
shop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shop)


def table(article='SRT3000XLI', brand='APC'):
    return f'''<h1>Wrong title</h1><div>Артикул: 000009884</div><table>
    <tr class="js-prop-replace"><td><span class="js-prop-title">Артикул</span></td>
    <td><span class="js-prop-value">{article}</span></td></tr>
    <tr class="js-prop-replace"><td><span class="js-prop-title">Производитель</span></td>
    <td><span class="js-prop-value">\n <a>{brand}</a>\n </span></td></tr></table>'''


class MatchingTests(unittest.TestCase):
    def setUp(self):
        self.item = {'article': 'SRT3000XLI', 'manufacturer': 'APC'}

    def test_exact_characteristics_not_header(self):
        props = shop.properties(table())
        self.assertEqual(props['Артикул'], ['SRT3000XLI'])
        self.assertTrue(shop.exact_pair(self.item, props))

    def test_brand_is_mandatory(self):
        self.assertFalse(shop.exact_pair(self.item, shop.properties(table(brand='Other'))))
        self.assertFalse(shop.exact_pair(self.item, {'Артикул': ['SRT3000XLI']}))

    def test_no_normalization(self):
        for article in ('srt3000xli', 'SRT-3000XLI', 'SRT3000XLI2', 'SRT 3000XLI'):
            self.assertFalse(shop.exact_pair(self.item, shop.properties(table(article=article))))
        self.assertFalse(shop.exact_pair(self.item, shop.properties(table(brand='apc'))))

    def test_conflicting_properties_rejected(self):
        props = shop.properties(table() + table(brand='Other'))
        self.assertFalse(shop.exact_pair(self.item, props))

    def test_entities_decoded_not_identifiers_normalized(self):
        self.assertTrue(shop.exact_pair({'article': 'A&B', 'manufacturer': 'APC'}, shop.properties(table(article='A&amp;B'))))

    def test_search_links_and_pagination(self):
        urls, paginated = shop.search_candidates('<a href="/catalog/ups/68986/">x</a><a href="/catalog/ups/">category</a><a href="https://example.com/catalog/ups/1/">bad</a><a href="?PAGEN_1=2">next</a>')
        self.assertEqual(urls, ['https://over-shop.kz/catalog/ups/68986/'])
        self.assertTrue(paginated)

    def test_multiple_exact_cards_are_ambiguous(self):
        class Fake:
            def get(self, url):
                html = '<a href="/catalog/ups/1/">one</a><a href="/catalog/ups/2/">two</a>' if '?' in url else table()
                return html, url, 'test-evidence'
        result = shop.match_one(self.item, Fake())
        self.assertEqual(result['status'], 'ambiguous')
        self.assertIsNone(result['url'])

    def test_repeated_search_page_does_not_confirm_single_match(self):
        class Fake:
            def get(self, url):
                html = '<a href="/catalog/ups/1/">one</a><a href="?PAGEN_1=2">next</a>' if '?' in url else table()
                return html, url, 'test-evidence'
        self.assertEqual(shop.match_one(self.item, Fake())['status'], 'needs_review')

    def test_missing_table_does_not_confirm(self):
        class Fake:
            def get(self, url):
                html = '<a href="/catalog/ups/1/">one</a>' if '?' in url else '<h1>APC SRT3000XLI</h1>'
                return html, url, 'test-evidence'
        self.assertEqual(shop.match_one(self.item, Fake())['status'], 'needs_review')

    def test_second_page_exact_match_and_query_retained(self):
        class Fake:
            def __init__(self):
                self.requests = []

            def get(self, url):
                self.requests.append(url)
                if '?' in url:
                    self_query = shop.parse_qs(shop.urlsplit(url).query)
                    assert self_query['q'] == ['APC SRT3000XLI']
                    if self_query.get('PAGEN_7') == ['2']:
                        html = '<a href="/catalog/ups/2/">two</a><a href="?PAGEN_7=1">back</a>'
                    else:
                        html = '<a href="/catalog/ups/1/">one</a><a href="?PAGEN_7=2">next</a>'
                else:
                    html = table(article='DIFFERENT') if '/1/' in url else table()
                return html, url, 'test-evidence'
        fake = Fake()
        result = shop.match_one(self.item, fake)
        self.assertEqual(result['status'], 'matched')
        self.assertEqual(result['url'], 'https://over-shop.kz/catalog/ups/2/')
        self.assertEqual(result['searchPagesFetched'], 2)
        self.assertEqual(len(fake.requests), 4)

    def test_page_limit_keeps_exact_match_unconfirmed(self):
        class Fake:
            def get(self, url):
                html = '<a href="/catalog/ups/1/">one</a><a href="?PAGEN_7=2">next</a>' if '?' in url else table()
                return html, url, 'test-evidence'
        result = shop.match_one(self.item, Fake(), max_pages=1)
        self.assertEqual(result['status'], 'needs_review')
        self.assertIsNone(result['url'])
        self.assertIn('search_page_limit', result['warnings'])

    def test_pagination_rejects_other_query_and_host(self):
        html = '<a href="/catalog/?q=OTHER&PAGEN_1=2">bad</a><a href="https://example.com/catalog/?PAGEN_1=2">bad</a><a href="?PAGEN_8=2">good</a>'
        links = shop.pagination_links(html, shop.BASE + '/catalog/?q=APC+SRT3000XLI&type=catalog', 'APC SRT3000XLI')
        self.assertEqual(len(links), 1)
        self.assertEqual(shop.parse_qs(shop.urlsplit(links[0]).query)['q'], ['APC SRT3000XLI'])

    def test_missing_one_identity_field_is_explicit(self):
        self.assertEqual(shop.identity_check(self.item, {'Артикул': ['SRT3000XLI']}), ('missing_identity', ['Производитель']))
        self.assertEqual(shop.identity_check(self.item, {'Артикул': ['OTHER']}), ('mismatch', ['Артикул']))

    def test_compact_characteristics_fallback(self):
        html = '<div class="properties__item js-prop-replace"><div class="js-prop-title">Артикул</div><div class="js-prop-value">SRT3000XLI</div></div>'
        self.assertEqual(shop.properties(html), {'Артикул': ['SRT3000XLI']})

    def test_candidate_limit_blocks_confirmation(self):
        class Fake:
            def get(self, url):
                html = '<a href="/catalog/ups/1/">one</a><a href="/catalog/ups/2/">two</a>' if '?' in url else table()
                return html, url, 'test-evidence'
        result = shop.match_one(self.item, Fake(), max_candidates=1)
        self.assertEqual(result['status'], 'needs_review')
        self.assertIn('candidate_limit', result['warnings'])
        self.assertIsNone(result['url'])

    def test_unknown_candidate_blocks_unique_match(self):
        class Fake:
            def get(self, url):
                if '?' in url:
                    html = '<a href="/catalog/ups/1/">one</a><a href="/catalog/ups/2/">two</a>'
                else:
                    html = table() if '/1/' in url else '<h1>Identity unavailable</h1>'
                return html, url, 'test-evidence'
        result = shop.match_one(self.item, Fake())
        self.assertEqual(result['status'], 'needs_review')
        self.assertIsNone(result['url'])


if __name__ == '__main__':
    unittest.main()
