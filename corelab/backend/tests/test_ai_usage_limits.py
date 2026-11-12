from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import json

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import sessionmaker

from app import ai_usage_limits as usage, dialogue_views, db as database
from app.models import AIRequestLease, AIUsageBudget, Organization
from test_catalog_views import catalog_client
from test_unified_ai import _auth


def limits(**overrides):
    return SimpleNamespace(**({'ai_requests_per_minute': 2, 'ai_requests_per_day': 3,
                              'ai_max_concurrent': 10} | overrides))


def test_budgets_survive_new_connections_minutes_and_provider_switches(catalog_client):
    _, db = catalog_client
    factory = sessionmaker(bind=db.get_bind())
    stamp = 1700000000
    for _ in range(2):
        with factory() as other:
            usage.acquire(other, 1, now=stamp, settings=limits())
    with factory() as other, pytest.raises(HTTPException) as caught:
        usage.acquire(other, 1, now=stamp, settings=limits())
    assert caught.value.detail['code'] == 'ai_rate_limit'
    assert int(caught.value.headers['Retry-After']) > 0
    with factory() as other:
        usage.acquire(other, 1, now=stamp+60, settings=limits())
    with factory() as other, pytest.raises(HTTPException) as caught:
        usage.acquire(other, 1, now=stamp+120, settings=limits())
    assert caught.value.detail['code'] == 'ai_daily_limit'
    # Another organization has its own budget; the next UTC day resets the first.
    db.add(Organization(id=2, name='Other organization')); db.commit()
    usage.acquire(db, 2, now=stamp+120, settings=limits())
    usage.acquire(db, 1, now=stamp+86400, settings=limits())


def test_concurrent_requests_share_atomic_org_limit_and_stale_leases_expire(catalog_client):
    _, db = catalog_client
    factory = sessionmaker(bind=db.get_bind())
    settings = limits(ai_requests_per_minute=30, ai_requests_per_day=50, ai_max_concurrent=2)
    def reserve(_):
        with factory() as other:
            try:
                return usage.acquire(other, 1, now=1700000000, settings=settings)
            except HTTPException as error:
                assert error.detail['code'] == 'ai_concurrency_limit'
                return None
    with ThreadPoolExecutor(max_workers=4) as pool:
        reservations = list(pool.map(reserve, range(4)))
    assert len([value for value in reservations if value]) == 2
    assert db.scalar(select(func.count()).select_from(AIRequestLease)) == 2
    assert db.get(AIUsageBudget, 1).day_count == 2
    usage.acquire(db, 1, now=1700000000+usage.LEASE_SECONDS+1, settings=settings)
    assert db.scalar(select(func.count()).select_from(AIRequestLease)) == 1


def test_failed_provider_releases_slot_without_refunding_attempt(catalog_client, monkeypatch):
    _, db = catalog_client
    factory = sessionmaker(bind=db.get_bind())
    monkeypatch.setattr(database, 'SessionLocal', factory)
    def fail():
        raise HTTPException(502, 'Provider failed')
    with pytest.raises(HTTPException):
        usage.execute(1, fail)
    assert db.scalar(select(func.count()).select_from(AIRequestLease)) == 0
    assert db.get(AIUsageBudget, 1).day_count == 1


def test_http_calls_across_modes_and_new_payloads_hit_same_budget_before_provider(catalog_client, monkeypatch):
    client, db = catalog_client
    monkeypatch.setattr(database, 'SessionLocal', sessionmaker(bind=db.get_bind()))
    monkeypatch.setattr(usage, 'get_settings', lambda: limits(ai_requests_per_minute=1))
    provider = SimpleNamespace(provider='openai', model_id='test', encrypted_api_key='cipher')
    monkeypatch.setattr(dialogue_views, '_provider', lambda *_: provider)
    calls = []
    monkeypatch.setattr(dialogue_views, '_dialogue', lambda *args: calls.append(args) or {'ok': True})
    for mode, expected in [('dialogue', 200), ('planner', 429), ('explanation', 429)]:
        body = json.dumps({'instructions': 'test', 'input': [], 'schema': {}, 'mode': mode}).encode()
        response = client.post('/api/v1/internal/ai/dialogue', content=body,
                               headers={**_auth(body), 'Content-Type': 'application/json'})
        assert response.status_code == expected
        if expected == 429:
            assert int(response.headers['Retry-After']) > 0
    assert len(calls) == 1


def test_unavailable_budget_storage_never_calls_provider(monkeypatch):
    def unavailable():
        raise RuntimeError('database unavailable')
    monkeypatch.setattr(database, 'SessionLocal', unavailable)
    with pytest.raises(RuntimeError):
        usage.execute(1, lambda: pytest.fail('must not contact provider'))
