import asyncio

from sqlalchemy import func, select

from app.models import Attribute, AuditLog, CategoryAttribute, Product, ValidationReason
from app.property_engine import RuleDefinition
from app.property_service import attach_rule
from app.validity import revalidate_category, revalidate_product
from app.validity_worker import run_worker
from test_catalog_views import catalog_client, seed


def headers(client):
    client.cookies.set("corelab_csrf", "validity-test")
    return {"X-CSRF-Token": "validity-test"}


def test_events_three_states_and_manual_exclusion(catalog_client):
    client, db = catalog_client
    _, category, product = seed(db)
    attach_rule(db, category.id, RuleDefinition(code="socket", label="Сокет", level="required", required_for_selection=True))
    db.commit()
    base = f"/api/v1/admin/catalog/{product.id}"
    assert client.post(base + "/recheck").status_code == 403
    h = headers(client)
    assert client.post(base + "/recheck", headers=h).json()["validity_check"] is None
    response = client.patch(f"/api/v1/admin/catalog/categories/{category.id}", json={"selection_category": True}, headers=h)
    assert response.status_code == 200
    assert client.get(base).json()["validity_check"] is True
    response = client.patch(base + "/attributes/socket", json={"value_state": "unknown"}, headers=h)
    assert response.status_code == 200 and response.json()["validity_check"] is False
    assert client.get(base).json()["validation_reasons"]
    client.patch(base + "/attributes/socket", json={"value_state": "known", "value": "AM5"}, headers=h)
    excluded = client.patch(base + "/selection", json={"selection_enabled": False}, headers=h)
    assert excluded.json() == {"selection_enabled": False, "validity_check": True, "validation_reasons": []}
    client.patch(f"/api/v1/admin/catalog/categories/{category.id}", json={"selection_category": False}, headers=h)
    detail = client.get(base).json()
    assert detail["validity_check"] is None and detail["selection_enabled"] is False


def test_required_property_toggle_rechecks_missing_value_without_restart(catalog_client):
    client, db = catalog_client
    _, category, product = seed(db)
    category.selection_category = True
    row = attach_rule(db, category.id, RuleDefinition(
        code="socket", label="Сокет", level="required", required_for_selection=True))
    db.commit()
    h = headers(client)
    client.patch(f"/api/v1/admin/catalog/{product.id}/attributes/socket",
                 json={"value_state": "unknown"}, headers=h)
    assert revalidate_product(db, product)["validity_check"] is False
    attach_rule(db, category.id, RuleDefinition(
        code="socket", label="Сокет", level="required", required_for_selection=False), row)
    revalidate_category(db, category.id)
    assert revalidate_product(db, product)["validity_check"] is True


def test_single_category_rules_events_and_idempotence(catalog_client):
    client, db = catalog_client
    _, category, product = seed(db)
    category.selection_category = True
    attach_rule(db, category.id, RuleDefinition(code="socket", label="Сокет", level="required", required_for_selection=True))
    db.commit()
    assert revalidate_product(db, product)["validity_check"] is True
    db.commit()
    before = db.scalar(select(func.count()).select_from(AuditLog))
    revalidate_product(db, product); db.commit()
    assert db.scalar(select(func.count()).select_from(AuditLog)) == before
    from app.models import PropertyRule
    # Recommended fields do not block selection; an unresolved applicability does.
    attach_rule(db, category.id, RuleDefinition(code="note", label="Заметка", level="recommended"))
    socket = db.scalar(select(PropertyRule).where(PropertyRule.code == "socket"))
    socket.definition = {**socket.definition, "applies_when": {"op": "eq", "field": "context.kind", "value": "desktop"}}
    assert revalidate_product(db, product)["validity_check"] is False
    db.commit()


def test_missing_structure_and_invalid_legacy_value(catalog_client):
    _, db = catalog_client
    _, category, product = seed(db)
    category.selection_category = True
    assert revalidate_product(db, product)["validity_check"] is False
    socket = db.scalar(select(Attribute).where(Attribute.code == "socket"))
    db.add(CategoryAttribute(category_id=category.id, attribute_id=socket.id, required_for_selection=True))
    assert revalidate_product(db, product)["validity_check"] is True
    attach_rule(db, category.id, RuleDefinition(code="socket", label="Сокет", level="required",
                                              required_for_selection=True, allowed_values=["AM4"]))
    assert revalidate_product(db, product)["validity_check"] is False


def test_scheduler_clock_and_retry(monkeypatch):
    from app import validity_worker
    calls, timeouts = [], []
    async def scenario():
        stop = asyncio.Event()
        def run():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("retry me")
            stop.set()
        async def fake_wait(awaitable, timeout):
            timeouts.append(timeout)
            awaitable.close()
            raise TimeoutError
        monkeypatch.setattr(validity_worker.asyncio, "wait_for", fake_wait)
        await run_worker(stop, run=run)
    asyncio.run(scenario())
    assert len(calls) == 2 and timeouts == [900, 900]


def test_single_category_worker_sweep(catalog_client, monkeypatch):
    from sqlalchemy.orm import sessionmaker
    from app import validity_worker
    _, db = catalog_client
    _, category, product = seed(db)
    category.selection_category = True
    attach_rule(db, category.id, RuleDefinition(code="socket", label="Сокет", level="required",
                                               required_for_selection=True, allowed_values=["AM4"]))
    db.commit()
    monkeypatch.setattr(validity_worker, "SessionLocal", sessionmaker(bind=db.get_bind(), autoflush=False))
    validity_worker.sweep()
    db.expire_all()
    assert product.validity_check is False
    assert db.scalar(select(ValidationReason).where(ValidationReason.product_id == product.id)) is not None
    category.selection_category = False
    db.commit()
    validity_worker.sweep()
    db.expire_all()
    assert product.validity_check is None
    assert not list(db.scalars(select(ValidationReason).where(ValidationReason.product_id == product.id)))
