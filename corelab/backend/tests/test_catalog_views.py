import os
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app import main
from app.db import Base, get_db
from app.models import (Attribute, AuditLog, CatalogSource, Category, Organization, Product,
                        ProductAttribute, ProductSourceLink, SupplierOffer, User)


@pytest.fixture
def catalog_client():
    source_url = os.environ.get("DATABASE_URL", "postgresql+psycopg://corelab:local@localhost/corelab")
    url = os.environ.get("TEST_DATABASE_URL", source_url.rsplit("/", 1)[0] + "/corelab_test")
    engine = create_engine(url, pool_pre_ping=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    with factory() as db:
        db.add(Organization(id=1, name='ТОО "OVER-SHOP.KZ"'))
        db.commit()
        user = User(username="catalog-test", password_hash="test", role="admin")
        db.add(user); db.commit()
        main.app.dependency_overrides[get_db] = lambda: db
        main.app.dependency_overrides[main.admin_user] = lambda: SimpleNamespace(id=user.id, organization_id=1)
        yield TestClient(main.app), db
        main.app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


def seed(db):
    core = CatalogSource(code="corelab", name="CoreLab", endpoint="local://corelab/catalog")
    supplier = CatalogSource(code="p1", name="p1", endpoint="https://example.test")
    db.add_all([core, supplier]); db.flush()
    parent = Category(source_id=core.id, source_category_id="parent", name="Комплектующие")
    db.add(parent); db.flush()
    child = Category(source_id=core.id, source_category_id="child", parent_id=parent.id,
                     name="Процессоры")
    other = Category(source_id=core.id, source_category_id="other", name="Корпуса")
    db.add_all([child, other]); db.flush()
    alpha = Product(source_id=core.id, sku="p1:1", name="Alpha", currency="KZT",
                    status="active", raw_data={}, validity_check=True)
    beta = Product(source_id=core.id, sku="p1:2", name="Beta", currency="KZT",
                   status="active", raw_data={}, validity_check=False)
    gamma = Product(source_id=core.id, sku="p1:3", name="Gamma", currency="KZT",
                    status="active", raw_data={}, validity_check=None)
    alpha.categories.append(child); beta.categories.append(child); gamma.categories.append(other)
    db.add_all([alpha, beta, gamma]); db.flush()
    attr = Attribute(code="socket", label="Сокет", value_type="string")
    db.add(attr); db.flush()
    db.add(ProductAttribute(product_id=alpha.id, attribute_id=attr.id, value_string="AM5"))
    offer = SupplierOffer(source_id=supplier.id, sku="1", raw_data={}, price=12000,
                          currency="KZT", is_current=True)
    db.add(offer); db.flush()
    db.add(ProductSourceLink(product_id=alpha.id, offer_id=offer.id))
    db.commit()
    return parent, child, alpha


def test_model_queue_is_tenant_scoped_and_read_only(catalog_client):
    client, db = catalog_client
    _, _, alpha = seed(db)
    alpha.name = 'AMD Ryzen 5 9999X'
    alpha.manufacturer = 'AMD'
    db.commit()
    db.info['organization_id'] = 1
    response = client.get('/api/v1/admin/performance-models')
    assert response.status_code == 200
    assert any(p['id'] == alpha.id for row in response.json()['items'] for p in row['products'])
    assert all(row['status'] != 'measured' for row in response.json()['items'])
    db.info['organization_id'] = 2
    other = client.get('/api/v1/admin/performance-models')
    assert other.status_code == 200 and other.json()['items'] == []
    db.info['organization_id'] = 1
    assert client.get('/api/v1/admin/performance-models?scenario=invalid').status_code == 422
    assert client.post('/api/v1/admin/performance-models', json={}).status_code == 405


def test_completeness_sort_global_order_conditions_and_pagination(catalog_client):
    from app.property_engine import RuleDefinition
    from app.property_service import attach_rule

    client, db = catalog_client
    parent, child, alpha = seed(db)
    beta = db.scalar(select(Product).where(Product.name == 'Beta'))
    gamma = db.scalar(select(Product).where(Product.name == 'Gamma'))
    capacity = attach_rule(db, child.id, RuleDefinition(
        code='test_capacity', label='Capacity', value_type='integer', minimum=0,
        level='required', required_for_selection=True))
    attach_rule(db, child.id, RuleDefinition(
        code='test_extra', label='Extra', level='conditional',
        condition={'op': 'eq', 'field': 'values.test_flag', 'value': True}))
    flag = attach_rule(db, child.id, RuleDefinition(
        code='test_flag', label='Flag', value_type='boolean', level='recommended'))
    db.flush()
    db.add_all([
        ProductAttribute(product_id=alpha.id, attribute_id=capacity.attribute_id,
                         value_number=5, value_state='known'),
        ProductAttribute(product_id=beta.id, attribute_id=capacity.attribute_id,
                         value_number=0, value_state='known'),
        ProductAttribute(product_id=alpha.id, attribute_id=flag.attribute_id,
                         value_boolean=True, value_state='known'),
        ProductAttribute(product_id=beta.id, attribute_id=flag.attribute_id,
                         value_boolean=False, value_state='known'),
    ])
    db.commit()
    path = '/api/v1/admin/catalog'
    expected = {
        'required_desc': [beta.id, alpha.id, gamma.id],
        'required_asc': [alpha.id, beta.id, gamma.id],
        'pc_required_desc': [alpha.id, beta.id, gamma.id],
        'pc_required_asc': [alpha.id, beta.id, gamma.id],
    }
    for sort, ids in expected.items():
        response = client.get(path, params={'sort': sort})
        assert response.status_code == 200
        items = response.json()['items']
        assert [item['id'] for item in items] == ids
        by_id = {item['id']: item for item in items}
        assert by_id[alpha.id]['required_value_completeness']['percent'] == 50
        assert by_id[beta.id]['required_value_completeness']['percent'] == 100
        assert by_id[gamma.id]['required_value_completeness']['percent'] is None
        for page, product_id in enumerate(ids, 1):
            result = client.get(path, params={'sort': sort, 'page_size': 1, 'page': page}).json()
            assert result['total'] == 3
            assert result['items'] == [by_id[product_id]]
        assert client.get(path, params={'sort': sort, 'page': 10}).json()['items'] == []
    filtered = client.get(path, params={'sort': 'required_desc', 'category_id': parent.id}).json()
    assert [item['id'] for item in filtered['items']] == [beta.id, alpha.id]
    assert client.get(path, params={'sort': 'required_desc', 'q': 'missing'}).json()['items'] == []


@pytest.mark.parametrize('state,value,expected', [
    ('known', False, 100), ('unknown', False, 0), ('not_applicable', False, 0),
])
def test_completeness_sort_preserves_value_state(catalog_client, state, value, expected):
    from app.property_engine import RuleDefinition
    from app.property_service import attach_rule

    client, db = catalog_client
    _, child, alpha = seed(db)
    rule = attach_rule(db, child.id, RuleDefinition(
        code='test_boolean', label='Boolean', value_type='boolean',
        level='required', required_for_selection=True))
    db.flush()
    db.add(ProductAttribute(product_id=alpha.id, attribute_id=rule.attribute_id,
                            value_boolean=value, value_state=state))
    db.commit()
    for sort in ('required_desc', 'pc_required_desc'):
        result = client.get('/api/v1/admin/catalog', params={'sort': sort, 'q': 'Alpha'}).json()
        assert result['items'][0]['required_value_completeness']['percent'] == expected
        assert result['items'][0]['pc_selection_completeness']['percent'] == expected


def test_category_tree_counts_independent_toggle_and_csrf(catalog_client):
    client, db = catalog_client
    parent, child, _ = seed(db)
    response = client.get("/api/v1/admin/catalog/categories")
    assert response.status_code == 200
    by_id = {item["id"]: item for item in response.json()["items"]}
    assert by_id[child.id]["parent_id"] == parent.id
    assert (by_id[child.id]["valid"], by_id[child.id]["total"]) == (1, 2)
    assert client.patch(f"/api/v1/admin/catalog/categories/{parent.id}",
                        json={"selection_category": True}).status_code == 403
    client.cookies.set("corelab_csrf", "catalog-test")
    response = client.patch(f"/api/v1/admin/catalog/categories/{parent.id}",
                            json={"selection_category": True},
                            headers={"X-CSRF-Token": "catalog-test"})
    assert response.status_code == 200
    reloaded = {item["id"]: item for item in client.get("/api/v1/admin/catalog/categories").json()["items"]}
    assert reloaded[parent.id]["selection_category"] is True
    assert reloaded[child.id]["selection_category"] is False
    log = db.scalar(select(AuditLog))
    assert log.user_id is not None and log.details == {"old": False, "selection_category": True}


def test_build_requirement_is_independent_and_audited(catalog_client):
    client, db = catalog_client
    _, child, _ = seed(db)
    client.cookies.set("corelab_csrf", "catalog-test")
    h = {"X-CSRF-Token": "catalog-test"}
    url = f"/api/v1/admin/catalog/categories/{child.id}"
    assert client.patch(url, json={"required_for_build": True}, headers=h).status_code == 409
    assert client.patch(url, json={"selection_category": True}, headers=h).status_code == 200
    enabled = client.patch(url, json={"required_for_build": True}, headers=h)
    assert enabled.status_code == 200
    assert enabled.json()["required_for_build"] is True
    assert enabled.json()["selection_category"] is True
    disabled = client.patch(url, json={"required_for_build": False}, headers=h)
    assert disabled.status_code == 200
    assert disabled.json()["selection_category"] is True
    logs = list(db.scalars(select(AuditLog).where(
        AuditLog.action == "category.build_requirement_changed").order_by(AuditLog.id)))
    assert [row.details for row in logs] == [{"old": False, "new": True}, {"old": True, "new": False}]


def test_catalog_filters_sort_pagination_expand_data_and_detail(catalog_client):
    client, db = catalog_client
    parent, _, alpha = seed(db)
    path = "/api/v1/admin/catalog"
    response = client.get(path, params={"category_id": parent.id, "validity": "true"})
    assert response.status_code == 200
    assert response.json()["total"] == 1
    item = response.json()["items"][0]
    assert item["name"] == "Alpha"
    assert item["attributes"][0]["value"] == "AM5"
    assert item["current_price"] == "12000.00"
    assert client.get(path, params={"validity": "false"}).json()["items"][0]["name"] == "Beta"
    assert client.get(path, params={"validity": "null"}).json()["items"][0]["name"] == "Gamma"
    assert client.get(path, params={"q": "Alpha"}).json()["total"] == 1
    assert client.get(path, params={"sort": "price_asc"}).json()["items"][0]["name"] == "Alpha"
    assert client.get(path, params={"sort": "price_desc"}).json()["items"][0]["name"] == "Alpha"
    page = client.get(path, params={"sort": "price_desc", "page_size": 1, "page": 2}).json()
    assert page["total"] == 3 and len(page["items"]) == 1
    detail = client.get(f"{path}/{alpha.id}").json()
    assert detail["attributes"][0]["label"] == "Сокет"
    assert detail["offers"][0]["source"] == "p1"
    assert client.get(f"{path}/999999").status_code == 404
