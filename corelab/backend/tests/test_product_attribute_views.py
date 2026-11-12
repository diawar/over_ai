from sqlalchemy import func, select

from app import main
from app.models import (Attribute, AuditLog, CategoryAttribute, ProductAttribute,
                        PropertyRule)
from app.property_engine import RuleDefinition
from test_catalog_views import catalog_client, seed


def headers(client):
    client.cookies.set("corelab_csrf", "product-attribute-test")
    return {"X-CSRF-Token": "product-attribute-test"}


def test_product_attribute_create_update_validate_source_and_invalidate(catalog_client):
    client, db = catalog_client
    _, category, product = seed(db)
    socket = db.scalar(select(Attribute).where(Attribute.code == "socket"))
    cores = Attribute(code="cores", label="Число ядер", value_type="integer")
    graphics = Attribute(code="integrated_graphics", label="Встроенная графика", value_type="boolean")
    instruction_sets = Attribute(code="instruction_sets", label="Наборы инструкций", value_type="list")
    db.add_all([cores, graphics, instruction_sets]); db.flush()
    db.add_all([CategoryAttribute(category_id=category.id, attribute_id=socket.id),
                CategoryAttribute(category_id=category.id, attribute_id=cores.id),
                CategoryAttribute(category_id=category.id, attribute_id=graphics.id),
                CategoryAttribute(category_id=category.id, attribute_id=instruction_sets.id)])
    for attribute, definition in (
        (socket, RuleDefinition(code="socket", label="Сокет", level="required").model_dump(mode="json")),
        (cores, RuleDefinition(code="cores", label="Число ядер", level="required", value_type="integer", minimum=1).model_dump(mode="json")),
        (graphics, RuleDefinition(code="integrated_graphics", label="Встроенная графика", level="recommended", value_type="boolean").model_dump(mode="json")),
        (instruction_sets, RuleDefinition(code="instruction_sets", label="Наборы инструкций", level="optional", value_type="list").model_dump(mode="json")),
    ):
        db.add(PropertyRule(scope=str(category.id), category_id=category.id, attribute_id=attribute.id,
                            code=attribute.code, source="internal", definition=definition))
    product.validity_check = True
    product.selection_enabled = False
    db.commit()

    detail_path = f"/api/v1/admin/catalog/{product.id}"
    edit_path = f"{detail_path}/attributes/socket"
    detail = client.get(detail_path).json()
    available = {item["code"]: item for item in detail["available_attributes"]}
    assert available["socket"]["editable"] is True and available["cores"]["value_type"] == "integer"
    assert client.patch(edit_path, json={"value_state": "known", "value": "AM5"}).status_code == 403

    response = client.patch(edit_path, json={
        "value_state": "known", "value": "  AM5 ", "source_kind": "manufacturer_site",
        "source_url": "https://www.amd.com/en/products/processors",
    }, headers=headers(client))
    assert response.status_code == 200, response.text
    saved = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
                                                       ProductAttribute.attribute_id == socket.id))
    assert saved.value_string == "AM5" and saved.source_kind == "manufacturer_site"
    assert db.scalar(select(func.count()).select_from(ProductAttribute).where(
        ProductAttribute.product_id == product.id)) == 1
    assert product.validity_check is None and product.selection_enabled is False
    saved_core = client.patch(f"{detail_path}/attributes/cores", json={
        "value_state": "known", "value": "8",
    }, headers=headers(client))
    assert saved_core.status_code == 200 and saved_core.json()["value"] == 8
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
                                                      ProductAttribute.attribute_id == cores.id)).value_number == 8
    response = client.patch(f"{detail_path}/attributes/integrated_graphics", json={
        "value_state": "known", "value": False,
    }, headers=headers(client))
    assert response.status_code == 200 and response.json()["value"] is False
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
                                                      ProductAttribute.attribute_id == graphics.id)).value_boolean is False
    response = client.patch(f"{detail_path}/attributes/instruction_sets", json={
        "value_state": "known", "value": ["SSE4.2", "AVX2"],
    }, headers=headers(client))
    assert response.status_code == 200 and response.json()["value"] == ["SSE4.2", "AVX2"]
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id,
                                                      ProductAttribute.attribute_id == instruction_sets.id)).value_json == ["SSE4.2", "AVX2"]
    detail = client.get(detail_path).json()
    assert next(item for item in detail["attributes"] if item["code"] == "socket")["source_url"] == "https://www.amd.com/en/products/processors"

    invalid = client.patch(edit_path, json={"value_state": "known", "value": {"wrong": True}}, headers=headers(client))
    assert invalid.status_code == 422
    invalid_source = client.patch(edit_path, json={
        "value_state": "known", "value": "AM5", "source_kind": "manufacturer_site",
    }, headers=headers(client))
    assert invalid_source.status_code == 422

    response = client.patch(edit_path, json={"value_state": "unknown", "value": None}, headers=headers(client))
    assert response.status_code == 200
    assert saved.value_state == "unknown" and saved.value_string is None
    assert db.scalar(select(func.count()).select_from(ProductAttribute).where(
        ProductAttribute.product_id == product.id)) == 4
    assert db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "product.attribute_changed")) == 5


def test_product_attribute_endpoint_requires_admin(catalog_client):
    client, db = catalog_client
    _, _, product = seed(db)
    main.app.dependency_overrides.pop(main.admin_user)
    response = client.patch(f"/api/v1/admin/catalog/{product.id}/attributes/socket", json={
        "value_state": "unknown", "value": None,
    }, headers=headers(client))
    assert response.status_code == 401


def test_delete_product_attribute_requires_confirmation_snapshot_and_audits(catalog_client):
    client, db = catalog_client
    _, _, product = seed(db)
    path = f"/api/v1/admin/catalog/{product.id}/attributes/socket"
    body = {"expected_value_state": "known", "expected_value": "AM5",
            "expected_source_kind": None, "expected_source_url": None}
    assert client.request("DELETE", path, json=body).status_code == 403
    token_headers = headers(client)
    stale = {**body, "expected_value": "AM4"}
    assert client.request("DELETE", path, json=stale, headers=token_headers).status_code == 409
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id)) is not None
    response = client.request("DELETE", path, json=body, headers=token_headers)
    assert response.status_code == 200, response.text
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id)) is None
    log = db.scalar(select(AuditLog).where(AuditLog.action == "product.attribute_deleted"))
    assert log.user_id is not None and log.object_id == f"{product.id}:socket"
    assert client.request("DELETE", path, json=body, headers=token_headers).status_code == 404
    main.app.dependency_overrides.pop(main.admin_user)
    assert client.request("DELETE", path, json=body, headers=token_headers).status_code == 401


def test_bulk_attribute_preview_apply_is_typed_audited_and_revalidated(catalog_client):
    client, db = catalog_client
    _, category, alpha = seed(db)
    from app.models import Product
    beta = db.scalar(select(Product).where(Product.name == "Beta"))
    socket = db.scalar(select(Attribute).where(Attribute.code == "socket"))
    db.add(CategoryAttribute(category_id=category.id, attribute_id=socket.id))
    db.add(PropertyRule(scope=str(category.id), category_id=category.id, attribute_id=socket.id,
                        code="socket", source="internal",
                        definition=RuleDefinition(code="socket", label="Socket", level="required").model_dump(mode="json")))
    db.commit()
    payload = {"product_ids": [alpha.id, beta.id], "code": "socket", "value_state": "known", "value": "AM4"}
    options = client.get("/api/v1/admin/catalog/bulk-attributes/options", params=[("product_ids", alpha.id), ("product_ids", beta.id)])
    assert options.status_code == 200 and [item["code"] for item in options.json()["items"]] == ["socket"]
    preview = client.post("/api/v1/admin/catalog/bulk-attributes/preview", json=payload, headers=headers(client))
    assert preview.status_code == 200, preview.text
    assert (preview.json()["selected_count"], preview.json()["overwrite_count"], preview.json()["insert_count"]) == (2, 1, 1)
    saved = client.post("/api/v1/admin/catalog/bulk-attributes/apply", json={**payload, "preview_token": preview.json()["preview_token"]}, headers=headers(client))
    assert saved.status_code == 200, saved.text
    assert saved.json()["updated_count"] == 2
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == alpha.id, ProductAttribute.attribute_id == socket.id)).value_string == "AM4"
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == beta.id, ProductAttribute.attribute_id == socket.id)).value_string == "AM4"
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "product.bulk_attribute_changed")) == 2
    assert len({entry.details["batch_id"] for entry in db.scalars(select(AuditLog).where(AuditLog.action == "product.bulk_attribute_changed"))}) == 1


def test_bulk_attribute_rejects_stale_preview_without_partial_write(catalog_client):
    client, db = catalog_client
    _, category, alpha = seed(db)
    from app.models import Product
    beta = db.scalar(select(Product).where(Product.name == "Beta"))
    socket = db.scalar(select(Attribute).where(Attribute.code == "socket"))
    db.add(CategoryAttribute(category_id=category.id, attribute_id=socket.id))
    db.add(PropertyRule(scope=str(category.id), category_id=category.id, attribute_id=socket.id,
                        code="socket", source="internal",
                        definition=RuleDefinition(code="socket", label="Socket", level="required").model_dump(mode="json")))
    db.commit()
    payload = {"product_ids": [alpha.id, beta.id], "code": "socket", "value_state": "known", "value": "AM4"}
    preview = client.post("/api/v1/admin/catalog/bulk-attributes/preview", json=payload, headers=headers(client))
    assert preview.status_code == 200
    db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == alpha.id, ProductAttribute.attribute_id == socket.id)).value_string = "AM3"
    db.commit()
    response = client.post("/api/v1/admin/catalog/bulk-attributes/apply", json={**payload, "preview_token": preview.json()["preview_token"]}, headers=headers(client))
    assert response.status_code == 409
    assert db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == beta.id, ProductAttribute.attribute_id == socket.id)) is None
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "product.bulk_attribute_changed")) == 0


def test_bulk_attribute_handles_twenty_mixed_products_atomically(catalog_client):
    client, db = catalog_client
    _, category, alpha = seed(db)
    from app.models import Product
    socket = db.scalar(select(Attribute).where(Attribute.code == "socket"))
    db.add(CategoryAttribute(category_id=category.id, attribute_id=socket.id))
    db.add(PropertyRule(scope=str(category.id), category_id=category.id, attribute_id=socket.id,
                        code="socket", source="internal",
                        definition=RuleDefinition(code="socket", label="Socket", level="optional").model_dump(mode="json")))
    products = [alpha]
    products.extend(Product(source_id=alpha.source_id, sku=f"bulk:{number}", name=f"Bulk {number}",
                            currency="KZT", status="active", raw_data={}, categories=[category])
                    for number in range(2, 21))
    db.add_all(products[1:]); db.flush()
    for product in products[2::2]:
        db.add(ProductAttribute(product_id=product.id, attribute_id=socket.id, value_string="AM5"))
    db.commit()
    payload = {"product_ids": [product.id for product in products], "code": "socket", "value_state": "known", "value": "AM4"}
    preview = client.post("/api/v1/admin/catalog/bulk-attributes/preview", json=payload, headers=headers(client))
    assert preview.status_code == 200, preview.text
    assert (preview.json()["selected_count"], preview.json()["overwrite_count"], preview.json()["insert_count"]) == (20, 10, 10)
    response = client.post("/api/v1/admin/catalog/bulk-attributes/apply", json={**payload, "preview_token": preview.json()["preview_token"]}, headers=headers(client))
    assert response.status_code == 200, response.text
    assert response.json()["updated_count"] == 20
    assert db.scalar(select(func.count()).select_from(ProductAttribute).where(ProductAttribute.attribute_id == socket.id)) == 20
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "product.bulk_attribute_changed")) == 20
