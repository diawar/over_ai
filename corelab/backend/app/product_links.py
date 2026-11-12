"""Bounded public XML feed retrieval and exact SKU lookup. No product creation."""
import http.client
import ipaddress
import socket
import ssl
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

MAX_BYTES = 20 * 1024 * 1024

def public_url(value):
    value = value.strip()
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.fragment or parsed.port not in (None, 443)
            or any(c.isspace() for c in value)):
        raise ValueError('Укажите публичный HTTPS-адрес без пароля и нестандартного порта')
    return value

def parse_feed(content):
    if len(content) > MAX_BYTES or b'<!DOCTYPE' in content.upper() or b'<!ENTITY' in content.upper():
        raise ValueError('Недопустимый XML или размер файла больше 20 МБ')
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        raise ValueError('Не удалось прочитать XML') from exc
    if root.tag != 'products':
        raise ValueError('Ожидается XML products / product / sku, url')
    links = {}
    for row in root.findall('product'):
        sku = (row.findtext('sku') or '').strip()
        url = public_url(row.findtext('url') or '')
        if not sku or len(sku) > 200 or len(url) > 2000:
            raise ValueError('В XML есть пустой или слишком длинный SKU/URL')
        if sku in links and links[sku] != url:
            raise ValueError(f'Для SKU {sku} указаны разные ссылки')
        links[sku] = url
        if len(links) > 100000:
            raise ValueError('В файле больше 100 000 товаров')
    if not links:
        raise ValueError('В XML нет ссылок на товары')
    return links

def download_feed(url):
    parsed = urlsplit(public_url(url))
    addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('Адрес должен вести на публичный сайт')
    # Pin the checked address; TLS still verifies the original hostname.
    connection = http.client.HTTPSConnection(parsed.hostname, timeout=20)
    raw = socket.create_connection((addresses[0][4][0], 443), timeout=20)
    try:
        connection.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname)
        connection.request('GET', parsed.path + ('?' + parsed.query if parsed.query else '') or '/',
                           headers={'Accept': 'application/xml', 'User-Agent': 'CoreLab SKU links'})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError(f'Сайт вернул HTTP {response.status}. Укажите конечный адрес XML')
        return parse_feed(response.read(MAX_BYTES + 1))
    finally:
        connection.close()
        raw.close()

def lookup(settings, sku):
    return (settings or {}).get('items', {}).get(str(sku))
