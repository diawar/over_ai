import json

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app import product_loader, product_research
from app.catalog_views import ProductAttributeInput
from app.models import AIProviderSetting, Attribute, AuditLog, JobItem, Product, ProductAttribute, PropertyRule
from app.property_service import ensure_defaults, product_data
from test_catalog_views import catalog_client, seed
from test_property_views import csrf


SOURCE = "https://www.asus.com/motherboards/model-a/techspec/"


def _official_response(payload, source=SOURCE):
    return {"output_text": json.dumps(payload), "output": [{"type": "message", "content": [{
        "type": "output_text", "text": json.dumps(payload),
        "annotations": [{"type": "url_citation", "url": source}]}]}]}


def _payload(**changes):
    return {"manufacturer": "ASUS", "model": "MODEL-A", "category_match": True,
            "category_reason": "Материнская плата", "official_unavailable": False, "source_url": SOURCE,
            "values": [{"code": "socket", "value": "AM5", "source_url": SOURCE}], **changes}


def test_official_citation_exact_model_category_and_empty_data(monkeypatch):
    product = {"name": "ASUS MODEL-A", "manufacturer": "ASUS", "article": "MODEL-A"}
    rules = [{"code": "socket", "label": "Сокет", "unit": None, "value_type": "string"}]
    payload = _payload()
    monkeypatch.setattr(product_research, "openai_request", lambda *args: _official_response(payload))
    result = product_research.research_product("secret", "model", product, "Материнские платы", rules)
    assert result["values"][0]["value"] == "AM5"
    payload["model"] = "MODEL-B"
    with pytest.raises(HTTPException, match="не совпадает"):
        product_research.research_product("secret", "model", product, "Материнские платы", rules)
    payload["model"] = "MODEL-A"
    payload["category_match"] = False
    with pytest.raises(HTTPException, match="не соответствует категории"):
        product_research.research_product("secret", "model", product, "Материнские платы", rules)
    payload["category_match"] = True
    payload["values"] = []
    assert product_research.research_product("secret", "model", product, "Материнские платы", rules)["values"] == []
    payload["source_url"] = "https://example-shop.test/product"
    with pytest.raises(HTTPException, match="Источник модели не подтверждён"):
        product_research.research_product("secret", "model", product, "Материнские платы", rules)


@pytest.mark.parametrize("source", ["https://shop.kz/offer/model-a/",
                                     "https://www.dns-shop.kz/product/model-a/",
                                     "https://www.technodom.kz/p/model-a/"])
def test_retail_fallback_needs_exact_model_citation_and_flag(monkeypatch, source):
    product = {"name": "ASUS MODEL-A", "manufacturer": "ASUS", "article": "MODEL-A"}
    rules = [{"code": "socket", "label": "Сокет", "unit": None, "value_type": "string"}]
    payload = _payload(source_url=source, official_unavailable=True,
                       values=[{"code": "socket", "value": "AM5", "source_url": source}])
    monkeypatch.setattr(product_research, "openai_request", lambda *args: _official_response(payload, source))
    assert product_research.research_product("secret", "model", product, "Материнские платы", rules)["source_tier"] == "retailer"
    payload["official_unavailable"] = False
    with pytest.raises(HTTPException, match="резервный источник не обоснован"):
        product_research.research_product("secret", "model", product, "Материнские платы", rules)
    payload["official_unavailable"] = True
    payload["model"] = "MODEL-B"
    with pytest.raises(HTTPException, match="не совпадает"):
        product_research.research_product("secret", "model", product, "Материнские платы", rules)


def test_retail_fallback_rejects_similar_unapproved_domain(monkeypatch):
    product = {"name": "ASUS MODEL-A", "manufacturer": "ASUS", "article": "MODEL-A"}
    rules = [{"code": "socket", "label": "Сокет", "unit": None, "value_type": "string"}]
    source = "https://dns-shop.kz.example.test/product/model-a/"
    payload = _payload(source_url=source, official_unavailable=True,
                       values=[{"code": "socket", "value": "AM5", "source_url": source}])
    monkeypatch.setattr(product_research, "openai_request", lambda *args: _official_response(payload, source))
    with pytest.raises(HTTPException, match="Источник модели не подтверждён"):
        product_research.research_product("secret", "model", product, "Материнские платы", rules)


def test_official_model_can_use_retail_evidence_for_missing_property(monkeypatch):
    product = {"name": "ASUS MODEL-A", "manufacturer": "ASUS", "article": "MODEL-A"}
    rules = [{"code": "socket", "label": "Сокет", "unit": None, "value_type": "string"}]
    retail_source = "https://www.dns-shop.kz/product/model-a/"
    payload = _payload(official_unavailable=True, values=[
        {"code": "socket", "value": "AM5", "source_url": retail_source}])
    response = _official_response(payload)
    response["output"][0]["content"][0]["annotations"].append(
        {"type": "url_citation", "url": retail_source})
    monkeypatch.setattr(product_research, "openai_request", lambda *args: response)
    result = product_research.research_product("secret", "model", product, "Материнские платы", rules)
    assert result["source_tier"] == "retailer"
    payload["official_unavailable"] = False
    response = _official_response(payload)
    response["output"][0]["content"][0]["annotations"].append(
        {"type": "url_citation", "url": retail_source})
    monkeypatch.setattr(product_research, "openai_request", lambda *args: response)
    with pytest.raises(HTTPException, match="Источник свойства не подтверждён"):
        product_research.research_product("secret", "model", product, "Материнские платы", rules)


def test_manual_retail_source_label_accepts_only_approved_https_domains():
    source = "https://www.dns-shop.kz/product/model-a/"
    value = ProductAttributeInput(value_state="known", value="AM5",
                                  source_kind="retailer_site", source_url=source)
    assert value.source_url == source
    for bad in ("http://dns-shop.kz/product/model-a/",
                "https://dns-shop.kz.example.test/product/model-a/"):
        with pytest.raises(ValueError, match="разрешены только"):
            ProductAttributeInput(value_state="known", value="AM5",
                                  source_kind="retailer_site", source_url=bad)


def _ready(catalog_client):
    client, db = catalog_client
    _, category, alpha = seed(db)
    alpha.manufacturer = "ASUS"
    alpha.manufacturer_article = "MODEL-A"
    db.add(AIProviderSetting(organization_id=1, provider="openai", encrypted_api_key="cipher", model_id="test-model"))
    db.commit()
    headers = csrf(client)
    created = client.post(f"/api/v1/admin/properties/categories/{category.id}/rules",
        json={"code": "socket", "label": "Сокет", "source": "internal", "level": "recommended"}, headers=headers)
    assert created.status_code == 200, created.text
    checked = client.post(f"/api/v1/admin/properties/categories/{category.id}/check", headers=headers)
    assert checked.status_code == 200 and checked.json()["ai_load_allowed"] is True
    return client, db, category, alpha, headers


def test_loader_zero_one_race_retry_and_log(catalog_client, monkeypatch):
    client, db, category, alpha, headers = _ready(catalog_client)
    monkeypatch.setattr(product_loader, "decrypt_key", lambda _: "secret")
    factory = sessionmaker(bind=db.bind, autoflush=False)
    # One already-filled property makes this product ineligible.
    denied = client.post(f"/api/v1/admin/properties/products/{alpha.id}/load", headers=headers)
    assert denied.status_code == 409
    beta = db.scalar(select(Product).where(Product.sku == "p1:2"))
    beta.manufacturer, beta.manufacturer_article = "ASUS", "MODEL-A"
    db.commit()
    queued = client.post(f"/api/v1/admin/properties/products/{beta.id}/load", headers=headers)
    assert queued.status_code == 200, queued.text
    job_id = queued.json()["id"]
    monkeypatch.setattr(product_loader, "research_product", lambda *args: {"values": [{"code": "socket", "value": "AM5", "source_url": SOURCE}]})
    assert product_loader.process_one(factory) is True
    db.expire_all()
    assert client.get(f"/api/v1/admin/properties/jobs/{job_id}").json()["completed"] == 1
    stored = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == beta.id))
    assert stored.value_string == "AM5" and stored.source_url == SOURCE
    assert db.scalar(select(AuditLog).where(AuditLog.action == "properties.ai_load_completed"))
    assert any(item["action"] == "properties.ai_load_completed" for item in client.get("/api/v1/admin/logs").json()["items"])

    # A queued request loses the race to a manual edit: no AI values are written.
    other = Product(source_id=beta.source_id, sku="p1:extra", name="ASUS MODEL-A",
                    manufacturer="ASUS", manufacturer_article="MODEL-A", currency="KZT",
                    status="active", raw_data={})
    other.categories.append(category)
    db.add(other); db.commit()
    queued = client.post(f"/api/v1/admin/properties/products/{other.id}/load", headers=headers)
    assert queued.status_code == 200
    attr_id = stored.attribute_id
    db.add(ProductAttribute(product_id=other.id, attribute_id=attr_id, value_string="AM4"))
    db.commit()
    product_loader.process_one(factory)
    db.expire_all()
    item = db.scalar(select(JobItem).where(JobItem.job_id == queued.json()["id"]))
    assert item.status == "skipped" and "уже содержит" in item.details["reason"]
    assert len(list(db.scalars(select(ProductAttribute).where(ProductAttribute.product_id == other.id)))) == 1

    # Transient provider failure is retried, then logged as a failure.
    retry = Product(source_id=beta.source_id, sku="p1:retry", name="ASUS MODEL-A",
                    manufacturer="ASUS", manufacturer_article="MODEL-A", currency="KZT",
                    status="active", raw_data={})
    retry.categories.append(category)
    db.add(retry); db.commit()
    queued = client.post(f"/api/v1/admin/properties/products/{retry.id}/load", headers=headers)
    assert queued.status_code == 200
    def timeout(*args):
        raise HTTPException(504, "OpenAI не ответил")
    monkeypatch.setattr(product_loader, "research_product", timeout)
    for attempt in range(3):
        product_loader.process_one(factory)
        db.expire_all()
        item = db.scalar(select(JobItem).where(JobItem.job_id == queued.json()["id"]))
        assert item.status == ("queued" if attempt < 2 else "failed")
    assert db.scalar(select(AuditLog).where(AuditLog.action == "properties.ai_load_failed"))


def test_loader_marks_approved_retail_values(catalog_client, monkeypatch):
    client, db, category, _, headers = _ready(catalog_client)
    beta = db.scalar(select(Product).where(Product.sku == "p1:2"))
    beta.manufacturer, beta.manufacturer_article = "ASUS", "MODEL-A"
    db.commit()
    queued = client.post(f"/api/v1/admin/properties/products/{beta.id}/load", headers=headers)
    assert queued.status_code == 200
    source = "https://www.dns-shop.kz/product/model-a/"
    monkeypatch.setattr(product_loader, "decrypt_key", lambda _: "secret")
    monkeypatch.setattr(product_loader, "research_product", lambda *args: {
        "source_url": SOURCE,
        "values": [{"code": "socket", "value": "AM5", "source_url": source}]})
    assert product_loader.process_one(sessionmaker(bind=db.bind, autoflush=False)) is True
    db.expire_all()
    stored = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == beta.id))
    assert stored.value_string == "AM5"
    assert stored.source_kind == "retailer_site" and stored.source_url == source


def test_loader_rechecks_manual_change_and_all_or_nothing(catalog_client, monkeypatch):
    client, db, category, _, headers = _ready(catalog_client)
    monkeypatch.setattr(product_loader, "decrypt_key", lambda _: "secret")
    factory = sessionmaker(bind=db.bind, autoflush=False)
    beta = db.scalar(select(Product).where(Product.sku == "p1:2"))
    beta.manufacturer, beta.manufacturer_article = "ASUS", "MODEL-A"
    db.commit()
    queued = client.post(f"/api/v1/admin/properties/products/{beta.id}/load", headers=headers)
    assert queued.status_code == 200
    socket = db.scalar(select(Attribute).where(Attribute.code == "socket"))

    def manual_edit(*args):
        with factory() as concurrent:
            concurrent.add(ProductAttribute(product_id=beta.id, attribute_id=socket.id, value_string="AM4"))
            concurrent.commit()
        return {"values": [{"code": "socket", "value": "AM5", "source_url": SOURCE}]}

    monkeypatch.setattr(product_loader, "research_product", manual_edit)
    product_loader.process_one(factory)
    db.expire_all()
    item = db.scalar(select(JobItem).where(JobItem.job_id == queued.json()["id"]))
    assert item.status == "skipped"
    values = list(db.scalars(select(ProductAttribute).where(ProductAttribute.product_id == beta.id)))
    assert len(values) == 1 and values[0].value_string == "AM4"

    # Invalid second value must prevent even the first valid value from saving.
    db.delete(values[0]); db.commit()
    created = client.post(f"/api/v1/admin/properties/categories/{category.id}/rules",
        json={"code": "memory_slots", "label": "Слоты памяти", "source": "internal",
              "level": "recommended", "value_type": "integer"}, headers=headers)
    assert created.status_code == 200
    assert client.post(f"/api/v1/admin/properties/categories/{category.id}/check", headers=headers).status_code == 200
    queued = client.post(f"/api/v1/admin/properties/products/{beta.id}/load", headers=headers)
    assert queued.status_code == 200
    monkeypatch.setattr(product_loader, "research_product", lambda *args: {"values": [
        {"code": "socket", "value": "AM5", "source_url": SOURCE},
        {"code": "memory_slots", "value": "many", "source_url": SOURCE}]})
    product_loader.process_one(factory)
    db.expire_all()
    item = db.scalar(select(JobItem).where(JobItem.job_id == queued.json()["id"]))
    assert item.status == "skipped"
    assert not list(db.scalars(select(ProductAttribute).where(ProductAttribute.product_id == beta.id)))


def test_blocked_rules_cannot_be_loaded(catalog_client):
    client, db, category, _, headers = _ready(catalog_client)
    rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category.id))
    changed = {**rule.definition, "ai_blocked": True}
    assert client.patch(f"/api/v1/admin/properties/rules/{rule.id}", json=changed, headers=headers).status_code == 200
    check = client.post(f"/api/v1/admin/properties/categories/{category.id}/check", headers=headers)
    assert check.status_code == 200 and check.json()["ai_load_allowed"] is False
    assert client.post(f"/api/v1/admin/properties/categories/{category.id}/load", headers=headers).status_code == 409


def test_selected_global_fields_and_derived_description(catalog_client, monkeypatch):
    client, db, _, _, headers = _ready(catalog_client)
    ensure_defaults(db); db.commit()
    # A global rule revision changes the structure fingerprint, so check again.
    category_id = db.scalar(select(PropertyRule.category_id).where(PropertyRule.code == "socket"))
    client.post(f"/api/v1/admin/properties/categories/{category_id}/check", headers=headers)
    beta = db.scalar(select(Product).where(Product.sku == "p1:2"))
    beta.manufacturer, beta.manufacturer_article = "ASUS", "MODEL-A"
    db.commit()
    queued = client.post(f"/api/v1/admin/properties/products/{beta.id}/load", headers=headers)
    assert queued.status_code == 200, queued.text
    monkeypatch.setattr(product_loader, "decrypt_key", lambda _: "secret")
    monkeypatch.setattr(product_loader, "research_product", lambda *args: {"values": [
        {"code": "socket", "value": "AM5", "source_url": SOURCE},
        {"code": "description", "value": "Материнская плата ASUS MODEL-A с сокетом AM5.",
         "source_url": SOURCE, "derived": True},
        {"code": "image_link", "value": "https://www.asus.com/images/model-a.jpg", "source_url": SOURCE}]})
    product_loader.process_one(sessionmaker(bind=db.bind, autoflush=False))
    db.expire_all()
    assert db.get(Product, beta.id).image_url == "https://www.asus.com/images/model-a.jpg"
    description = db.scalar(select(ProductAttribute).join(Attribute).where(
        ProductAttribute.product_id == beta.id, Attribute.code == "description"))
    assert description.value_string.startswith("Материнская плата")
    assert description.source_kind == "ai_official"
    assert product_data(db, beta)["description"]["value"] == description.value_string
