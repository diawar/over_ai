from io import BytesIO
import json
from zipfile import ZipFile, ZIP_DEFLATED

import pytest
from sqlalchemy import select
import xlrd
import xlwt

from test_catalog_views import catalog_client, seed
from app.models import Attribute, AuditLog, Product, ProductAttribute, PropertyRule
from app.property_spreadsheet import HEADERS, VALUE, SOURCE, META, parse_value

URL = '/api/v1/admin/catalog/property-file'


def setup_sheet(db, kind='integer', code='test_capacity', **definition):
    _, category, product = seed(db)
    attr = Attribute(code=code, label='Тестовое свойство', value_type=kind)
    db.add(attr); db.flush()
    db.add(PropertyRule(scope=str(category.id), category_id=category.id, attribute_id=attr.id,
        code=code, source='internal', active=True, revision=1,
        definition=dict(code=code, label=attr.label, level='required', value_type=kind,
            required_for_selection=True, **definition)))
    db.commit(); db.info['organization_id'] = 1
    return product, attr


def fill(data, value, source='https://www.asrock.com/specifications', mutate=None):
    source_book = xlrd.open_workbook(file_contents=data)
    target = xlwt.Workbook()
    for src in source_book.sheets():
        dest = target.add_sheet(src.name)
        for r in range(src.nrows):
            cells = src.row_values(r)
            if src.name.startswith('Характеристики ') and r:
                cells[VALUE], cells[SOURCE] = value, source
                if mutate:
                    mutate(cells)
            for c, cell in enumerate(cells):
                dest.write(r, c, cell)
    output = BytesIO(); target.save(output)
    return output.getvalue()


def post(client, data, token=None):
    client.cookies.set('corelab_csrf', 'sheet-test')
    headers = {'X-CSRF-Token': 'sheet-test', 'Content-Type': 'application/vnd.ms-excel'}
    if token:
        headers['X-Import-Preview'] = token
    return client.post(URL + '/import?apply=' + ('true' if token else 'false'), content=data, headers=headers)


def zip_files(files):
    output = BytesIO()
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        for name, data in files:
            archive.writestr(name, data)
    return output.getvalue()


def test_xls_roundtrip_normalization_and_repeat(catalog_client):
    client, db = catalog_client
    product, attr = setup_sheet(db, kind='string', code='test_socket', normalization={'aliases': {'AM-5': 'AM5'}})
    download = client.get(URL + '/export?q=Alpha')
    assert download.status_code == 200 and download.content[:8] == bytes.fromhex('D0CF11E0A1B11AE1')
    book = xlrd.open_workbook(file_contents=download.content)
    assert book.sheet_by_index(1).nrows == 2
    assert book.sheet_by_index(1).row_values(0) == HEADERS
    data = fill(download.content, 'AM-5')
    preview = post(client, data).json()
    assert preview['can_apply'] and preview['items'][0]['value'] == 'AM5'
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
        ProductAttribute.attribute_id == attr.id)) is None
    applied = post(client, data, preview['preview_token'])
    assert applied.status_code == 200 and applied.json()['applied'] == 1
    db.expire_all()
    row = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
        ProductAttribute.attribute_id == attr.id))
    assert row.value_string == 'AM5' and row.source_kind == 'manufacturer_site'
    assert post(client, data).json()['properties'] == 0


def test_invalid_value_and_missing_source_do_not_write(catalog_client):
    client, db = catalog_client
    product, attr = setup_sheet(db, minimum=1)
    exported = client.get(URL + '/export?q=Alpha').content
    for value, source in [('1.5', 'https://example.com'), ('0', 'https://example.com'), ('16', '')]:
        result = post(client, fill(exported, value, source)).json()
        assert result['error_count'] == 1 and not result['can_apply']
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
        ProductAttribute.attribute_id == attr.id)) is None


def test_stale_value_and_identity_tampering_are_rejected(catalog_client):
    client, db = catalog_client
    product, attr = setup_sheet(db)
    exported = client.get(URL + '/export?q=Alpha').content
    tampered = fill(exported, '16', mutate=lambda cells: cells.__setitem__(1, 'other-sku'))
    assert post(client, tampered).json()['error_count'] == 1
    db.add(ProductAttribute(product_id=product.id, attribute_id=attr.id, value_number=32))
    db.commit()
    result = post(client, fill(exported, '16')).json()
    assert result['error_count'] == 1 and not result['can_apply']


def test_cross_tenant_and_signature_tampering_are_rejected(catalog_client):
    client, db = catalog_client
    setup_sheet(db)
    exported = client.get(URL + '/export?q=Alpha').content
    data = fill(exported, '16')
    forged = fill(exported, '16', mutate=lambda cells: cells.__setitem__(META, cells[META].replace('Alpha', 'Beta')))
    assert post(client, forged).json()['error_count'] == 1
    db.info['organization_id'] = 2
    result = post(client, data).json()
    assert result['error_count'] == 1 and 'организации' in result['errors'][0]['message']


def test_apply_requires_preview_and_csrf(catalog_client):
    client, db = catalog_client
    setup_sheet(db)
    data = fill(client.get(URL + '/export?q=Alpha').content, '16')
    assert client.post(URL + '/import', content=data).status_code == 403
    response = post(client, data, 'invalid-preview')
    assert response.status_code == 409


@pytest.mark.parametrize('raw,kind,expected', [('Нет', 'boolean', False), ('0', 'number', 0),
    ('1,25', 'number', 1.25), ('["AM4", "AM5"]', 'list', ['AM4', 'AM5'])])
def test_value_formats(raw, kind, expected):
    assert parse_value(raw, kind) == expected


def test_partial_connector_json_preserves_recorded_facts(catalog_client):
    client, db = catalog_client
    product, attr = setup_sheet(db, kind='list', code='psu_pcie_connectors')
    original = [dict(raw='2 x PCIe 8-pin', kind='pcie_8', count=2, cables=None)]
    db.add(ProductAttribute(product_id=product.id, attribute_id=attr.id, value_json=original))
    db.commit()
    exported = client.get(URL + '/export?q=Alpha').content
    assert xlrd.open_workbook(file_contents=exported).sheet_by_index(1).nrows == 2
    corrupt = json.dumps([dict(raw='1 x PCIe 8-pin', kind='pcie_8', count=1, cables=1)])
    assert post(client, fill(exported, corrupt)).json()['error_count'] == 1
    completed = json.dumps([dict(raw='2 x PCIe 8-pin', kind='pcie_8', count=2, cables=2)])
    preview = post(client, fill(exported, completed)).json()
    assert preview['can_apply'] and preview['items'][0]['value'][0]['cables'] == 2
    result = post(client, fill(exported, completed), preview['preview_token'])
    assert result.json()['applied'] == 1


def test_boolean_false_is_not_skipped(catalog_client):
    client, db = catalog_client
    product, attr = setup_sheet(db, kind='boolean')
    data = fill(client.get(URL + '/export?q=Alpha').content, 'Нет')
    preview = post(client, data).json()
    assert preview['can_apply'] and preview['items'][0]['value'] is False
    assert post(client, data, preview['preview_token']).json()['applied'] == 1
    db.expire_all()
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
        ProductAttribute.attribute_id == attr.id)).value_boolean is False


def test_pricerunner_xls_keeps_source_kind(catalog_client):
    client, db = catalog_client
    product, attr = setup_sheet(db)
    data = fill(client.get(URL + '/export?q=Alpha').content, '16', 'https://www.pricerunner.com/product')
    preview = post(client, data).json()
    assert preview['can_apply']
    assert post(client, data, preview['preview_token']).json()['applied'] == 1
    db.expire_all()
    row = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
        ProductAttribute.attribute_id == attr.id))
    assert row.source_kind == 'retailer_site' and 'pricerunner.com' in row.source_url


def test_archive_groups_ten_products_without_splitting_properties(catalog_client):
    client, db = catalog_client
    product, attr = setup_sheet(db)
    category = product.categories[0]
    # Alpha + Beta from seed and 19 new cards, minus completed Alpha: 20 cards.
    for number in range(19):
        db.add(Product(source_id=product.source_id, sku=f'batch:{number}', name=f'Batch {number}',
                       currency='KZT', status='active', raw_data={}, categories=[category]))
    extra = Attribute(code='batch_flag', label='Флаг', value_type='boolean')
    db.add(extra); db.flush()
    db.add(PropertyRule(scope=str(category.id), category_id=category.id, attribute_id=extra.id,
        code=extra.code, source='internal', active=True, revision=1,
        definition=dict(code=extra.code, label=extra.label, level='required', value_type='boolean')))
    db.commit()
    # A complete card must not consume one of the ten product places.
    for attribute in (attr, extra):
        db.add(ProductAttribute(product_id=product.id, attribute_id=attribute.id,
            value_number=16 if attribute == attr else None,
            value_boolean=False if attribute == extra else None, value_state='known'))
    db.commit()
    response = client.get(URL + f'/export?archive=true&category_id={category.id}')
    assert response.status_code == 200 and response.headers['content-type'] == 'application/zip'
    assert response.headers['x-property-rows'] == '40'
    seen, sizes = set(), []
    with ZipFile(BytesIO(response.content)) as archive:
        assert len(archive.namelist()) == 2
        for name in archive.namelist():
            book = xlrd.open_workbook(file_contents=archive.read(name), formatting_info=True)
            assert book.sheet_by_name('Инструкция').nrows > 0
            sheet = book.sheet_by_name('Характеристики 1')
            assert sheet.row_values(0) == HEADERS and sheet.colinfo_map[META].hidden
            ids = {sheet.cell_value(i, 0) for i in range(1, sheet.nrows)}
            assert not seen & ids and str(product.id) not in ids
            seen |= ids; sizes.append(len(ids))
            assert sheet.nrows == len(ids) * 2 + 1
            # Every part remains signed and independently accepted by the importer.
            preview = post(client, fill(archive.read(name), '1')).json()
            assert preview['can_apply'] and preview['properties'] == len(ids) * 2
    assert sizes == [10, 10] and len(seen) == 20
    filtered = client.get(URL + '/export?archive=true&q=Batch 18')
    with ZipFile(BytesIO(filtered.content)) as archive:
        assert len(archive.namelist()) == 1
        assert xlrd.open_workbook(file_contents=archive.read(archive.namelist()[0])).sheet_by_index(1).nrows == 3
    assert client.get(URL + '/export?archive=true&q=does-not-exist').status_code == 422


def test_zip_preview_apply_all_files_atomically(catalog_client):
    client, db = catalog_client
    product, attr = setup_sheet(db)
    first = fill(client.get(URL + '/export?q=Alpha').content, '16')
    second = fill(client.get(URL + '/export?q=Beta').content, '32')
    archive = zip_files([('one.xls', first), ('two.xls', second)])
    preview = post(client, archive).json()
    assert preview['can_apply'] and preview['products'] == 2 and preview['properties'] == 2
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.attribute_id == attr.id)) is None
    assert post(client, archive, 'forged').status_code == 409
    result = post(client, archive, preview['preview_token'])
    assert result.json()['applied'] == 2 and result.json()['products'] == 2
    assert post(client, archive).json()['properties'] == 0


def test_zip_bad_row_or_duplicate_blocks_every_file(catalog_client):
    client, db = catalog_client
    _, attr = setup_sheet(db, minimum=1)
    first = fill(client.get(URL + '/export?q=Alpha').content, '16')
    invalid = fill(client.get(URL + '/export?q=Beta').content, '0')
    for files in ([('valid.xls', first), ('invalid.xls', invalid)],
                  [('first.xls', first), ('duplicate.xls', first)]):
        archive = zip_files(files)
        preview = post(client, archive).json()
        assert not preview['can_apply'] and preview['error_count'] == 1
        assert files[1][0] in preview['errors'][0]['sheet']
        applied = post(client, archive, preview['preview_token']).json()
        assert applied['applied'] == 0
        assert db.scalar(select(ProductAttribute).where(ProductAttribute.attribute_id == attr.id)) is None


def test_zip_rejects_invalid_contents_and_expansion_limit(catalog_client):
    client, db = catalog_client
    setup_sheet(db)
    for data in (zip_files([]), zip_files([('readme.txt', b'text')]),
                 zip_files([('bad.xls', b'not-excel')]), b'PKbroken',
                 zip_files([('large.xls', b'0' * (21 * 1024 * 1024))])):
        assert post(client, data).status_code in (413, 422)


def test_large_import_fits_audit_id_and_retains_all_product_ids(catalog_client):
    client, db = catalog_client
    product, attr = setup_sheet(db)
    for number in range(90):
        db.add(Product(source_id=product.source_id, sku=f'large:{number}', name=f'Large {number}',
            currency='KZT', status='active', raw_data={}, categories=product.categories[:]))
    db.commit()
    exported = client.get(URL + '/export?q=Large').content
    data = fill(exported, '16')
    preview = post(client, data).json()
    assert preview['products'] == 90 and preview['can_apply']
    applied = post(client, data, preview['preview_token'])
    assert applied.status_code == 200 and applied.json()['applied'] == 90
    audit = db.scalar(select(AuditLog).where(AuditLog.action == 'properties.xls_missing_imported'))
    assert len(audit.object_id) <= 160 and len(audit.details['product_ids']) == 90
    assert len(audit.details['changes']) == 90
