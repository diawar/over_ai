"""OpenRouter model calls with server-supplied search citations."""

import httpx
from fastapi import HTTPException

BASE_URL = "https://openrouter.ai/api/v1"
MODEL_DEFAULT = "moonshotai/kimi-k2.5"


def request(api_key, path, payload=None, method="POST"):
    try:
        response = httpx.request(method, BASE_URL + path,
                                 headers={"Authorization": f"Bearer {api_key}"},
                                 json=payload, timeout=httpx.Timeout(120, connect=10))
    except httpx.TimeoutException as exc:
        raise HTTPException(504, "OpenRouter не ответил за отведённое время") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Не удалось связаться с OpenRouter") from exc
    if response.status_code >= 400:
        if response.status_code in (401, 403):
            raise HTTPException(422, "OpenRouter отклонил API-ключ")
        if response.status_code == 402:
            raise HTTPException(402, "OpenRouter: недостаточно средств или исчерпан лимит ключа")
        if response.status_code == 429:
            raise HTTPException(429, "OpenRouter временно ограничил запрос (429). Проверьте лимит запросов и доступность модели, затем попробуйте позже")
        raise HTTPException(502, f"OpenRouter вернул ошибку ({response.status_code})")
    try:
        result = response.json()
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except ValueError as exc:
        raise HTTPException(502, "OpenRouter вернул некорректный ответ") from exc


def verify_model_access(api_key, model_id):
    request(api_key, "/key", method="GET")
    response = request(api_key, "/models", method="GET")
    if not any(isinstance(row, dict) and row.get("id") == model_id for row in response.get("data", [])):
        raise HTTPException(422, "Указанная модель недоступна через OpenRouter")
    return True


def completion_text(result):
    try:
        choice = result["choices"][0]
        content = choice["message"]["content"]
        if choice.get("finish_reason") != "stop" or not isinstance(content, str):
            raise ValueError()
        return content, choice["message"]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise HTTPException(502, "OpenRouter не завершил ответ") from exc
