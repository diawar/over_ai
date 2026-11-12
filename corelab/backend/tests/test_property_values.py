import pytest
from sqlalchemy import select

from app import main
from app.models import (Attribute, AuditLog, CategoryAttribute, Product, ProductAttribute,
                        PropertyRule, PropertyValue)
from app.property_engine import RuleDefinition, normalize
from app.property_service import attach_rule
from test_catalog_views import catalog_client, seed


def test_gpu_normalization_at_shared_write_boundary():
    rule = RuleDefinition(code="gpu_graphics_processor", label="Графический процессор", level="recommended")
    assert normalize("NVIDIA GeForce RTX 5080", rule) == "GeForce RTX 5080"
    assert normalize("AMD Radeon RX 9070 XT", rule) == "Radeon RX 9070 XT"
    assert normalize("GeForce RTX 5080", rule) == "GeForce RTX 5080"
    assert normalize("NVIDIA RTX A5000", rule) == "NVIDIA RTX A5000"


def test_dictionary_selection_highlight_requires_active_category_and_required_property(catalog_client):
    client, db = catalog_client
    _, category, _ = seed(db)
    attach_rule(db, category.id, RuleDefinition(code="selection_probe", label="Проверка", level="recommended"))
    attribute = db.scalar(select(Attribute).where(Attribute.code == "selection_probe"))
    db.flush()
    link = db.get(CategoryAttribute, (category.id, attribute.id))
    def highlighted():
        db.commit()
        return next(item for item in client.get("/api/v1/admin/properties/dictionary").json()["items"]
                    if item["id"] == attribute.id)["used_for_selection"]
    category.selection_category = True
    link.required_for_selection = False
    assert highlighted() is False
    link.required_for_selection = True
    assert highlighted() is True
    category.selection_category = False
    assert highlighted() is False


def test_values_browse_and_atomic_merge_with_stale_guard(catalog_client):
    client, db = catalog_client
    _, category, first = seed(db)
    second = db.scalar(select(Product).where(Product.sku == "p1:2"))
    attach_rule(db, category.id, RuleDefinition(code="gpu_graphics_processor", label="Графический процессор", level="recommended"))
    attribute = db.scalar(select(Attribute).where(Attribute.code == "gpu_graphics_processor"))
    db.add_all([
        ProductAttribute(product_id=first.id, attribute_id=attribute.id, value_state="known",
                         value_string="GeForce RTX 5080", source_kind="manual"),
        ProductAttribute(product_id=second.id, attribute_id=attribute.id, value_state="known",
                         value_string="NVIDIA GeForce RTX 5080", source_kind="manufacturer_site",
                         source_url="https://example.test/gpu"),
    ])
    db.commit()
    root = "/api/v1/admin/properties/dictionary"
    assert any(item["code"] == "gpu_graphics_processor" and item["filled_count"] == 2
               for item in client.get(root).json()["items"])
    path = f"{root}/{attribute.id}"
    values = client.get(path + "/values").json()
    assert {row["value"]: row["count"] for row in values["items"]} == {
        "GeForce RTX 5080": 1, "NVIDIA GeForce RTX 5080": 1}
    body = {"sources": ["NVIDIA GeForce RTX 5080"], "target": "GeForce RTX 5080",
            "expected_counts": {"NVIDIA GeForce RTX 5080": 1, "GeForce RTX 5080": 1}}
    assert client.post(path + "/merge", json=body).status_code == 403
    client.cookies.set("corelab_csrf", "values-test")
    headers = {"X-CSRF-Token": "values-test"}
    stale = {**body, "expected_counts": {**body["expected_counts"], "NVIDIA GeForce RTX 5080": 2}}
    assert client.post(path + "/merge", json=stale, headers=headers).status_code == 409
    result = client.post(path + "/merge", json=body, headers=headers)
    assert result.status_code == 200 and result.json()["updated_products"] == 1
    assert client.get(path + "/values").json()["items"] == [{"key": "GeForce RTX 5080", "value": "GeForce RTX 5080", "count": 2, "registered": False}]
    updated = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == second.id,
                                                       ProductAttribute.attribute_id == attribute.id))
    assert updated.source_kind == "manufacturer_site" and updated.source_url == "https://example.test/gpu"
    assert db.scalar(select(AuditLog).where(AuditLog.action == "properties.values_merged")).user_id is not None
    # The manual editor uses the same normalizer as the AI loader.
    response = client.patch(f"/api/v1/admin/catalog/{first.id}/attributes/gpu_graphics_processor",
                            json={"value_state": "known", "value": "NVIDIA GeForce RTX 5080"}, headers=headers)
    assert response.status_code == 200
    assert db.scalar(select(ProductAttribute.value_string).where(
        ProductAttribute.product_id == first.id, ProductAttribute.attribute_id == attribute.id)) == "GeForce RTX 5080"
    main.app.dependency_overrides.pop(main.admin_user)
    assert client.get(root).status_code == 401
    assert client.get(path + "/values").status_code == 401


def test_delete_attribute_removes_values_from_all_products_and_category_rules(catalog_client):
    client, db = catalog_client
    _, category, first = seed(db)
    second = db.scalar(select(Product).where(Product.sku == "p1:2"))
    attach_rule(db, category.id, RuleDefinition(code="test_delete", label="Удаляемое свойство",
                                                level="recommended"))
    attribute = db.scalar(select(Attribute).where(Attribute.code == "test_delete"))
    db.add_all([
        ProductAttribute(product_id=first.id, attribute_id=attribute.id, value_string="Первое"),
        ProductAttribute(product_id=second.id, attribute_id=attribute.id, value_string="Второе"),
        PropertyValue(attribute_id=attribute.id, value_key="Третье", value_json="Третье"),
    ])
    db.commit()
    path = f"/api/v1/admin/properties/dictionary/{attribute.id}"
    assert client.get(path + "/values").json()["linked_products"] == 2
    body = {"code": attribute.code, "expected_product_count": 2}
    assert client.request("DELETE", path, json=body).status_code == 403
    client.cookies.set("corelab_csrf", "values-test")
    headers = {"X-CSRF-Token": "values-test"}
    assert client.request("DELETE", path, json={**body, "expected_product_count": 1},
                          headers=headers).status_code == 409
    response = client.request("DELETE", path, json=body, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["linked_products"] == 2
    assert db.get(Attribute, attribute.id) is None
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.attribute_id == attribute.id)) is None
    assert db.scalar(select(PropertyValue).where(PropertyValue.attribute_id == attribute.id)) is None
    assert db.scalar(select(CategoryAttribute).where(CategoryAttribute.attribute_id == attribute.id)) is None
    assert db.scalar(select(PropertyRule).where(PropertyRule.code == "test_delete")) is None
    assert db.scalar(select(Attribute).where(Attribute.code == "socket")) is not None
    assert client.get(path + "/values").status_code == 404
    assert db.scalar(select(AuditLog).where(AuditLog.action == "properties.attribute_deleted")) is not None


@pytest.mark.parametrize("value_type,column,first_value,second_value", [
    ("number", "value_number", 3.5, 3.6),
    ("integer", "value_number", 8, 9),
    ("boolean", "value_boolean", False, True),
    ("list", "value_json", ["A"], ["B"]),
    ("url", "value_string", "https://example.test/a", "https://example.test/b"),
    ("enum", "value_string", "A", "B"),
])
def test_merge_all_value_types(catalog_client, value_type, column, first_value, second_value):
    client, db = catalog_client
    _, _, first = seed(db)
    second = db.scalar(select(Product).where(Product.sku == "p1:2"))
    attribute = Attribute(code="test_value", label="Тестовое свойство", value_type=value_type)
    db.add(attribute); db.flush()
    db.add_all([
        ProductAttribute(product_id=first.id, attribute_id=attribute.id, value_state="known",
                         **{column: first_value}),
        ProductAttribute(product_id=second.id, attribute_id=attribute.id, value_state="known",
                         source_kind="manufacturer_site", **{column: second_value}),
    ])
    db.commit()
    path = f"/api/v1/admin/properties/dictionary/{attribute.id}"
    before = client.get(path + "/values").json()
    assert before["merge_supported"] is True
    def matches(item, value):
        return (float(item["value"]) if value_type in ("number", "integer") else item["value"]) == value
    first_item = next(item for item in before["items"] if matches(item, first_value))
    target_item = next(item for item in before["items"] if matches(item, second_value))
    source = first_item["key"]
    target = target_item["key"]
    body = {"sources": [source], "target": target, "expected_counts": {source: 1, target: 1}}
    client.cookies.set("corelab_csrf", "values-test")
    result = client.post(path + "/merge", json=body, headers={"X-CSRF-Token": "values-test"})
    assert result.status_code == 200, result.text
    assert result.json()["updated_products"] == 1
    assert client.get(path + "/values").json()["items"] == [{**target_item, "count": 2}]
    updated = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == first.id,
                                                       ProductAttribute.attribute_id == attribute.id))
    assert getattr(updated, column) == getattr(db.scalar(select(ProductAttribute).where(
        ProductAttribute.product_id == second.id, ProductAttribute.attribute_id == attribute.id)), column)


@pytest.mark.parametrize("value_type,value,changed", [
    ("string", "Alpha", "Beta"),
    ("number", "3.5", "3.6"),
    ("integer", "8", "9"),
    ("boolean", False, True),
    ("list", ["A"], ["B"]),
    ("url", "https://example.test/a", "https://example.test/b"),
    ("enum", "A", "B"),
])
def test_value_crud_preserves_empty_values(catalog_client, value_type, value, changed):
    client, db = catalog_client
    seed(db)
    attribute = Attribute(code="test_value", label="Тестовое свойство", value_type=value_type)
    db.add(attribute); db.commit()
    path = f"/api/v1/admin/properties/dictionary/{attribute.id}/values"
    client.cookies.set("corelab_csrf", "values-test")
    headers = {"X-CSRF-Token": "values-test"}
    assert client.post(path, json={"value": value}).status_code == 403
    created = client.post(path, json={"value": value}, headers=headers)
    assert created.status_code == 200, created.text
    assert created.json()["count"] == 0
    assert client.post(path, json={"value": value}, headers=headers).status_code == 409
    listed = client.get(path).json()["items"]
    assert listed == [{**created.json(), "registered": True}]
    changed_result = client.patch(path, json={"key": created.json()["key"], "value": changed,
                                              "expected_count": 0}, headers=headers)
    assert changed_result.status_code == 200, changed_result.text
    new_key = changed_result.json()["key"]
    assert client.get(path).json()["items"][0]["key"] == new_key
    assert client.request("DELETE", path, json={"key": new_key, "expected_count": 0}, headers=headers).status_code == 200
    assert client.get(path).json()["items"] == []
    assert {row.action for row in db.scalars(select(AuditLog))} >= {
        "properties.value_created", "properties.value_updated", "properties.value_deleted"}


def test_value_edit_and_delete_update_products_with_stale_guard(catalog_client):
    client, db = catalog_client
    _, _, first = seed(db)
    attribute = Attribute(code="base_clock_ghz", label="Базовая частота", value_type="number")
    db.add(attribute); db.flush()
    db.add(ProductAttribute(product_id=first.id, attribute_id=attribute.id, value_state="known",
                            value_number=3.5, source_kind="manufacturer_site"))
    db.commit()
    path = f"/api/v1/admin/properties/dictionary/{attribute.id}/values"
    client.cookies.set("corelab_csrf", "values-test")
    headers = {"X-CSRF-Token": "values-test"}
    old_key = client.get(path).json()["items"][0]["key"]
    assert client.patch(path, json={"key": old_key, "value": "3.6", "expected_count": 0}, headers=headers).status_code == 409
    edited = client.patch(path, json={"key": old_key, "value": "3.6", "expected_count": 1}, headers=headers)
    assert edited.status_code == 200, edited.text
    new_key = edited.json()["key"]
    row = db.scalar(select(ProductAttribute).where(ProductAttribute.attribute_id == attribute.id))
    assert str(row.value_number) == new_key and row.source_kind == "manufacturer_site"
    assert client.request("DELETE", path, json={"key": new_key, "expected_count": 0}, headers=headers).status_code == 409
    assert client.request("DELETE", path, json={"key": new_key, "expected_count": 1}, headers=headers).status_code == 200
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.attribute_id == attribute.id)) is None
    assert client.get(path).json()["items"] == []


def test_merge_into_registered_value_without_products(catalog_client):
    client, db = catalog_client
    _, _, first = seed(db)
    attribute = Attribute(code="test_value", label="Тестовое свойство", value_type="string")
    db.add(attribute); db.flush()
    db.add(ProductAttribute(product_id=first.id, attribute_id=attribute.id, value_state="known",
                            value_string="Старое"))
    db.commit()
    path = f"/api/v1/admin/properties/dictionary/{attribute.id}"
    client.cookies.set("corelab_csrf", "values-test")
    headers = {"X-CSRF-Token": "values-test"}
    assert client.post(path + "/values", json={"value": "Новое"}, headers=headers).status_code == 200
    result = client.post(path + "/merge", json={"sources": ["Старое"], "target": "Новое",
                                                  "expected_counts": {"Старое": 1, "Новое": 0}}, headers=headers)
    assert result.status_code == 200, result.text
    assert client.get(path + "/values").json()["items"] == [
        {"key": "Новое", "value": "Новое", "count": 1, "registered": True}]
