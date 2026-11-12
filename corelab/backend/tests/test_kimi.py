import json

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import kimi, main
from app.models import AIProviderSetting, AuditLog, User
from test_catalog_views import catalog_client
from test_property_views import csrf


def test_kimi_credentials_selection_and_deletion(catalog_client, monkeypatch):
    client, db = catalog_client
    user = db.scalar(select(User))
    user.role = "chief_admin"
    db.commit()
    main.app.dependency_overrides[main.chief_admin_user] = lambda: user
    headers = csrf(client)
    secret = "sk-kimi-test-01234567890123456789"
    for provider, model in [("openai", "gpt-5.5"), ("kimi", "kimi-k2.5")]:
        response = client.put(f"/api/v1/admin/settings/{provider}",
                              json={"api_key": secret, "model_id": model}, headers=headers)
        assert response.status_code == 200
        assert secret not in response.text
        assert secret not in db.get(AIProviderSetting, (1, provider)).encrypted_api_key
    assert client.get("/api/v1/admin/settings/ai/active").json()["provider"] == "kimi"
    assert client.get("/api/v1/admin/settings/kimi").json()["model_id"] == "kimi-k2.5"
    called = []
    monkeypatch.setattr(kimi, "verify_model_access", lambda key, model: called.append((key, model)))
    assert client.post("/api/v1/admin/settings/kimi/test", json={}, headers=headers).status_code == 200
    assert called == [(secret, "kimi-k2.5")]
    assert client.post("/api/v1/admin/settings/ai/openai/activate", json={}, headers=headers).status_code == 200
    assert kimi.active_provider(db, 1).provider == "openai"
    assert kimi.active_provider(db, 999) is None
    assert client.delete("/api/v1/admin/settings/kimi", headers=headers).status_code == 200
    assert db.get(AIProviderSetting, (1, "openai")) is not None
    assert all(secret not in str(log.details) for log in db.scalars(select(AuditLog)))


def test_kimi_write_requires_chief_and_csrf(catalog_client):
    client, db = catalog_client
    user = db.scalar(select(User))
    main.app.dependency_overrides[main.admin_user] = lambda: user
    assert client.put("/api/v1/admin/settings/kimi", json={
        "api_key": "sk-test-01234567890123456789", "model_id": "kimi-k2.5",
    }).status_code in (401, 403)
    assert client.post("/api/v1/admin/settings/ai/kimi/activate", json={}, headers=csrf(client)).status_code in (401, 403)


def test_kimi_errors_do_not_expose_credentials(monkeypatch):
    monkeypatch.setattr(kimi.httpx, "request", lambda *a, **k: httpx.Response(401, text="secret-key"))
    with pytest.raises(HTTPException) as error:
        kimi.request("secret-key", "/models", method="GET")
    assert "secret-key" not in error.value.detail


def test_kimi_model_access_checks_requested_id(monkeypatch):
    monkeypatch.setattr(kimi, "request", lambda *a, **k: {"data": [{"id": "kimi-k2.5"}]})
    assert kimi.verify_model_access("secret", "kimi-k2.5")
    with pytest.raises(HTTPException):
        kimi.verify_model_access("secret", "unknown")
