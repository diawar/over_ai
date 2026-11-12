"""Internal Mini App dialogue. Provider credentials never leave CoreLab."""
import hashlib
import hmac
import json
import logging
import re
import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from jsonschema import ValidationError, validate
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .ai_research import decrypt_key, openai_request
from .config import get_settings
from .db import get_db
from .kimi import active_provider, request as kimi_request
from .models import Organization
from .openrouter import completion_text, request as openrouter_request
from . import ai_explanation_jobs as explanation_jobs
from . import ai_usage_limits

logger = logging.getLogger(__name__)


def _remove_duplicate_aliases(value, schema):
    """Remove only redundant underscore aliases; never guess conflicting values."""
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for key in list(value):
            canonical = key.rstrip("_")
            if key not in properties and canonical in properties and canonical in value and value[key] == value[canonical]:
                del value[key]
        for key, child in value.items():
            if key in properties:
                _remove_duplicate_aliases(child, properties[key])
    elif isinstance(value, list):
        for child in value:
            _remove_duplicate_aliases(child, schema.get("items", {}))


def _authenticated(request, organization_id, body):
    stamp = request.headers.get("X-CoreLab-AI-Timestamp", "")
    supplied = request.headers.get("X-CoreLab-AI-Auth", "")
    try:
        if abs(time.time() - int(stamp)) > 60:
            raise ValueError()
    except ValueError:
        raise HTTPException(403, "Forbidden") from None
    digest = hashlib.sha256(body).hexdigest()
    signed = f"{stamp}:{organization_id}:{digest}".encode()
    expected = hmac.new(get_settings().session_secret.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(403, "Forbidden")


def _provider(db, organization_id):
    organization = db.get(Organization, organization_id)
    if organization is None or not organization.is_active or organization.onboarding_required or not organization.mini_app_enabled:
        raise HTTPException(404, "Organization not found")
    row = active_provider(db, organization_id)
    if row is None:
        raise HTTPException(409, "API-ключ ИИ не задан в настройках CoreLab")
    return row


def _decode_openai(result):
    if result.get("status") != "completed":
        status = result.get("status")
        status = status if status in ("incomplete", "failed", "cancelled", "queued", "in_progress") else "unknown"
        details = result.get("incomplete_details") or {}
        reason = details.get("reason") if isinstance(details, dict) else None
        reason = reason if reason in ("max_output_tokens", "content_filter") else "unknown"
        usage = result.get("usage") or {}
        output_tokens = usage.get("output_tokens") if isinstance(usage, dict) else None
        if type(output_tokens) is not int or output_tokens < 0:
            output_tokens = None
        logger.warning("OpenAI incomplete response: status=%s reason=%s output_tokens=%s", status, reason, output_tokens)
        raise HTTPException(502, "ИИ не завершил ответ")
    try:
        return "".join(content["text"] for output in result["output"]
                       if output.get("type") == "message" for content in output["content"]
                       if content.get("type") == "output_text")
    except (KeyError, TypeError) as exc:
        raise HTTPException(502, "ИИ вернул некорректный ответ") from exc


def _dialogue(row, instructions, turns, schema, mode="dialogue"):
    if mode == "planner_fast" and row.provider != "openai":
        raise HTTPException(409, "Fast planner mode requires OpenAI")
    key = decrypt_key(row.encrypted_api_key)
    if row.provider == "openai":
        result = openai_request(key, {
            "model": row.model_id, "reasoning": {"effort": "low" if mode in ("explanation", "planner_fast") else "medium"}, "store": False,
            "instructions": instructions, "input": turns, "max_output_tokens": 4800 if mode == "explanation" else 2400,
            "text": {"format": {"type": "json_schema", "name": "corelab_dialogue",
                                "strict": True, "schema": schema}},
        })
        raw = _decode_openai(result)
    else:
        messages = [{"role": "system", "content": instructions + " Верни JSON по схеме: "
                     + json.dumps(schema, ensure_ascii=False)}] + turns
        payload = {"model": row.model_id, "messages": messages,
                   "response_format": {"type": "json_object"}, "max_tokens": 3200 if mode == "explanation" else 2400}
        if row.provider == "kimi":
            if row.model_id == "kimi-k3":
                # K3 always reasons. Bound the combined reasoning/final output budget;
                # K2's thinking toggle and max_tokens are not its API contract.
                payload.pop("max_tokens")
                payload["max_completion_tokens"] = 8192 if mode in ("planner", "explanation") else 4096
                payload["reasoning_effort"] = "high" if mode == "planner" else "low"
                payload["response_format"] = {"type": "json_schema", "json_schema": {
                    "name": "corelab_dialogue", "strict": True, "schema": schema}}
                result = kimi_request(key, "/chat/completions", payload,
                                      timeout_seconds=180 if mode == "planner" else 90)
            # K2.6 defaults to thinking, sharing the output budget with the JSON reply.
            # Interactive dialogue needs a short complete reply; catalog research is separate.
            elif row.model_id == "kimi-k2.6":
                payload["thinking"] = {"type": "enabled" if mode == "planner" else "disabled"}
                if mode == "planner":
                    payload["max_tokens"] = 8192
                result = kimi_request(key, "/chat/completions", payload, timeout_seconds=180 if mode == "planner" else 45)
            else:
                result = kimi_request(key, "/chat/completions", payload)
        elif row.provider == "openrouter":
            result = openrouter_request(key, "/chat/completions", payload)
        else:
            raise HTTPException(503, "Провайдер ИИ не поддерживается")
        raw, _ = completion_text(result)
    try:
        data = json.loads(raw)
        _remove_duplicate_aliases(data, schema)
        validate(data, schema)
    except (ValueError, ValidationError) as exc:
        logger.warning("AI dialogue invalid structure: path=%s", list(getattr(exc, "absolute_path", [])))
        raise HTTPException(502, {"code": "ai_invalid_response"}) from exc
    return data


def internal_dialogue_router():
    router = APIRouter(prefix="/api/v1/internal/ai", include_in_schema=False)

    @router.get("/explanations/{request_id}")
    def explanation(request_id: str, request: Request, organization_id: int = Query(1, gt=0), db: Session = Depends(get_db)):
        _authenticated(request, organization_id, ("explanation:" + request_id).encode())
        if not re.fullmatch(r"[a-f0-9]{64}", request_id):
            raise HTTPException(422, "Invalid explanation ID")
        organization = db.get(Organization, organization_id)
        if not organization or not organization.is_active or organization.onboarding_required or not organization.mini_app_enabled:
            raise HTTPException(404, "Organization not found")
        return explanation_jobs.read(db, organization_id, request_id)

    @router.get("/status")
    def status(request: Request, organization_id: int = Query(1, gt=0), db: Session = Depends(get_db)):
        _authenticated(request, organization_id, b"")
        organization = db.get(Organization, organization_id)
        row = active_provider(db, organization_id) if organization else None
        ready = bool(organization and organization.is_active and not organization.onboarding_required and organization.mini_app_enabled and row is not None)
        return {"ready": ready, "provider": row.provider if ready else None}

    @router.post("/dialogue")
    async def dialogue(request: Request, organization_id: int = Query(1, gt=0), db: Session = Depends(get_db)):
        body = await request.body()
        _authenticated(request, organization_id, body)
        if len(body) > 40000:
            raise HTTPException(413, "Dialogue too large")
        try:
            data = json.loads(body)
            instructions, turns, schema = data["instructions"], data["input"], data["schema"]
            mode = data.get("mode", "dialogue")
            request_id = data.get("request_id")
            if request_id is not None and (mode != "explanation" or not isinstance(request_id, str)
                    or not re.fullmatch(r"[a-f0-9]{64}", request_id)):
                raise ValueError()
            if mode not in ("dialogue", "planner", "planner_fast", "explanation"):
                raise ValueError()
            if not isinstance(instructions, str) or len(instructions) > 12000:
                raise ValueError()
            if not isinstance(turns, list) or len(turns) > 61 or any(
                not isinstance(turn, dict) or turn.get("role") not in ("user", "assistant")
                or not isinstance(turn.get("content"), str) or len(turn["content"]) > 10000
                for turn in turns
            ) or not isinstance(schema, dict):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise HTTPException(422, "Invalid dialogue request") from None
        row = _provider(db, organization_id)
        if data.get("expected_provider") is not None and data["expected_provider"] != row.provider:
            raise HTTPException(409, "AI provider changed; restart selection")
        provider_data = row.provider, row.model_id, row.encrypted_api_key
        db.rollback()
        from types import SimpleNamespace
        def generate():
            return ai_usage_limits.execute(organization_id, lambda: _dialogue(
                SimpleNamespace(provider=provider_data[0], model_id=provider_data[1],
                                encrypted_api_key=provider_data[2]), instructions, turns, schema, mode))
        if mode == "explanation" and request_id is not None:
            fresh = explanation_jobs.reserve(db, organization_id, request_id,
                explanation_jobs.payload_hash(instructions, turns, schema))
            if fresh:
                explanation_jobs.start(organization_id, request_id, generate)
            receipt = explanation_jobs.read(db, organization_id, request_id)
            return JSONResponse(receipt, status_code=202 if receipt["status"] == "running" else 200)
        started = time.monotonic()
        try:
            return await run_in_threadpool(generate)
        except HTTPException as exc:
            logger.warning("AI dialogue failed: provider=%s status=%s elapsed_seconds=%.1f",
                           provider_data[0], exc.status_code, time.monotonic() - started)
            raise

    return router
