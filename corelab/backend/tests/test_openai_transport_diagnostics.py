import httpx
import pytest
from fastapi import HTTPException
from app import ai_research as ai


@pytest.mark.parametrize("kind,phase", [
    (httpx.ConnectTimeout, "connect"), (httpx.ReadTimeout, "read"),
    (httpx.WriteTimeout, "write"), (httpx.PoolTimeout, "pool"),
    (httpx.TimeoutException, "unknown"),
])
def test_timeout_phase_is_safe_and_does_not_retry(monkeypatch, caplog, kind, phase):
    calls = []
    times = iter([10.0, 130.25])
    monkeypatch.setattr(ai, "monotonic", lambda: next(times))
    def request(*args, **kwargs):
        calls.append(kwargs)
        raise kind("private exception including key and payload")
    monkeypatch.setattr(ai.httpx, "request", request)
    with pytest.raises(HTTPException) as error:
        ai.openai_request("private key", {"input": "private prompt"}, url="https://private.invalid/secret")
    assert error.value.status_code == 504
    assert f"phase={phase} elapsed_seconds=120.250" in caplog.text
    assert "private" not in caplog.text and "secret" not in caplog.text
    assert len(calls) == 1
    assert calls[0]["timeout"] == httpx.Timeout(120, connect=10)


def test_transport_error_does_not_log_exception_or_retry(monkeypatch, caplog):
    calls = []
    def request(*args, **kwargs):
        calls.append(1)
        raise httpx.ConnectError("private secret")
    monkeypatch.setattr(ai.httpx, "request", request)
    with pytest.raises(HTTPException) as error:
        ai.openai_request("private key")
    assert error.value.status_code == 502
    assert "OpenAI transport error elapsed_seconds=" in caplog.text
    assert "private" not in caplog.text
    assert calls == [1]


@pytest.mark.parametrize("status,body,expected", [
    (401, {"error": "private"}, 422),
    (429, {"error": {"code": "insufficient_quota", "message": "private"}}, 402),
    (429, {"error": {"message": "private"}}, 429),
    (504, {"error": "private"}, 502),
])
def test_provider_http_error_is_distinct_from_client_timeout(monkeypatch, caplog, status, body, expected):
    monkeypatch.setattr(ai.httpx, "request", lambda *a, **k: httpx.Response(status, json=body))
    with pytest.raises(HTTPException) as error:
        ai.openai_request("private key")
    assert error.value.status_code == expected
    assert f"OpenAI HTTP error status={status}" in caplog.text
    assert "transport timeout" not in caplog.text
    assert "private" not in caplog.text


def test_success_keeps_response_and_does_not_log_content(monkeypatch, caplog):
    monkeypatch.setattr(ai.httpx, "request", lambda *a, **k: httpx.Response(200, json={"output": "private"}))
    assert ai.openai_request("private key") == {"output": "private"}
    assert "private" not in caplog.text
