"""Print only allowlisted limit diagnostics, never provider bodies or credentials."""
import json
import httpx
from app.db import SessionLocal
from app.kimi import active_provider
from app.ai_research import decrypt_key

with SessionLocal() as db:
    provider = active_provider(db, 1)
    if provider is None or provider.provider != 'openai':
        raise RuntimeError('Expected current OpenAI provider')
    key, model = decrypt_key(provider.encrypted_api_key), provider.model_id
response = httpx.post('https://api.openai.com/v1/responses',
    headers={'Authorization': 'Bearer ' + key},
    json={'model': model, 'input': 'Reply OK.', 'max_output_tokens': 16, 'store': False}, timeout=30)
try:
    error = response.json().get('error') or {}
except ValueError:
    error = {}
print(json.dumps({'status': response.status_code, 'code': error.get('code'), 'type': error.get('type'),
    'retry_after': response.headers.get('retry-after'),
    'requests_remaining': response.headers.get('x-ratelimit-remaining-requests'),
    'tokens_remaining': response.headers.get('x-ratelimit-remaining-tokens')}, ensure_ascii=False))
