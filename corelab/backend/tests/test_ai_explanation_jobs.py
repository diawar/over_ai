import asyncio
import json
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import ai_explanation_jobs as jobs, dialogue_views as views
from app.models import AIExplanationReceipt

KEY = "a" * 64


@pytest.fixture
def sessions(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'receipts.db'}")
    AIExplanationReceipt.__table__.create(engine)
    yield sessionmaker(bind=engine)
    engine.dispose()


def test_concurrent_reservation_runs_once_and_is_tenant_scoped(sessions):
    barrier = threading.Barrier(2)
    results = []
    def reserve():
        with sessions() as db:
            barrier.wait()
            results.append(jobs.reserve(db, 1, KEY, "digest"))
    threads = [threading.Thread(target=reserve) for _ in range(2)]
    for thread in threads: thread.start()
    for thread in threads: thread.join()
    assert sorted(results) == [False, True]
    with sessions() as db:
        with pytest.raises(HTTPException) as error:
            jobs.read(db, 2, KEY)
        assert error.value.status_code == 404
        assert jobs.reserve(db, 2, KEY, "digest") is True


def test_result_survives_new_session_and_different_content_is_rejected(sessions):
    with sessions() as db:
        assert jobs.reserve(db, 1, KEY, "digest")
    jobs.execute(1, KEY, lambda: {"answer": "saved"}, sessions)
    with sessions() as db:
        assert jobs.read(db, 1, KEY)["result"] == {"answer": "saved"}
        assert jobs.reserve(db, 1, KEY, "digest") is False
        with pytest.raises(HTTPException) as error:
            jobs.reserve(db, 1, KEY, "different")
        assert error.value.status_code == 409


def test_cancelled_waiter_does_not_cancel_generation(sessions, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original_execute = jobs.execute
    monkeypatch.setattr(jobs, "execute", lambda org, key, generate: original_execute(org, key, generate, sessions))
    with sessions() as db:
        jobs.reserve(db, 1, KEY, "digest")
    def generate():
        entered.set()
        assert release.wait(5)
        return {"answer": "after disconnect"}
    async def scenario():
        async def waiter():
            jobs.start(1, KEY, generate)
            await asyncio.sleep(100)
        task = asyncio.create_task(waiter())
        while not entered.is_set(): await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        release.set()
        await asyncio.gather(*list(jobs._tasks))
    asyncio.run(scenario())
    with sessions() as db:
        assert jobs.read(db, 1, KEY)["result"]["answer"] == "after disconnect"


@pytest.mark.parametrize("exception,code", [
    (HTTPException(504, "private secret"), "ai_http_504"),
    (RuntimeError("private secret"), "ai_explanation_failed"),
])
def test_failure_is_persisted_without_retry_or_secrets(sessions, caplog, exception, code):
    with sessions() as db: jobs.reserve(db, 1, KEY, "digest")
    def generate(): raise exception
    jobs.execute(1, KEY, generate, sessions)
    with sessions() as db:
        assert jobs.read(db, 1, KEY)["error"] == code
        assert jobs.reserve(db, 1, KEY, "digest") is False
    assert "private" not in caplog.text


def test_interrupted_and_expired_receipts_never_regenerate(sessions, monkeypatch):
    monkeypatch.setattr(jobs.time, "time", lambda: 1000)
    with sessions() as db: jobs.reserve(db, 1, KEY, "digest")
    monkeypatch.setattr(jobs.time, "time", lambda: 1601)
    with sessions() as db:
        assert jobs.read(db, 1, KEY)["error"] == "ai_explanation_interrupted"
        assert jobs.reserve(db, 1, KEY, "digest") is False
        jobs.reserve(db, 2, KEY, "digest")
    jobs.execute(2, KEY, lambda: {"answer": "saved"}, sessions)
    monkeypatch.setattr(jobs.time, "time", lambda: 1602 + jobs.RESULT_RETENTION_SECONDS)
    with sessions() as db:
        assert jobs.read(db, 2, KEY)["error"] == "ai_explanation_expired"
        assert db.get(AIExplanationReceipt, (2, KEY)).result is None
        assert jobs.reserve(db, 2, KEY, "digest") is False


def test_expired_queued_task_does_not_start_paid_generation(sessions, monkeypatch):
    monkeypatch.setattr(jobs.time, "time", lambda: 1000)
    with sessions() as db: jobs.reserve(db, 1, KEY, "digest")
    monkeypatch.setattr(jobs.time, "time", lambda: 1601)
    jobs.execute(1, KEY, lambda: pytest.fail("must not invoke provider"), sessions)
    with sessions() as db:
        assert jobs.read(db, 1, KEY)["error"] == "ai_explanation_interrupted"


def test_receipt_signature_cannot_be_reused_for_another_org_or_id(monkeypatch):
    import hashlib
    import hmac
    import time
    monkeypatch.setattr(views, "get_settings", lambda: SimpleNamespace(session_secret="test"))
    body = ("explanation:" + KEY).encode()
    stamp = str(int(time.time()))
    digest = hashlib.sha256(body).hexdigest()
    signature = hmac.new(b"test", f"{stamp}:1:{digest}".encode(), hashlib.sha256).hexdigest()
    request = SimpleNamespace(headers={"X-CoreLab-AI-Timestamp": stamp, "X-CoreLab-AI-Auth": signature})
    views._authenticated(request, 1, body)
    for org, data in [(2, body), (1, ("explanation:" + "b" * 64).encode())]:
        with pytest.raises(HTTPException) as error: views._authenticated(request, org, data)
        assert error.value.status_code == 403


def test_route_submits_once_and_returns_existing_receipt(sessions, monkeypatch):
    monkeypatch.setattr(views, "_authenticated", lambda *args: None)
    monkeypatch.setattr(views, "_provider", lambda *args: SimpleNamespace(provider="openai", model_id="test", encrypted_api_key="private"))
    starts = []
    monkeypatch.setattr(jobs, "start", lambda org, key, generate: starts.append((org, key)))
    endpoint = next(r.endpoint for r in views.internal_dialogue_router().routes if r.path.endswith("/dialogue"))
    body = {"instructions": "test", "input": [], "schema": {}, "mode": "explanation", "request_id": KEY}
    async def read_body(): return json.dumps(body).encode()
    for _ in range(2):
        with sessions() as db:
            response = asyncio.run(endpoint(SimpleNamespace(body=read_body), 1, db))
            assert response.status_code == 202
    assert starts == [(1, KEY)]
    jobs.execute(1, KEY, lambda: {"answer": "saved"}, sessions)
    with sessions() as db:
        response = asyncio.run(endpoint(SimpleNamespace(body=read_body), 1, db))
        assert response.status_code == 200
        assert json.loads(response.body)["result"] == {"answer": "saved"}
    assert len(starts) == 1


def test_receipt_get_checks_org_and_binds_signature_to_id(monkeypatch):
    signed = []
    monkeypatch.setattr(views, "_authenticated", lambda request, org, body: signed.append((org, body)))
    monkeypatch.setattr(jobs, "read", lambda db, org, key: {"org": org, "request_id": key})
    endpoint = next(r.endpoint for r in views.internal_dialogue_router().routes if "/explanations/" in r.path)
    org = SimpleNamespace(is_active=True, onboarding_required=False, mini_app_enabled=True)
    db = SimpleNamespace(get=lambda *args: org)
    assert endpoint(KEY, None, 2, db)["org"] == 2
    assert signed == [(2, ("explanation:" + KEY).encode())]
    org.is_active = False
    with pytest.raises(HTTPException) as error: endpoint(KEY, None, 2, db)
    assert error.value.status_code == 404
