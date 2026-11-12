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


def test_category_generation_dispatches_to_selected_kimi(catalog_client, monkeypatch):
    from app import property_structure_jobs
    from app.ai_research import encrypt_key
    from test_catalog_views import seed
    from sqlalchemy.orm import sessionmaker
    client, db = catalog_client
    _, category, product = seed(db)
    product.manufacturer = "ASUS"
    db.add(AIProviderSetting(organization_id=1, provider="kimi",
                            encrypted_api_key=encrypt_key("secret"), model_id="kimi-k2.5"))
    db.commit()
    seen = []
    def research(key, model, name, brands, **options):
        seen.append((key, model, options))
        raise HTTPException(422, "No evidence")
    monkeypatch.setattr(property_structure_jobs, "research_category", research)
    response = client.post(f"/api/v1/admin/properties/categories/{category.id}/generate",
                           json={}, headers=csrf(client))
    assert response.status_code == 200
    assert property_structure_jobs.process_one(sessionmaker(bind=db.bind, autoflush=False)) is True
    assert seen == [("secret", "kimi-k2.5", {"provider": "kimi"})]


def test_kimi_search_evidence_is_independent_of_generated_urls(monkeypatch):
    real_url = "https://www.asus.com/model-a"
    fake_url = "https://www.asus.com/invented"
    calls = []
    def fake(key, path, payload=None, method="POST", timeout_seconds=120):
        calls.append((path, payload))
        if path == "/tools/search_pro":
            return {"search_results": [{"url": real_url, "chunks": [{"text": "DDR5"}]}]}
        return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"url": fake_url, "properties": []})}}]}
    monkeypatch.setattr(kimi, "request", fake)
    payload = {"model": "kimi-k2.5", "input": [{"role": "system", "content": "Research"}],
               "text": {"format": {"schema": {"type": "object", "required": ["url", "properties"],
                   "properties": {"url": {"type": "string"}, "properties": {"type": "array", "items": {
                       "type": "object", "properties": {"description": {"type": "string"}}}}}}}}}
    result = kimi.research_request("secret", payload, "ASUS exact model official specs")
    from app.ai_research import _response_text
    _, citations = _response_text(result)
    assert citations == [real_url]
    assert fake_url not in citations
    assert calls[0][1]["text_query"] == "ASUS exact model official specs"
    assert calls[1][1]["response_format"] == {"type": "json_object"}
    assert "tools" not in calls[1][1]


def test_category_kimi_repairs_invented_model_url_from_brand_searches(monkeypatch):
    from app.ai_research import OUTPUT_SCHEMA

    sources = [
        {"url": "https://example.com/logitech-m185", "title": "Logitech M185", "chunks": [{"text": "Wireless mouse"}]},
        {"url": "https://example.com/defender-ms130", "title": "Defender MS-130", "chunks": [{"text": "Optical mouse"}]},
    ]
    answer = {
        "models": [
            {"manufacturer": "Logitech", "model": "M185", "url": "https://example.com/invented"},
            {"manufacturer": "Defender", "model": "MS-130", "url": sources[1]["url"]},
        ],
        "properties": [{"code": "connection_type", "label": "Тип подключения", "value_type": "string",
                        "unit": None, "description": "Способ подключения", "evidence_url": sources[0]["url"],
                        "model_names": ["M185"]}],
    }
    calls = []

    def fake(key, path, payload=None, method="POST", timeout_seconds=120):
        calls.append((path, payload))
        if path == "/tools/search_pro":
            return {"search_results": [sources[len([call for call in calls if call[0] == path]) - 1]]}
        if len([call for call in calls if call[0] == path]) == 2:
            answer["models"][0]["url"] = sources[0]["url"]
        return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(answer)}}]}

    monkeypatch.setattr(kimi, "request", fake)
    payload = {"model": "kimi-k2.5", "input": [{"role": "system", "content": "Research"}],
               "text": {"format": {"schema": OUTPUT_SCHEMA}}}
    result = kimi.research_request("secret", payload, ["Logitech mouse specs", "Defender mouse specs"])
    assert [call[1]["text_query"] for call in calls[:2]] == ["Logitech mouse specs", "Defender mouse specs"]
    assert len([call for call in calls if call[0] == "/chat/completions"]) == 2
    assert json.loads(result["output_text"])["models"][0]["url"] == sources[0]["url"]
    assert "invented" not in result["output_text"]
    assert all(source["url"] in calls[2][1]["messages"][-1]["content"] for source in sources)


def test_kimi_missing_evidence_stops_before_generation(monkeypatch):
    monkeypatch.setattr(kimi, "request", lambda *a, **k: {"search_results": []})
    with pytest.raises(HTTPException) as error:
        kimi.research_request("secret", {}, "query")
    assert error.value.status_code == 422


def test_kimi_category_with_one_catalog_brand_can_research_two_models(monkeypatch):
    from app.ai_research import OUTPUT_SCHEMA

    urls = ["https://www.asus.com/model-one", "https://www.asus.com/model-two"]
    answer = {"models": [{"manufacturer": "ASUS", "model": name, "url": url}
                         for name, url in zip(("One", "Two"), urls)],
              "properties": [{"code": "socket", "label": "Сокет", "value_type": "string",
                              "unit": None, "description": "Тип сокета",
                              "evidence_url": urls[0], "model_names": ["One", "Two"]}]}

    def fake(_key, path, *_args, **_kwargs):
        if path == "/tools/search_pro":
            return {"search_results": [{"url": url, "chunks": [{"text": "Socket AM5"}]}
                                       for url in urls]}
        return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(answer)}}]}

    monkeypatch.setattr(kimi, "request", fake)
    payload = {"model": "kimi-k2.5", "input": [{"role": "system", "content": "Research"}],
               "text": {"format": {"schema": OUTPUT_SCHEMA}}}
    result = kimi.research_request("secret", payload,
                                   [{"text_query": "ASUS motherboard specs", "manufacturer": "ASUS"}],
                                   source_filter=lambda url, _brand: url.startswith("https://www.asus.com/"))
    assert json.loads(result["output_text"]) == answer


def test_kimi_product_research_accepts_approved_retail_evidence(monkeypatch):
    from app.product_research import SCHEMA

    source = "https://www.dns-shop.kz/product/model-a/"
    answer = {"manufacturer": "ASUS", "model": "MODEL-A", "category_match": True,
              "category_reason": "Материнская плата", "official_unavailable": True,
              "source_url": source, "values": [
                  {"code": "socket", "value": "AM5", "source_url": source, "derived": False}]}

    def fake(_key, path, *_args, **_kwargs):
        if path == "/tools/search_pro":
            return {"search_results": [{"url": source, "chunks": [{"text": "ASUS MODEL-A, socket AM5"}]}]}
        return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(answer)}}]}

    monkeypatch.setattr(kimi, "request", fake)
    payload = {"model": "kimi-k2.5", "input": [{"role": "system", "content": "Research"}],
               "text": {"format": {"schema": SCHEMA}}}
    result = kimi.research_request("secret", payload, "ASUS MODEL-A specs")
    assert json.loads(result["output_text"])["values"][0]["value"] == "AM5"


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
