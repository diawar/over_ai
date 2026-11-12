from sqlalchemy import select, func
from app.models import Attribute, ProductAttribute, PropertyValue
from app.property_engine import RuleDefinition
from app.property_service import attach_rule
from test_catalog_views import catalog_client, seed
from test_product_attribute_views import headers


def test_cooling_manual_edit_and_dictionary_use_one_canonical_value(catalog_client):
    client, db = catalog_client
    _, category, product = seed(db)
    attach_rule(db, category.id, RuleDefinition(code='cooler_fan_connectors',
        label='Подключения', level='required', value_type='list'))
    db.commit()
    attr = db.scalar(select(Attribute).where(Attribute.code == 'cooler_fan_connectors'))
    path = f'/api/v1/admin/catalog/{product.id}/attributes/{attr.code}'
    response = client.patch(path, json={'value_state': 'known',
        'value': ['4 pin pwm 0.2 A', '1 x 4-pin PWM 0.2 A']}, headers=headers(client))
    assert response.status_code == 200, response.text
    value = db.scalar(select(ProductAttribute).where(ProductAttribute.attribute_id == attr.id))
    assert len(value.value_json) == 1
    assert value.value_json[0]['kind'] == 'fan_pwm_4pin'
    assert value.value_json[0]['current_a'] == 0.2
    root = f'/api/v1/admin/properties/dictionary/{attr.id}/values'
    duplicate = client.post(root, json={'value': ['1 x 4-pin PWM 0.2 A']}, headers=headers(client))
    assert duplicate.status_code == 409, duplicate.text
    assert db.scalar(select(func.count()).select_from(PropertyValue).where(PropertyValue.attribute_id == attr.id)) == 0


def test_argb_aliases_do_not_create_dictionary_duplicates(catalog_client):
    client, db = catalog_client
    _, category, _ = seed(db)
    attach_rule(db, category.id, RuleDefinition(code='cooling_lighting_connectors',
        label='Подсветка', level='required', value_type='list'))
    db.commit()
    attr = db.scalar(select(Attribute).where(Attribute.code == 'cooling_lighting_connectors'))
    path = f'/api/v1/admin/properties/dictionary/{attr.id}/values'
    first = client.post(path, json={'value': ['3-pin 5V ARGB']}, headers=headers(client))
    assert first.status_code == 200, first.text
    second = client.post(path, json={'value': ['1 x 3 pin 5v argb']}, headers=headers(client))
    assert second.status_code == 409, second.text
