import hashlib
import hmac
import json
import time

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import dialogue_views, main, openrouter
from app.ai_research import encrypt_key
from app.models import AIProviderSetting, Organization, User
from test_catalog_views import catalog_client
from test_property_views import csrf


@pytest.mark.parametrize("body,expected_status", [
    ({"error": {"code": "credit_balance_exhausted", "type": "insufficient_quota"}}, 402),
    ({"error": {"type": "insufficient_quota"}}, 402),
    ({"error": {"code": "organization_usage_limit_exceeded"}}, 402),
    ({"error": {"code": "rate_limit_exceeded", "type": "tokens"}}, 429),
    ({"error": {"code": "slow_down", "type": "rate_limit_error"}}, 429),
    ({"error": "unexpected"}, 429),
    ([], 429),
    (None, 429),
])
def test_openai_distinguishes_quota_from_rate_limits_without_exposing_body(monkeypatch, body, expected_status):
    import httpx
    from app import ai_research
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        body = {"error": {**body["error"], "message": "private-request-and-key"}}
    response = httpx.Response(429, json=body) if body is not None else httpx.Response(429, text="private-request-and-key")
    monkeypatch.setattr(ai_research.httpx, "request", lambda *args, **kwargs: response)
    with pytest.raises(HTTPException) as caught:
        ai_research.openai_request("private-key", {"model": "test"})
    assert caught.value.status_code == expected_status
    assert "private" not in str(caught.value.detail)


def _auth(body, organization_id=1):
    stamp = str(int(time.time()))
    digest = hashlib.sha256(body).hexdigest()
    from app.config import get_settings
    key = get_settings().session_secret.encode()
    signature = hmac.new(key, f"{stamp}:{organization_id}:{digest}".encode(), hashlib.sha256).hexdigest()
    return {"X-CoreLab-AI-Timestamp": stamp, "X-CoreLab-AI-Auth": signature}


def test_openrouter_settings_are_private_and_used_by_internal_dialogue(catalog_client, monkeypatch):
    client, db = catalog_client
    user = db.scalar(select(User))
    user.role = "chief_admin"
    db.get(Organization, 1).mini_app_enabled = True
    db.commit()
    main.app.dependency_overrides[main.chief_admin_user] = lambda: user
    key = "sk-or-test-12345678901234567890"
    headers = csrf(client)
    saved = client.put("/api/v1/admin/settings/openrouter", json={
        "api_key": key, "model_id": "moonshotai/kimi-k2.5"}, headers=headers)
    assert saved.status_code == 200
    assert key not in saved.text
    row = db.get(AIProviderSetting, (1, "openrouter"))
    assert row and key not in row.encrypted_api_key
    assert client.get("/api/v1/admin/settings/ai/active").json()["provider"] == "openrouter"
    assert client.get("/api/v1/admin/settings/openrouter").json() == {
        "provider": "OpenRouter", "configured": True, "model_id": "moonshotai/kimi-k2.5"}
    monkeypatch.setattr(openrouter, "verify_model_access", lambda secret, model: secret == key and model == row.model_id)
    assert client.post("/api/v1/admin/settings/openrouter/test", headers=headers).status_code == 200
    body = json.dumps({"instructions": "Answer", "input": [{"role": "user", "content": "hello"}],
                       "schema": {"type": "object"}}).encode()
    seen = []
    monkeypatch.setattr(dialogue_views, "_dialogue", lambda setting, *_: seen.append(setting) or {"ok": True})
    response = client.post("/api/v1/internal/ai/dialogue?organization_id=1", content=body,
                           headers={**_auth(body), "Content-Type": "application/json"})
    assert response.status_code == 200 and response.json() == {"ok": True}
    assert seen[0].provider == "openrouter" and seen[0].model_id == row.model_id
    assert key not in response.text
    assert client.post("/api/v1/internal/ai/dialogue?organization_id=1", content=body).status_code == 403
    assert client.post("/api/v1/internal/ai/dialogue?organization_id=2", content=body,
                       headers=_auth(body)).status_code == 403
    assert client.delete("/api/v1/admin/settings/openrouter", headers=headers).status_code == 200
    assert client.get("/api/v1/internal/ai/status?organization_id=1", headers=_auth(b"")).json() == {"ready": False, "provider": None}


def test_internal_dialogue_uses_selected_key_without_echoing_it(monkeypatch):
    key = "sk-hidden-12345678901234567890"
    monkeypatch.setattr(dialogue_views, "decrypt_key", lambda _: key)
    seen = []
    def fake(secret, path, payload):
        seen.append((secret, path, payload))
        return {"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"reply": "Hello", "tasksClear": False})}}]}
    monkeypatch.setattr(dialogue_views, "openrouter_request", fake)
    from types import SimpleNamespace
    answer = dialogue_views._dialogue(SimpleNamespace(provider="openrouter", model_id="moonshotai/kimi-k2.5",
                                                     encrypted_api_key="cipher"), "Instructions", [],
                                      {"type": "object", "required": ["reply", "tasksClear"],
                                       "properties": {"reply": {"type": "string"}, "tasksClear": {"type": "boolean"}}})
    assert answer == {"reply": "Hello", "tasksClear": False}
    assert seen[0][0] == key and seen[0][1] == "/chat/completions"
    assert key not in json.dumps(answer)


@pytest.mark.parametrize("model", ["kimi-k2.6", "kimi-k2-thinking"])
def test_kimi_interactive_mode_is_scoped_to_supported_model(monkeypatch, model):
    from types import SimpleNamespace
    monkeypatch.setattr(dialogue_views, "decrypt_key", lambda _: "test-secret")
    seen = []
    def fake(secret, path, payload, **kwargs):
        seen.append((payload, kwargs))
        return {"choices": [{"finish_reason": "stop", "message": {"content": '{"reply":"OK"}'}}]}
    monkeypatch.setattr(dialogue_views, "kimi_request", fake)
    output = dialogue_views._dialogue(SimpleNamespace(provider="kimi", model_id=model,
        encrypted_api_key="cipher"), "Instructions", [],
        {"type":"object", "required":["reply"], "properties":{"reply":{"type":"string"}}})
    assert output == {"reply":"OK"}
    payload, kwargs = seen[0]
    assert payload["max_tokens"] == 2400
    assert payload["response_format"] == {"type":"json_object"}
    if model == "kimi-k2.6":
        assert payload["thinking"] == {"type":"disabled"}
        assert kwargs["timeout_seconds"] == 45
    else:
        assert "thinking" not in payload
        assert kwargs == {}


def test_kimi_fast_mode_still_rejects_invalid_dialogue(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(dialogue_views, "decrypt_key", lambda _: "test-secret")
    monkeypatch.setattr(dialogue_views, "kimi_request", lambda *args, **kwargs:
        {"choices": [{"finish_reason":"stop", "message":{"content":'{"reply":null}'}}]})
    with pytest.raises(HTTPException) as caught:
        dialogue_views._dialogue(SimpleNamespace(provider="kimi", model_id="kimi-k2.6",
            encrypted_api_key="cipher"), "Instructions", [],
            {"type":"object", "required":["reply"], "properties":{"reply":{"type":"string"}}})
    assert caught.value.status_code == 502


@pytest.mark.parametrize("provider,model", [("openai", "gpt-5.5"), ("kimi", "kimi-k2.6")])
@pytest.mark.parametrize("stage", ["tasks", "initial_build", "discussion", "build_review", "build_feedback"])
def test_dialogue_stages_use_provider_specific_contracts(monkeypatch, provider, model, stage):
    from types import SimpleNamespace
    monkeypatch.setattr(dialogue_views, "decrypt_key", lambda _: "test-secret")
    answer = {"reply":"OK", "tasksClear":True}
    schema = {"type":"object", "required":["reply","tasksClear"],
              "properties":{"reply":{"type":"string"},"tasksClear":{"type":"boolean"}},
              "additionalProperties":False}
    turns = [{"role":"user", "content":json.dumps({"stage":stage,"message":"test"})}]
    def openai(secret, payload):
        assert secret == "test-secret"
        assert payload["model"] == model and payload["input"] == turns
        assert payload["store"] is False
        assert payload["text"]["format"]["strict"] is True
        assert payload["text"]["format"]["schema"] == schema
        assert "thinking" not in payload
        return {"status":"completed", "output":[{"type":"message","content":[
            {"type":"output_text","text":json.dumps(answer)}]}]}
    def kimi(secret, path, payload, **kwargs):
        assert secret == "test-secret" and path == "/chat/completions"
        assert payload["model"] == model and payload["messages"][1:] == turns
        assert payload["thinking"] == {"type":"disabled"}
        assert "reasoning" not in payload and "text" not in payload
        return {"choices":[{"finish_reason":"stop","message":{"content":json.dumps(answer)}}]}
    monkeypatch.setattr(dialogue_views, "openai_request", openai)
    monkeypatch.setattr(dialogue_views, "kimi_request", kimi)
    assert dialogue_views._dialogue(SimpleNamespace(provider=provider, model_id=model,
        encrypted_api_key="cipher"), "Instructions", turns, schema) == answer
