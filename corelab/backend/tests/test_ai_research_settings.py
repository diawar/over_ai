from sqlalchemy import select

import json

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import sessionmaker

from app import main, settings_views
from app.ai_research import encrypt_key, decrypt_key
from app.models import AIProviderSetting, AuditLog, Attribute, CategoryStructureCheck, Organization, PropertyRule, User
from test_catalog_views import catalog_client, seed
from test_property_views import csrf


def test_ai_key_is_encrypted_and_never_returned(catalog_client, monkeypatch):
    client, db = catalog_client
    user = db.scalar(select(User))
    user.role = "chief_admin"
    db.commit()
    main.app.dependency_overrides[main.chief_admin_user] = lambda: user
    secret = "sk-test-0123456789abcdef"
    monkeypatch.setattr(settings_views, "encrypt_key", lambda value: "ciphertext:" + value)
    monkeypatch.setattr(settings_views, "decrypt_key", lambda value: value.removeprefix("ciphertext:"))
    monkeypatch.setattr(settings_views, "verify_model_access", lambda key, model: key == secret and model == "gpt-5.5")
    headers = csrf(client)
    response = client.put("/api/v1/admin/settings/openai", json={"api_key": secret, "model_id": "gpt-5.5"}, headers=headers)
    assert response.status_code == 200
    assert secret not in response.text
    stored = db.get(AIProviderSetting, (1, "openai"))
    assert stored.encrypted_api_key == "ciphertext:" + secret
    state = client.get("/api/v1/admin/settings/openai").json()
    assert state == {"provider": "OpenAI", "configured": True, "model_id": "gpt-5.5"}
    tested = client.post("/api/v1/admin/settings/openai/test", json={}, headers=headers)
    assert tested.status_code == 200
    assert secret not in tested.text
    assert all(secret not in str(log.details) for log in db.scalars(select(AuditLog)))
    assert client.delete("/api/v1/admin/settings/openai", headers=headers).json() == {"configured": False}


def test_ai_mode_disables_provider_without_deleting_credentials(catalog_client):
    from app.kimi import active_provider
    from test_unified_ai import _auth

    client, db = catalog_client
    user = db.scalar(select(User))
    user.role = "chief_admin"
    db.add(AIProviderSetting(organization_id=1, provider="openai",
                             encrypted_api_key="cipher", model_id="gpt-5.5"))
    db.commit()
    main.app.dependency_overrides[main.chief_admin_user] = lambda: user
    headers = csrf(client)
    assert active_provider(db, 1).provider == "openai"
    response = client.put("/api/v1/admin/settings/ai/mode", json={"enabled": False}, headers=headers)
    assert response.status_code == 200 and response.json() == {"enabled": False}
    db.expire_all()
    assert db.get(Organization, 1).ai_enabled is False
    assert active_provider(db, 1) is None
    assert client.get("/api/v1/admin/settings/ai/active").json() == {"provider": "openai", "enabled": False}
    assert client.get("/api/v1/internal/ai/status?organization_id=1",
                      headers=_auth(b"")).json() == {"ready": False, "provider": None}
    assert db.get(AIProviderSetting, (1, "openai")) is not None
    assert client.put("/api/v1/admin/settings/ai/mode", json={"enabled": True}, headers=headers).json() == {"enabled": True}
    assert active_provider(db, 1).provider == "openai"


def test_provider_credential_uses_authenticated_encryption():
    secret = "sk-test-key-never-store-in-plaintext"
    ciphertext = encrypt_key(secret)
    assert ciphertext != secret and secret not in ciphertext
    assert decrypt_key(ciphertext) == secret
