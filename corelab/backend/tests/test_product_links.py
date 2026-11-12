import pytest
from app.product_links import parse_feed, lookup, public_url

def test_exact_skus_and_duplicate_guard():
    links = parse_feed(b'<products><product><sku>001</sku><url>https://shop.kz/p/1</url></product></products>')
    assert lookup({'items': links}, '001') == 'https://shop.kz/p/1'
    assert lookup({'items': links}, '1') is None
    with pytest.raises(ValueError):
        parse_feed(b'<products><product><sku>a</sku><url>https://shop.kz/1</url></product><product><sku>a</sku><url>https://shop.kz/2</url></product></products>')

@pytest.mark.parametrize('url', ['javascript:alert(1)', 'https://user:pass@example.com/a', 'http://example.com/a', 'https://example.com:8000/a'])
def test_invalid_links(url):
    with pytest.raises(ValueError): public_url(url)

def test_entities_and_empty_feed_rejected():
    for xml in [b'<!DOCTYPE products><products/>', b'<products/>', b'<other/>']:
        with pytest.raises(ValueError): parse_feed(xml)
