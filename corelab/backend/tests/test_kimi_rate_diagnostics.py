import logging
import httpx
import pytest
from fastapi import HTTPException
from app import kimi


@pytest.mark.parametrize('body,retry,expected', [
    ({'error': {'type': 'rate_limit_reached_error', 'message': 'private prompt'}}, '45',
     'code=rate_limit_reached_error retry_after_seconds=45'),
    ({'error': {'type': 'engine_overloaded_error'}}, '45',
     'code=engine_overloaded_error retry_after_seconds=45'),
    ({'error': {'type': 'exceeded_current_quota_error'}}, '45',
     'code=exceeded_current_quota_error retry_after_seconds=45'),
    ({'error': {'code': 'insufficient_quota'}}, '90000',
     'code=insufficient_quota retry_after_seconds=unspecified'),
    ({'error': {'type': 'private-secret', 'message': 'private prompt'}}, 'bad-header',
     'code=unspecified retry_after_seconds=unspecified'),
    ([], '0', 'code=unspecified retry_after_seconds=0'),
])
def test_429_diagnostics_are_safe_without_retry(monkeypatch, caplog, body, retry, expected):
    calls = []

    def send(*args, **kwargs):
        calls.append(1)
        return httpx.Response(429, json=body, headers={'Retry-After': retry})

    monkeypatch.setattr(kimi.httpx, 'request', send)
    with caplog.at_level(logging.WARNING), pytest.raises(HTTPException) as caught:
        kimi.request('private-key', '/chat/completions', {'messages': ['private prompt']})
    assert caught.value.status_code == 429
    assert (caught.value.headers or {}).get('Retry-After') == (retry if retry in ('45', '0') else None)
    assert len(calls) == 1
    assert expected in caplog.text
    assert 'private' not in caplog.text
