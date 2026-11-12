"""AI dialogue transport, encrypted settings, and offline evidence URL checks."""
from __future__ import annotations

import base64
import hashlib
import logging
import re
from time import monotonic
from urllib.parse import urlsplit
from urllib.parse import quote

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from .config import get_settings

OPENAI_MODEL_DEFAULT = "gpt-5.5"
logger = logging.getLogger(__name__)


def _fernet() -> Fernet:
    secret = get_settings().session_secret
    if not secret or secret == "development-only-secret-change-this-before-use":
        raise HTTPException(503, "Настройте надёжный SESSION_SECRET в backend перед сохранением ключа ИИ")
    key = base64.urlsafe_b64encode(hashlib.sha256(("corelab-ai-settings-v1:" + secret).encode()).digest())
    return Fernet(key)


def encrypt_key(api_key: str) -> str:
    return _fernet().encrypt(api_key.encode()).decode()


def decrypt_key(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except (InvalidToken, ValueError) as exc:
        raise HTTPException(503, "Не удалось расшифровать ключ ИИ. Проверьте SESSION_SECRET") from exc


def openai_request(api_key: str, payload: dict | None = None, *, method: str = "POST", url: str = "https://api.openai.com/v1/responses") -> dict:
    started = monotonic()
    try:
        response = httpx.request(method, url, headers={"Authorization": f"Bearer {api_key}"},
                                 json=payload, timeout=httpx.Timeout(120, connect=10))
    except httpx.TimeoutException as exc:
        # Never log exception text, URL, headers or payload: they may contain secrets.
        # A read timeout does not distinguish provider processing from network delay.
        phase = next((name for kind, name in (
            (httpx.ConnectTimeout, "connect"), (httpx.ReadTimeout, "read"),
            (httpx.WriteTimeout, "write"), (httpx.PoolTimeout, "pool"),
        ) if isinstance(exc, kind)), "unknown")
        logger.warning("OpenAI transport timeout phase=%s elapsed_seconds=%.3f",
                       phase, monotonic() - started)
        raise HTTPException(504, "OpenAI не ответил за отведённое время") from exc
    except httpx.HTTPError as exc:
        logger.warning("OpenAI transport error elapsed_seconds=%.3f", monotonic() - started)
        raise HTTPException(502, "Не удалось связаться с OpenAI") from exc
    if response.status_code >= 400:
        logger.warning("OpenAI HTTP error status=%d elapsed_seconds=%.3f",
                       response.status_code, monotonic() - started)
        # Provider responses can echo request data; never pass the raw body or key into logs/UI.
        if response.status_code in (401, 403):
            raise HTTPException(422, "OpenAI отклонил ключ или у ключа нет доступа к модели")
        if response.status_code == 429:
            try:
                body = response.json()
                error = body.get("error") if isinstance(body, dict) else None
            except ValueError:
                error = None
            quota_codes = ("insufficient_quota", "credit_balance_exhausted",
                           "billing_limit_reached", "billing_hard_limit_reached",
                           "organization_usage_limit_exceeded")
            if isinstance(error, dict) and (error.get("code") in quota_codes
                                           or error.get("type") == "insufficient_quota"):
                raise HTTPException(402, "OpenAI: исчерпан баланс API или лимит расходов. Проверьте оплату и лимиты аккаунта")
            raise HTTPException(429, "OpenAI ограничил запрос: проверьте лимит или баланс аккаунта")
        if response.status_code == 404:
            raise HTTPException(404, "OpenAI не нашёл указанную модель")
        raise HTTPException(502, f"OpenAI вернул ошибку ({response.status_code})")
    try:
        return response.json()
    except ValueError as exc:
        raise HTTPException(502, "OpenAI вернул некорректный ответ") from exc


def verify_model_access(api_key: str, model_id: str) -> bool:
    try:
        openai_request(api_key, method="GET", url=f"https://api.openai.com/v1/models/{quote(model_id, safe='._-')}")
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(422, "Ключ работает, но указанная модель недоступна этому аккаунту") from exc
        raise
    return True


def _domain(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        return ""
    host = parts.hostname.lower().split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    return host


APPROVED_RETAILER_DOMAINS = ("shop.kz", "dns-shop.kz", "technodom.kz", "pricerunner.com")


def _approved_retailer(url: str) -> bool:
    host = _domain(url)
    return any(host == domain or host.endswith("." + domain)
               for domain in APPROVED_RETAILER_DOMAINS)


_STOP_BRAND = {"inc", "corp", "corporation", "company", "co", "ltd", "limited", "llc", "plc", "computer", "technology", "technologies", "international", "group", "the"}
OFFICIAL_DOMAIN_ALIASES = {
    "afox": {"afox-corp.com"},
    "aula": {"aulastar.com"},
    "amd": {"amd-memory.com"},
    "canon": {"canon-europe.com", "manual.canon"},
    "cougar": {"cougargaming.com"},
    "gamemax": {"gamemaxpc.com"},
    "gamerstorm": {"deepcool.com"},
    "fsp": {"fsplifestyle.com"},
    "hiksemi": {"hiksemitech.com"},
    "patriot": {"patriotmemory.com"},
    "pny": {"pny.com"},
    "team": {"teamgroupinc.com"},
    "toshiba": {"toshiba-storage.com"},
    "transcend": {"transcend-info.com"},
    "thermaltake": {"thermaltake.com", "thermaltakeusa.com"},
    "westerndigital": {"wd.com", "westerndigital.com"},
    "kyocera": {"kyoceradocumentsolutions.com"},
    "montech": {"montechpc.com"},
}
OFFICIAL_SEARCH_DOMAINS = {
    "aula": "aulastar.com",
    "canon": "manual.canon",
    "hp": "hp.com",
    "pantum": "pantum.com",
    "xerox": "xerox.com",
    "kyocera": "kyoceradocumentsolutions.com",
}


def _brand_tokens(name: str) -> set[str]:
    tokens = set(re.findall(r"[a-z0-9]+", name.lower()))
    tokens = {token for token in tokens if token not in _STOP_BRAND and (len(token) >= 4 or token in {"msi", "hp", "lg", "amd", "fsp"})}
    compact = re.sub(r"[^a-z0-9]", "", name.lower())
    if "asustek" in compact:
        tokens.add("asus")
    if "microstar" in compact:
        tokens.add("msi")
    if "hewlettpackard" in compact:
        tokens.add("hp")
    if "advancedmicrodevices" in compact:
        tokens.add("amd")
    return tokens


def _official_for_manufacturer(url: str, manufacturer: str) -> bool:
    host = _domain(url)
    brand_tokens = _brand_tokens(manufacturer)
    compact_manufacturer = re.sub(r"[^a-z0-9]", "", manufacturer.lower())
    aliases = set().union(*(OFFICIAL_DOMAIN_ALIASES.get(token, set()) for token in brand_tokens))
    aliases.update(OFFICIAL_DOMAIN_ALIASES.get(compact_manufacturer, set()))
    if any(host == domain or host.endswith("." + domain) for domain in aliases):
        return True
    labels = [label for label in host.split(".") if label and label != "www"]
    if len(labels) < 2:
        return False
    known_second_level_suffixes = {"com", "co", "net", "org", "gov", "ac", "edu"}
    base_label = labels[-3] if len(labels) >= 3 and labels[-2] in known_second_level_suffixes else labels[-2]
    base_parts = set(part for part in re.split(r"[-_]+", base_label) if part)
    compact_base = re.sub(r"[^a-z0-9]", "", base_label)
    tokens = _brand_tokens(manufacturer)
    if not host or not tokens:
        return False
    if base_label in tokens or base_parts == tokens:
        return True
    ordered_tokens = [token for token in re.findall(r"[a-z0-9]+", manufacturer.lower())
                      if token not in _STOP_BRAND and (len(token) >= 4 or token in {"msi", "hp", "lg", "amd", "fsp"})]
    compact_name = re.sub(r"[^a-z0-9]", "", manufacturer.lower())
    return compact_base in {compact_name, "".join(ordered_tokens)}


def _normal_url(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    try:
        port = parts.port
    except ValueError:
        return ""
    authority = f"{host}:{port}" if port is not None else host
    query = f"?{parts.query}" if parts.query else ""
    return f"{parts.scheme.lower()}://{authority}{parts.path.rstrip('/')}{query}"
