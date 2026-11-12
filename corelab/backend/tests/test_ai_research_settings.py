from sqlalchemy import select

import json

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import sessionmaker

from app import main, property_structure_jobs, settings_views
from app.ai_research import encrypt_key, decrypt_key
from app.property_structure_jobs import popular_category_manufacturers
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
    from app.product_loader import enqueue
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
    with pytest.raises(HTTPException, match="ИИ выключен"):
        enqueue(db, [1], 1, user.id)
    assert client.put("/api/v1/admin/settings/ai/mode", json={"enabled": True}, headers=headers).json() == {"enabled": True}
    assert active_provider(db, 1).provider == "openai"


def test_ai_generation_records_researched_sources_and_creates_category_properties(catalog_client, monkeypatch):
    client, db = catalog_client
    _, category, product = seed(db)
    product.manufacturer = "ASUS"
    db.add(AIProviderSetting(organization_id=1, provider="openai", encrypted_api_key="cipher", model_id="gpt-5.5"))
    db.add(Attribute(code="conflict_probe", label="Существующее свойство",
                     value_type="number", unit="mm", normalization={}))
    db.commit()
    monkeypatch.setattr(property_structure_jobs, "decrypt_key", lambda value: "sk-test-secret")
    model_a = "ROG Strix B650-A Gaming WiFi"
    model_b = "TUF Gaming B650-PLUS"
    source_a = "https://www.asus.com/motherboards-components/motherboards/rog-strix/rog-strix-b650-a-gaming-wifi/techspec/"
    source_b = "https://www.asus.com/motherboards-components/motherboards/tuf-gaming/tuf-gaming-b650-plus/techspec/"
    monkeypatch.setattr(property_structure_jobs, "research_category", lambda key, model, name, brands: {
        "result": {
            "models": [{"manufacturer": "ASUS", "model": model_a, "url": source_a},
                       {"manufacturer": "ASUS", "model": model_b, "url": source_b}],
            "properties": [{"code": "memory_type", "label": "Тип памяти", "value_type": "string", "unit": None,
                            "description": "Тип поддерживаемой памяти", "evidence_url": source_a,
                            "model_names": [model_a, model_b]},
                           {"code": "unverified_mode", "label": "Режим без модели", "value_type": "string",
                            "unit": None, "description": "Нет подтверждающей модели", "evidence_url": source_a,
                            "model_names": ["Другая модель"]},
                           {"code": "conflict_probe", "label": "Конфликт типа", "value_type": "string",
                            "unit": None, "description": "Конфликт с существующим атрибутом",
                            "evidence_url": source_a, "model_names": [model_a]}]},
        "citations": [source_a, source_b],
    })
    response = client.post(f"/api/v1/admin/properties/categories/{category.id}/generate", json={}, headers=csrf(client))
    assert response.status_code == 200, response.text
    job_id = response.json()["id"]
    assert response.json()["status"] == "queued"
    test_session_factory = sessionmaker(bind=db.get_bind(), autoflush=False)
    assert property_structure_jobs.process_one(db_factory=test_session_factory) is True
    result = client.get(f"/api/v1/admin/properties/structure-jobs/{job_id}").json()["result"]
    assert result["created"] == 1 and len(result["models"]) == 2
    assert [item["code"] for item in result["skipped_properties"]] == ["unverified_mode", "conflict_probe"]
    assert result["check"]["current"] is True
    assert "Исследование 2–5 официальных моделей не прикреплено" not in str(result["check"]["warnings"])
    attr = db.scalar(select(Attribute).where(Attribute.code == "memory_type"))
    rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category.id, PropertyRule.code == "memory_type"))
    assert db.scalar(select(PropertyRule).where(PropertyRule.category_id == category.id,
                                             PropertyRule.code == "unverified_mode")) is None
    assert attr.label == "Тип памяти" and rule.definition["level"] == "recommended"
    assert rule.definition["evidence_url"] == source_a
    saved = db.get(CategoryStructureCheck, category.id)
    assert len(saved.report["research"]["models"]) == 2
    assert client.post(f"/api/v1/admin/properties/categories/{category.id}/generate", json={}, headers=csrf(client)).status_code == 409


def test_ai_generation_exposes_bounded_model_mismatch_diagnostics(catalog_client, monkeypatch):
    client, db = catalog_client
    _, category, product = seed(db)
    product.manufacturer = "ASUS"
    db.add(AIProviderSetting(organization_id=1, provider="openai", encrypted_api_key="cipher", model_id="gpt-5.5"))
    db.commit()
    monkeypatch.setattr(property_structure_jobs, "decrypt_key", lambda _value: "sk-test-secret")
    pages = ["https://www.asus.com/model-a", "https://www.asus.com/model-b"]
    monkeypatch.setattr(property_structure_jobs, "research_category", lambda *_args: {
        "result": {"models": [{"manufacturer": "ASUS", "model": "Model A", "url": pages[0]},
                              {"manufacturer": "ASUS", "model": "Model B", "url": pages[1]}],
                   "properties": [{"code": "socket", "label": "Сокет", "value_type": "string", "unit": None,
                                   "description": "Тип сокета", "evidence_url": pages[0],
                                   "model_names": ["Несовпадающая модель"]}]},
        "citations": pages,
    })
    job_id = client.post(f"/api/v1/admin/properties/categories/{category.id}/generate",
                         json={}, headers=csrf(client)).json()["id"]
    assert property_structure_jobs.process_one(db_factory=sessionmaker(bind=db.get_bind(), autoflush=False)) is True
    job = client.get(f"/api/v1/admin/properties/structure-jobs/{job_id}").json()
    assert job["status"] == "failed"
    assert job["diagnostics"]["model_pages"] == [
        {"model": "Model A", "url": pages[0]}, {"model": "Model B", "url": pages[1]}]
    assert job["diagnostics"]["skipped_properties"][0]["reported_model_names"] == ["Несовпадающая модель"]
    assert db.scalar(select(PropertyRule).where(PropertyRule.category_id == category.id)) is None


def test_category_research_uses_popular_manufacturers_and_covers_two_brands(catalog_client, monkeypatch):
    from app import ai_research

    _, db = catalog_client
    _, category, first = seed(db)
    first.manufacturer = "AULA"
    # Duplicate AULA more often than Logitech so it ranks first.
    extra = type(first)(source_id=first.source_id, sku="p1:aula-2", name="AULA second product",
                        currency="KZT", status="active", raw_data={}, manufacturer="AULA")
    extra.categories.append(category)
    second = type(first)(source_id=first.source_id, sku="p1:logi-1", name="Logitech product",
                         currency="KZT", status="active", raw_data={}, manufacturer="Logitech")
    second.categories.append(category)
    db.add_all([extra, second]); db.commit()
    assert popular_category_manufacturers(db, category.id) == ["AULA", "Logitech"]

    aula_url = "https://www.aulastar.com/gaming-mouse/443.html"
    logitech_url = "https://www.logitech.com/en-us/products/mice/model.html"
    payload = {"models": [{"manufacturer": "AULA", "model": "SC380Pro", "url": aula_url},
                          {"manufacturer": "Logitech", "model": "G Pro X", "url": logitech_url}],
               "properties": [{"code": "connection", "label": "Подключение", "value_type": "string", "unit": None,
                               "description": "Интерфейс подключения", "evidence_url": aula_url,
                               "model_names": ["SC380Pro", "G Pro X"]}]}
    raw = json.dumps(payload)
    response = {"output_text": raw, "output": [{"type": "message", "content": [
        {"type": "output_text", "text": raw, "annotations": [
            {"type": "url_citation", "url": aula_url}, {"type": "url_citation", "url": logitech_url}]}]}]}
    captured = {}
    monkeypatch.setattr(ai_research, "openai_request", lambda key, body: captured.update(payload=body) or response)
    ai_research.research_category("sk-test", "gpt-5.5", "Мыши", ["AULA", "Logitech"])
    prompt = captured["payload"]["input"][1]["content"]
    assert "популярности" in prompt and "как минимум двух разных производителей" in prompt
    assert "сначала ищи страницу производителя" in prompt.casefold()
    assert "shop.kz" in prompt and "dns-shop.kz" in prompt and "technodom.kz" in prompt

    payload["models"][1] = {"manufacturer": "AULA", "model": "S33", "url": "https://www.aulastar.com/gaming-mouse/s33.html"}
    raw = json.dumps(payload)
    response["output_text"] = raw
    response["output"][0]["content"][0]["text"] = raw
    response["output"][0]["content"][0]["annotations"].append({"type": "url_citation", "url": payload["models"][1]["url"]})
    with pytest.raises(HTTPException, match="двух популярных производителей"):
        ai_research.research_category("sk-test", "gpt-5.5", "Мыши", ["AULA", "Logitech"])


def test_ai_generation_requires_empty_category_and_configured_provider(catalog_client):
    client, db = catalog_client
    _, category, _ = seed(db)
    headers = csrf(client)
    response = client.post(f"/api/v1/admin/properties/categories/{category.id}/generate", json={}, headers=headers)
    assert response.status_code == 409
    assert "API-ключ" in response.json()["detail"]
    assert client.post(f"/api/v1/admin/properties/categories/{category.id}/rules",
                       json={"code": "socket", "label": "Сокет", "source": "internal", "level": "recommended"},
                       headers=headers).status_code == 200
    response = client.post(f"/api/v1/admin/properties/categories/{category.id}/generate", json={}, headers=headers)
    assert response.status_code == 409 and "пустой категории" in response.json()["detail"]
    rule = db.scalar(select(PropertyRule).where(PropertyRule.category_id == category.id))
    assert client.delete(f"/api/v1/admin/properties/rules/{rule.id}", headers=headers).status_code == 200
    assert client.get(f"/api/v1/admin/properties/categories/{category.id}").json()["category"]["can_generate_structure"] is True


def test_research_accepts_approved_retail_sources_and_rejects_uncited_urls(monkeypatch):
    from app import ai_research

    model_a = "https://www.asus.com/motherboards/model-a/specs/"
    model_b = "https://www.asus.com/motherboards/model-b/specs/"
    payload = {"models": [{"manufacturer": "ASUS", "model": "Model A", "url": model_a},
                          {"manufacturer": "ASUS", "model": "Model B", "url": model_b}],
               "properties": [{"code": "socket", "label": "Сокет", "value_type": "string", "unit": None,
                               "description": "Тип сокета", "evidence_url": model_a, "model_names": ["Model A", "Model B"]}]}
    fake_response = {"output_text": json.dumps(payload), "output": [{"type": "message", "content": [
        {"type": "output_text", "text": json.dumps(payload), "annotations": [
            {"type": "url_citation", "url": model_a}, {"type": "url_citation", "url": model_b}]}]}]}
    monkeypatch.setattr(ai_research, "openai_request", lambda key, body: fake_response)
    result = ai_research.research_category("sk-hidden", "gpt-5.5", "Материнские платы", ["ASUS"])
    assert result["result"]["models"][0]["model"] == "Model A"
    assert set(result["citations"]) == {model_a.rstrip("/"), model_b.rstrip("/")}

    third_party_url = "https://www.dns-shop.kz/product/model-b"
    payload["models"][1]["url"] = third_party_url
    fake_response["output_text"] = json.dumps(payload)
    fake_response["output"][0]["content"][0]["text"] = json.dumps(payload)
    fake_response["output"][0]["content"][0]["annotations"].append({"type": "url_citation", "url": third_party_url})
    result = ai_research.research_category("sk-hidden", "gpt-5.5", "Материнские платы", ["ASUS"])
    assert result["result"]["models"][1]["url"] == third_party_url
    payload["properties"][0]["evidence_url"] = third_party_url
    fake_response["output_text"] = json.dumps(payload)
    fake_response["output"][0]["content"][0]["text"] = json.dumps(payload)
    result = ai_research.research_category("sk-hidden", "gpt-5.5", "Материнские платы", ["ASUS"])
    assert result["result"]["properties"][0]["evidence_url"] == third_party_url

    payload["models"][1]["url"] = "https://dns-shop.kz.example.test/model-b"
    fake_response["output_text"] = json.dumps(payload)
    fake_response["output"][0]["content"][0]["text"] = json.dumps(payload)
    fake_response["output"][0]["content"][0]["annotations"].append(
        {"type": "url_citation", "url": payload["models"][1]["url"]})
    with pytest.raises(HTTPException, match="Не удалось подтвердить страницу"):
        ai_research.research_category("sk-hidden", "gpt-5.5", "Материнские платы", ["ASUS"])
    payload["models"][1]["url"] = third_party_url

    fake_response["output"][0]["content"][0]["annotations"] = [
        item for item in fake_response["output"][0]["content"][0]["annotations"]
        if item["url"] != third_party_url]
    with pytest.raises(HTTPException, match="Не удалось подтвердить страницу"):
        ai_research.research_category("sk-hidden", "gpt-5.5", "Материнские платы", ["ASUS"])

    payload["models"][1] = {"manufacturer": "ASUS", "model": "Model A", "url": model_b}
    fake_response["output_text"] = json.dumps(payload)
    fake_response["output"][0]["content"][0]["text"] = json.dumps(payload)
    with pytest.raises(HTTPException, match="двух отдельных моделей"):
        ai_research.research_category("sk-hidden", "gpt-5.5", "Материнские платы", ["ASUS"])


def test_provider_credential_uses_authenticated_encryption():
    secret = "sk-test-key-never-store-in-plaintext"
    ciphertext = encrypt_key(secret)
    assert ciphertext != secret and secret not in ciphertext
    assert decrypt_key(ciphertext) == secret


def test_research_does_not_equate_distinct_query_pages(monkeypatch):
    from app import ai_research

    first = "https://example.test/specs?model=one"
    cited_second = "https://example.test/specs?model=two"
    uncited_second = "https://example.test/specs?model=other"
    result = {
        "models": [
            {"manufacturer": "ASUS", "model": "One", "url": first},
            {"manufacturer": "ASUS", "model": "Other", "url": uncited_second},
        ],
        "properties": [{"code": "socket", "label": "Сокет", "value_type": "string", "unit": None,
                        "description": "Тип сокета", "evidence_url": first,
                        "model_names": ["One"]}],
    }
    monkeypatch.setattr(ai_research, "openai_request", lambda *_args: {
        "output_text": json.dumps(result),
        "output": [{"action": {"sources": [{"url": first}, {"url": cited_second}]}}],
    })
    with pytest.raises(HTTPException, match="Не удалось подтвердить страницу"):
        ai_research.research_category("sk-test", "gpt-5.5", "Материнские платы", ["ASUS"])
