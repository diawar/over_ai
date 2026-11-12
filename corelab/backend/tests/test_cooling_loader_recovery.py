import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker
from app import product_loader
from app.models import Attribute, ProductAttribute, JobItem
from app.property_engine import RuleDefinition
from app.property_service import attach_rule
from test_product_loader import _ready, SOURCE
from test_catalog_views import catalog_client


def test_recovery_adds_missing_fields_without_replacing_manual_values(catalog_client, monkeypatch):
    client, db, category, product, headers = _ready(catalog_client)
    attach_rule(db, category.id, RuleDefinition(code='cooling_lighting_connectors', label='Подсветка',
        value_type='list', level='required'))
    db.commit()
    assert client.post(f'/api/v1/admin/properties/categories/{category.id}/check', headers=headers).status_code == 200
    original = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id))
    before = (original.id, original.value_string, original.source_url)
    monkeypatch.setattr(product_loader, 'decrypt_key', lambda _: 'secret')
    monkeypatch.setattr(product_loader, 'research_product', lambda *args: {'values': [
        {'code': 'cooling_lighting_connectors', 'value': ['3 pin 5v argb'], 'source_url': SOURCE}]})
    product_loader.enqueue(db, [product.id], category.id, 1,
        fill_missing_codes=['cooling_lighting_connectors'])
    product_loader.process_one(sessionmaker(bind=db.bind, autoflush=False))
    db.expire_all()
    assert (original.id, original.value_string, original.source_url) == before
    item = db.scalar(select(JobItem))
    assert item.status == 'completed', item.details
    row = db.scalar(select(ProductAttribute).join(Attribute).where(ProductAttribute.product_id == product.id,
        Attribute.code == 'cooling_lighting_connectors'))
    assert row.value_json[0]['kind'] == 'argb_3pin_5v'


def test_header_enrichment_preserves_verified_counts():
    old = [{'kind': 'system_fan_header', 'count': 2, 'raw': '2 x SYS_FAN'}]
    new = ['1 x CPU_FAN 4-pin PWM 1 A', '2 x SYS_FAN 4-pin PWM 1 A']
    result = product_loader._merge_header_evidence(old, new)
    assert sum(row['count'] for row in result) == 3
    with pytest.raises(HTTPException, match='противоречит'):
        product_loader._merge_header_evidence(old, ['1 x CPU_FAN 4-pin PWM 1 A', '1 x SYS_FAN 4-pin PWM 1 A'])


def test_shorter_board_spec_does_not_duplicate_existing_combo_headers():
    old = ['1 x CPU_FAN/PUMP 4-pin PWM DC 2 A', '1 x SYS_FAN1/PUMP 4-pin PWM DC 2 A']
    result = product_loader._merge_header_evidence(old, ['1 x CPU_FAN', '1 x SYS_FAN'])
    assert sum(row['count'] for row in result) == 2
    assert product_loader._merge_header_evidence(result, result) == result


def test_recovery_does_not_overwrite_a_concurrent_manual_edit(catalog_client, monkeypatch):
    client, db, category, product, headers = _ready(catalog_client)
    attach_rule(db, category.id, RuleDefinition(code='cooling_lighting_connectors', label='Подсветка',
        value_type='list', level='required'))
    db.commit()
    client.post(f'/api/v1/admin/properties/categories/{category.id}/check', headers=headers)
    attr = db.scalar(select(Attribute).where(Attribute.code == 'cooling_lighting_connectors'))
    factory = sessionmaker(bind=db.bind, autoflush=False)
    monkeypatch.setattr(product_loader, 'decrypt_key', lambda _: 'secret')
    def research(*args):
        with factory() as concurrent:
            concurrent.add(ProductAttribute(product_id=product.id, attribute_id=attr.id,
                value_json=[{'kind': 'none', 'count': 0, 'raw': '0 x none'}], source_kind='manual'))
            concurrent.commit()
        return {'values': [{'code': attr.code, 'value': ['3 pin 5v argb'], 'source_url': SOURCE}]}
    monkeypatch.setattr(product_loader, 'research_product', research)
    product_loader.enqueue(db, [product.id], category.id, 1, fill_missing_codes=[attr.code])
    product_loader.process_one(factory)
    db.expire_all()
    assert db.scalar(select(JobItem)).status == 'skipped'
    row = db.scalar(select(ProductAttribute).where(ProductAttribute.attribute_id == attr.id))
    assert row.source_kind == 'manual' and row.value_json[0]['kind'] == 'none'
