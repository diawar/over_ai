from sqlalchemy import func, select
from app import main
from app.models import Attribute, AuditLog, Category, CategoryAttribute, ProductAttribute, PropertyRule
from test_catalog_views import catalog_client, seed


def csrf(client):
    client.cookies.set("corelab_csrf", "properties-test")
    return {"X-CSRF-Token": "properties-test"}


def test_properties_tab_lists_core_categories_and_active_rule_counts(catalog_client):
    client, db = catalog_client
    parent, category, _ = seed(db)
    path = "/api/v1/admin/properties/categories"
    items = {item["id"]: item for item in client.get(path).json()["items"]}
    assert items[category.id]["parent_id"] == parent.id
    assert items[category.id]["property_count"] == 0
    response = client.post(f"{path}/{category.id}/rules", json={
        "code": "socket", "label": "Сокет", "source": "internal", "level": "required"},
        headers=csrf(client))
    assert response.status_code == 200
    rule_id = response.json()["id"]
    assert {item["id"]: item for item in client.get(path).json()["items"]}[category.id]["property_count"] == 1
    assert client.delete(f"/api/v1/admin/properties/rules/{rule_id}", headers=csrf(client)).status_code == 200
    assert {item["id"]: item for item in client.get(path).json()["items"]}[category.id]["property_count"] == 0
    main.app.dependency_overrides.pop(main.admin_user)
    assert client.get(path).status_code == 401


def test_crud_csrf_preservation_and_check_invalidation(catalog_client):
    client, db = catalog_client
    _, cat, product = seed(db)
    path = f"/api/v1/admin/properties/categories/{cat.id}"
    assert client.post(path + "/defaults", json={"template": "ram"}).status_code == 403
    headers = csrf(client)
    assert client.post(path + "/defaults", json={"template": "ram"}, headers=headers).status_code == 200
    count = db.scalar(select(func.count()).select_from(PropertyRule))
    assert client.post(path + "/defaults", json={"template": "ram"}, headers=headers).status_code == 200
    assert db.scalar(select(func.count()).select_from(PropertyRule)) == count
    data = client.get(path).json()
    assert data["check"]["current"] is False
    checked = client.post(path + "/check", headers=headers).json()
    assert checked["current"] is True and checked["ai_load_allowed"] is False
    rule = next(r for r in data["items"] if r["code"] == "memory_type")
    assert rule["attribute_id"] == db.scalar(select(Attribute.id).where(Attribute.code == "memory_type"))
    body = {k: v for k, v in rule.items() if k not in ("id", "attribute_id", "scope", "revision")}
    body.update(ai_blocked=True, required_for_selection=True, level="required")
    assert client.patch(f"/api/v1/admin/properties/rules/{rule['id']}", json=body, headers=headers).status_code == 200
    assert client.get(path).json()["check"]["current"] is False
    stored = db.get(PropertyRule, rule["id"])
    link = db.get(CategoryAttribute, (cat.id, stored.attribute_id))
    assert link.ai_blocked and link.required_for_selection
    assert client.delete(f"/api/v1/admin/properties/rules/{rule['id']}", headers=headers).status_code == 200
    assert db.scalar(select(func.count()).select_from(ProductAttribute).where(ProductAttribute.product_id == product.id)) == 1
    assert db.scalar(select(func.count()).select_from(AuditLog)) >= 4
    # Re-adding an archived code restores its original rule, not a duplicate definition.
    restored = client.post(path + "/rules", json=body, headers=headers)
    assert restored.status_code == 200 and restored.json()["id"] == rule["id"]


def test_unique_codes_and_no_silent_changes_to_existing_attribute(catalog_client):
    client, db = catalog_client
    _, cat, _ = seed(db)
    path = f"/api/v1/admin/properties/categories/{cat.id}/rules"
    headers = csrf(client)
    original = {"code": "socket", "label": "Сокет", "source": "internal", "level": "required"}
    assert client.post(path, json=original, headers=headers).status_code == 200
    assert client.post(path, json=original, headers=headers).status_code == 409
    row = db.scalar(select(PropertyRule).where(PropertyRule.code == "socket"))
    assert client.patch(f"/api/v1/admin/properties/rules/{row.id}", json={**original, "value_type": "number"}, headers=headers).status_code == 409
    assert db.scalar(select(Attribute).where(Attribute.code == "socket")).value_type == "string"


def test_applying_template_restores_archived_missing_rule(catalog_client):
    client, db = catalog_client
    _, cat, _ = seed(db)
    # Match the shared socket definition expected by the CPU template.
    socket = db.scalar(select(Attribute).where(Attribute.code == "socket"))
    socket.normalization = {"aliases": {"LGA 1700": "LGA1700", "LGA 1851": "LGA1851"}}
    db.commit()
    path = f"/api/v1/admin/properties/categories/{cat.id}"
    headers = csrf(client)

    assert client.post(path + "/defaults", json={"template": "cpu"}, headers=headers).status_code == 200
    assert client.get(path).json()["category"]["template_code"] == "cpu"
    original = next(item for item in client.get(path).json()["items"] if item["code"] == "cores")
    removed = client.delete(f"/api/v1/admin/properties/rules/{original['id']}", headers=headers)
    assert removed.status_code == 200
    assert all(item["id"] != original["id"] for item in client.get(path).json()["items"])

    restored_response = client.post(path + "/defaults", json={"template": "cpu"}, headers=headers)
    assert restored_response.status_code == 200
    restored = next(item for item in restored_response.json()["items"] if item["code"] == "cores")
    assert restored["id"] == original["id"]
    assert db.get(PropertyRule, original["id"]).active is True


def test_templates_multiple_categories_and_arbitrary_new_rule(catalog_client):
    client, db = catalog_client
    _, cat, product = seed(db)
    headers = csrf(client)
    for key in ("ssd", "monitor", "laptop"):
        category = Category(source_id=cat.source_id, source_category_id=key, name=key)
        db.add(category); db.commit()
        path = f"/api/v1/admin/properties/categories/{category.id}"
        result = client.post(path + "/defaults", json={"template": key}, headers=headers)
        assert result.status_code == 200, result.text
        result = client.post(path + "/preview", json={"values": {}, "context": {"country": "KZ"}}, headers=headers)
        assert result.json()["groups"]["internal"]["status"] == "warning"
    path = f"/api/v1/admin/properties/categories/{cat.id}"
    custom = {"code": "unique_feature", "label": "Особенность", "source": "internal", "level": "conditional", "condition": {"op": "eq", "field": "context.country", "value": "KZ"}}
    assert client.post(path + "/rules", json=custom, headers=headers).status_code == 200
    report = client.post(path + "/preview", json={"context": {"country": "KZ"}}, headers=headers).json()
    assert report["groups"]["internal"]["status"] == "error"
    report = client.post(f"/api/v1/admin/properties/products/{product.id}/validate", json={}, headers=headers)
    assert report.status_code == 200
    assert "gmc" in report.json()["groups"]
    assert report.json()["groups"]["internal"]["status"] in ("error", "warning")
    assert product.validity_check is None  # No selection category; rule edits reconcile eligibility.


def test_property_routes_require_admin(catalog_client):
    client, db = catalog_client
    _, cat, _ = seed(db)
    main.app.dependency_overrides.pop(main.admin_user)
    assert client.get(f"/api/v1/admin/properties/categories/{cat.id}").status_code == 401
