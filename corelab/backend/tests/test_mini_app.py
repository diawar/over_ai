import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlencode
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app import main
from app.config import get_settings
from app.db import Base, get_db
from app.mini_auth import Consumer, issue_consumer, serializer
from app.models import (Organization, CatalogSource, Category, Product, Attribute,
                        ProductAttribute, SupplierOffer, ProductSourceLink, User)

BOT = "123456:test-token-for-signature-only"


@pytest.mark.parametrize("endpoint", ["availability", "products"])
def test_internal_builder_rejects_disabled_or_missing_organization(api, endpoint):
    client, factory = api
    for org_id in (3, 99999):
        value = f"corelab-builder-products-v1:{org_id}"
        signature = hmac.new(get_settings().session_secret.encode(), value.encode(), hashlib.sha256).hexdigest()
        response = client.get(f"/api/v1/internal/builder/{endpoint}?organization_id={org_id}",
                              headers={"X-CoreLab-Builder-Auth": signature})
        assert response.status_code == 404


def test_mini_app_catalog_screen_is_served_without_catalog_data():
    client = TestClient(main.app)
    page = client.get("/catalog-preview/")
    assert page.status_code == 200
    assert 'id="products"' in page.text
    assert 'type="module" src="./app.mjs"' in page.text
    assert client.get("/catalog-preview/app.mjs").status_code == 200
    assert client.get("/catalog-preview/catalog-client.mjs").status_code == 200
    assert "item-" not in page.text


def init_data(start=None, age=0, token=BOT):
    values = {"auth_date": str(int(time.time())-age), "user": json.dumps({"id": 123}, separators=(",", ":"))}
    if start is not None:
        values["start_param"] = start
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    values["hash"] = hmac.new(secret, "\n".join(f"{k}={v}" for k, v in sorted(values.items())).encode(), hashlib.sha256).hexdigest()
    return urlencode(values)


@pytest.fixture(scope="module")
def engine():
    source = make_url(os.environ["DATABASE_URL"])
    url = source.set(database="corelab_stage11_test")
    admin = create_engine(source.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        if not connection.scalar(text("SELECT 1 FROM pg_database WHERE datname='corelab_stage11_test'")):
            connection.execute(text("CREATE DATABASE corelab_stage11_test"))
    admin.dispose()
    engine = create_engine(url)
    yield engine
    engine.dispose()


@pytest.fixture
def api(engine, monkeypatch):
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    def database():
        with factory() as db:
            yield db
    main.app.dependency_overrides[get_db] = database
    monkeypatch.setattr(get_settings(), "telegram_bots_json", SecretStr(json.dumps({
        "corelab": {"token": BOT}, "shopbot": {"token": BOT, "organization_id": 1}})))
    with factory() as db:
        db.add_all([Organization(id=1, name="Shop One", short_name="One", mini_app_enabled=True),
                    Organization(id=2, name="Shop Two", mini_app_enabled=True),
                    Organization(id=3, name="Private", mini_app_enabled=False)])
        db.commit()
        for org in (1, 2):
            source = CatalogSource(organization_id=org, code="corelab", name="Catalog", endpoint="local://catalog")
            supplier = CatalogSource(organization_id=org, code="p1", name="Supplier", endpoint="local://snapshot")
            db.add_all([source, supplier]); db.flush()
            category = Category(organization_id=org, source_id=source.id, source_category_id="cpu", name="Processors", selection_category=True)
            attr = Attribute(organization_id=org, code="cores", label="Cores", value_type="integer", unit=None)
            db.add_all([category, attr]); db.flush()
            for index in range(2):
                product = Product(organization_id=org, source_id=source.id, sku=f"item-{index}", name=f"Item {org}-{index}",
                    raw_data={}, price=99999, validity_check=True, selection_enabled=True, categories=[category])
                db.add(product); db.flush()
                db.add(ProductAttribute(organization_id=org, product_id=product.id, attribute_id=attr.id, value_number=8))
                for current, price in [(True, 1200), (False, 1)]:
                    offer = SupplierOffer(organization_id=org, source_id=supplier.id, sku=f"{index}-{current}",
                        raw_data={"dealersData": ["Store (2)"]}, price=price, is_current=current, currency="KZT")
                    db.add(offer); db.flush()
                    db.add(ProductSourceLink(organization_id=org, product_id=product.id, offer_id=offer.id))
        db.commit()
    yield TestClient(main.app), factory
    main.app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


def login(client, start="shop_1", **kwargs):
    result = client.post("/api/v1/mini-app/session", json={"init_data": init_data(start), **kwargs})
    assert result.status_code == 200, result.text
    return {"Authorization": "Bearer " + result.json()["access_token"]}


def test_builder_feed_is_tenant_scoped(api):
    client, _ = api
    endpoint = "/api/v1/internal/builder/products?organization_id=2"
    wrong_signature = hmac.new(get_settings().session_secret.encode(),
                               b"corelab-builder-products-v1", hashlib.sha256).hexdigest()
    assert client.get(endpoint, headers={"X-CoreLab-Builder-Auth": wrong_signature}).status_code == 403
    signature = hmac.new(get_settings().session_secret.encode(),
                         b"corelab-builder-products-v1:2", hashlib.sha256).hexdigest()
    response = client.get(endpoint, headers={"X-CoreLab-Builder-Auth": signature})
    assert response.status_code == 200, response.text
    feed = response.json()
    assert feed["organization"]["id"] == 2
    assert {item["name"] for item in feed["items"]} == {"Item 2-0", "Item 2-1"}


def test_internal_builder_products_use_current_catalog_and_offers(api):
    client, factory = api
    endpoint = "/api/v1/internal/builder/products"
    assert client.get(endpoint).status_code == 403
    signature = hmac.new(get_settings().session_secret.encode(),
                         b"corelab-builder-products-v1", hashlib.sha256).hexdigest()
    headers = {"X-CoreLab-Builder-Auth": signature}
    first_feed = client.get(endpoint, headers=headers).json()
    assert len(first_feed["rulesVersion"]) == 64
    with factory() as db:
        product = db.scalar(select(Product).where(Product.organization_id == 1, Product.sku == "item-0"))
        category = product.categories[0]
        category.required_for_build = True
        required_category = category.name
        db.commit()
    changed_feed = client.get(endpoint, headers=headers).json()
    assert changed_feed["rulesVersion"] != first_feed["rulesVersion"]
    assert next(row for row in changed_feed["rules"] if row["category"] == required_category)["required"] is True
    with factory() as db:
        product = db.scalar(select(Product).where(Product.organization_id == 1, Product.sku == "item-0"))
        product.sku = "p1:55398"
        product.validity_check = False
        db.commit()
    assert not any(item["skuOver"] == "55398" for item in client.get(endpoint, headers=headers).json()["items"])
    with factory() as db:
        product = db.scalar(select(Product).where(Product.organization_id == 1, Product.sku == "p1:55398"))
        product.validity_check = True
        db.commit()
    item = next(item for item in client.get(endpoint, headers=headers).json()["items"] if item["skuOver"] == "55398")
    assert item["name"] == "Item 1-0"
    assert item["offers"] == [{"price": "1200.00", "dealersData": ["Store (2)"]}]
    assert item["attributes"] == {"cores": 8}
    with factory() as db:
        product = db.scalar(select(Product).where(Product.organization_id == 1, Product.sku == "p1:55398"))
        offer = db.scalar(select(SupplierOffer).join(ProductSourceLink, ProductSourceLink.offer_id == SupplierOffer.id).where(
            ProductSourceLink.product_id == product.id, SupplierOffer.is_current.is_(True)))
        product.name = "Updated CoreLab name"
        offer.price = 1300
        offer.raw_data = {"dealersData": ["Store (3)"]}
        value = db.scalar(select(ProductAttribute).where(ProductAttribute.product_id == product.id))
        value.value_number = 10
        db.commit()
    updated = next(item for item in client.get(endpoint, headers=headers).json()["items"] if item["skuOver"] == "55398")
    assert updated["name"] == "Updated CoreLab name"
    assert updated["offers"] == [{"price": "1300.00", "dealersData": ["Store (3)"]}]
    assert updated["attributes"] == {"cores": 10}


@pytest.mark.parametrize("case", ["malformed", "expired", "future", "wrong_token", "duplicate_date"])
def test_bad_telegram_auth(api, case):
    # Build timestamps when the test runs, not during collection: a long suite
    # otherwise turns a future timestamp into a valid current timestamp.
    data = {"malformed": lambda: "bad", "expired": lambda: init_data(age=500),
            "future": lambda: init_data(age=-60), "wrong_token": lambda: init_data(token="wrong"),
            "duplicate_date": lambda: init_data()+"&auth_date=1"}[case]()
    client, _ = api
    assert client.post("/api/v1/mini-app/session", json={"init_data": data}).status_code == 401


def test_launch_priority_campaign_and_chooser(api):
    client, _ = api
    result = client.post("/api/v1/mini-app/session", json={"init_data": init_data("shop_2_c_summer"), "remembered_organization_id": 1})
    assert result.json()["organization"]["id"] == 2
    assert result.json()["campaign"] == "summer"
    headers = login(client, start=None)
    assert client.get("/api/v1/products", headers=headers).status_code == 403
    assert [s["id"] for s in client.get("/api/v1/mini-app/organizations", headers=headers).json()["items"]] == [1, 2]
    selected = client.post("/api/v1/mini-app/organization", headers=headers, json={"organization_id": 2})
    assert selected.json()["organization"]["id"] == 2
    remembered = client.post("/api/v1/mini-app/session", json={"init_data": init_data(), "remembered_organization_id": 1})
    assert remembered.json()["organization"]["id"] == 1


def test_unavailable_links_never_fall_back(api):
    client, _ = api
    for start in ("shop_3", "shop_999", "garbage"):
        result = client.post("/api/v1/mini-app/session", json={"init_data": init_data(start), "remembered_organization_id": 1})
        assert result.status_code == 200
        assert result.json()["organization"] is None
        assert result.json()["launch_error"] in ("shop_unavailable", "invalid_shop_link")
        headers = {"Authorization": "Bearer " + result.json()["access_token"]}
        assert client.get("/api/v1/products", headers=headers).status_code == 403
        assert client.get("/api/v1/mini-app/organizations", headers=headers).json()["total"] == 2


def test_custom_bot_bound_to_shop(api):
    client, _ = api
    headers = login(client, start=None, bot="shopbot", remembered_organization_id=2)
    assert client.get("/api/v1/mini-app/context", headers=headers).json()["organization"]["id"] == 1
    assert client.post("/api/v1/mini-app/organization", headers=headers, json={"organization_id": 2}).status_code == 403
    assert client.post("/api/v1/mini-app/session", json={"bot": "shopbot", "init_data": init_data("shop_2")}).status_code == 403


def test_typed_catalog_isolation_prices_pagination_and_no_raw_data(api):
    client, _ = api
    headers = login(client)
    result = client.get("/api/v1/products?page_size=1", headers=headers)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["total"] == 2 and body["schema_version"] == "1"
    item = body["items"][0]
    assert item["organization_id"] == 1 and item["price"] == "1200.00"
    assert item["attributes"][0]["value"] == 8 and type(item["attributes"][0]["value"]) is int
    assert len(item["offers"]) == 1 and item["offers"][0]["warehouses"] == ["Store (2)"]
    assert "raw_data" not in item
    second = client.get("/api/v1/products?page_size=1&page=2", headers=headers).json()["items"][0]
    assert second["id"] != item["id"]
    assert client.get(f"/api/v1/products/{item['id']}", headers=headers).json() == item
    assert client.get("/api/v1/selection/products", headers=headers).json()["total"] == 2
    assert client.get("/api/v1/categories", headers=headers).json()["total"] == 1
    foreign = client.get("/api/v1/products", headers=login(client, "shop_2")).json()["items"][0]
    assert client.get(f"/api/v1/products/{foreign['id']}", headers=headers).status_code == 404
    assert client.get("/api/v1/products?page_size=101", headers=headers).status_code == 422


@pytest.mark.parametrize("change", ["false", "null", "excluded", "category", "no_attributes", "unknown"])
def test_all_endpoints_hide_ineligible_products(api, change):
    client, factory = api
    with factory() as db:
        rows = list(db.scalars(select(Product).where(Product.organization_id == 1)))
        ids = [p.id for p in rows]
        for p in rows:
            if change in ("false", "null"):
                p.validity_check = False if change == "false" else None
            elif change == "excluded":
                p.selection_enabled = False
            elif change == "category":
                p.categories[0].selection_category = False
            else:
                for attr in db.scalars(select(ProductAttribute).where(ProductAttribute.product_id == p.id)):
                    if change == "no_attributes": db.delete(attr)
                    else: attr.value_state = "unknown"
        db.commit()
    headers = login(client)
    for path in ("/api/v1/products", "/api/v1/selection/products", "/api/v1/categories"):
        assert client.get(path, headers=headers).json()["total"] == 0
    for pid in ids:
        assert client.get(f"/api/v1/products/{pid}", headers=headers).status_code == 404


def test_auth_scope_tampering_and_no_write(api):
    client, _ = api
    assert client.get("/api/v1/products").status_code == 401
    headers = login(client)
    assert client.get("/api/v1/admin/catalog", headers=headers).status_code == 401
    assert client.post("/api/v1/products", headers=headers, json={}).status_code == 405
    assert client.patch("/api/v1/products/1", headers=headers, json={}).status_code == 405
    bad = {"Authorization": headers["Authorization"]+"bad"}
    assert client.get("/api/v1/products", headers=bad).status_code == 401
    forbidden = issue_consumer(Consumer(bot="corelab", organization_id=1, scope="other"))
    assert client.get("/api/v1/products", headers={"Authorization": "Bearer "+forbidden["access_token"]}).status_code == 403


def test_openapi_contract(api):
    client, _ = api
    schema = client.get("/openapi.json").json()
    for path in ("/api/v1/products", "/api/v1/products/{product_id}", "/api/v1/categories", "/api/v1/selection/products"):
        assert set(schema["paths"][path]) == {"get"}
        assert schema["paths"][path]["get"]["security"] == [{"MiniAppSession": []}]
        assert "$ref" in schema["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert schema["components"]["schemas"]["PropertyView"]["properties"]["value_type"]["type"] == "string"


def test_preview_requires_admin_csrf_and_stays_in_org(api):
    client, _ = api
    assert client.post("/api/v1/admin/mini-app/preview").status_code in (401, 403)
    main.app.dependency_overrides[main.admin_user] = lambda: SimpleNamespace(id=1, organization_id=1)
    assert client.post("/api/v1/admin/mini-app/preview").status_code == 403
    client.cookies.set("corelab_csrf", "test")
    result = client.post("/api/v1/admin/mini-app/preview", headers={"X-CSRF-Token": "test"})
    assert result.status_code == 200
    headers = {"Authorization": "Bearer "+result.json()["access_token"]}
    assert client.get("/api/v1/products", headers=headers).json()["total"] == 2
    assert client.post("/api/v1/mini-app/organization", headers=headers, json={"organization_id": 2}).status_code == 403


def test_typed_values_empty_json_and_missing_current_prices(api):
    client, factory = api
    with factory() as db:
        product = db.scalar(select(Product).where(Product.organization_id == 1))
        for code, kind, values in [("igpu", "boolean", {"value_boolean": False}),
                                  ("power", "number", {"value_number": 65.25}),
                                  ("ram", "list", {"value_json": ["DDR4", "DDR5"]})]:
            attr = Attribute(organization_id=1, code=code, label=code, value_type=kind)
            db.add(attr); db.flush()
            db.add(ProductAttribute(organization_id=1, product_id=product.id, attribute_id=attr.id, **values))
        for offer in db.scalars(select(SupplierOffer).where(SupplierOffer.organization_id == 1)):
            offer.is_current = False
        db.commit(); pid = product.id
    headers = login(client)
    result = client.get(f"/api/v1/products/{pid}", headers=headers).json()
    values = {p["code"]: p["value"] for p in result["attributes"]}
    assert values["igpu"] is False and values["power"] == 65.25 and values["ram"] == ["DDR4", "DDR5"]
    assert result["price"] is None and result["offers"] == []
    with factory() as db:
        for row in db.scalars(select(ProductAttribute).where(ProductAttribute.product_id == pid)):
            row.value_number = None; row.value_boolean = None; row.value_json = []; row.value_string = None
        db.commit()
    assert client.get(f"/api/v1/products/{pid}", headers=headers).status_code == 404


def test_chief_can_disable_shop_and_revoke_active_consumer_access(api):
    client, factory = api
    headers = login(client)
    with factory() as db:
        user = User(organization_id=1, username="chief", password_hash="unused", role="chief_admin")
        db.add(user); db.commit(); uid = user.id
    principal = SimpleNamespace(id=uid, organization_id=1, role="admin")
    main.app.dependency_overrides[main.admin_user] = lambda: principal
    client.cookies.set("corelab_csrf", "test")
    csrf = {"X-CSRF-Token": "test"}
    assert client.put("/api/v1/admin/mini-app/settings", headers=csrf, json={"enabled": False}).status_code == 403
    principal.role = "chief_admin"
    assert client.put("/api/v1/admin/mini-app/settings", headers=csrf, json={"enabled": False}).status_code == 200
    assert client.get("/api/v1/products", headers=headers).status_code == 404
