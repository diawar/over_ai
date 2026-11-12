"""Telegram authentication and organization-bound, read-only consumer sessions."""
import hashlib
import hmac
import json
import re
import time
from urllib.parse import parse_qsl

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import Organization


class BotConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: SecretStr
    organization_id: int | None = Field(default=None, gt=0)


class Consumer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: str = "catalog:read"
    bot: str
    organization_id: int | None = None
    bound_organization_id: int | None = None
    campaign: str | None = None
    preview: bool = False


def bot_config(alias):
    try:
        raw = json.loads(get_settings().telegram_bots_json.get_secret_value())
        config = BotConfig.model_validate(raw[alias])
        if not config.token.get_secret_value():
            raise ValueError()
        return config
    except (ValueError, KeyError, TypeError):
        raise HTTPException(503, "Telegram bot is not configured") from None


def validate_init_data(init_data, token):
    try:
        pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
        data = dict(pairs)
        if len(data) != len(pairs):
            raise ValueError()
        received = data.pop("hash")
        message = "\n".join(f"{key}={value}" for key, value in sorted(data.items()))
        secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret, message.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, received):
            raise ValueError()
        age = time.time() - int(data["auth_date"])
        user = json.loads(data["user"])
        if not 0 <= age <= 300 or type(user.get("id")) is not int or user["id"] <= 0:
            raise ValueError()
        return data
    except (ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(401, "Invalid or expired Telegram authentication") from None


def launch_target(start_param):
    if not start_param:
        return None, None
    match = re.fullmatch(r"shop_([1-9][0-9]*)(?:_c_([A-Za-z0-9_-]{1,64}))?", start_param)
    if not match:
        raise HTTPException(404, "Invalid shop link")
    return int(match[1]), match[2]


def serializer():
    return URLSafeTimedSerializer(get_settings().session_secret, salt="corelab-mini-app-v1")


def issue_consumer(consumer):
    return {"access_token": serializer().dumps(consumer.model_dump()), "token_type": "bearer", "expires_in": 3600}


bearer = HTTPBearer(auto_error=False, scheme_name="MiniAppSession")


def consumer_session(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    try:
        if credentials is None:
            raise ValueError()
        consumer = Consumer.model_validate(serializer().loads(credentials.credentials, max_age=3600))
    except (BadSignature, ValueError, TypeError):
        raise HTTPException(401, "Mini App authentication required", headers={"WWW-Authenticate": "Bearer"}) from None
    if consumer.scope != "catalog:read":
        raise HTTPException(403, "Read scope required")
    if not consumer.preview:
        config = bot_config(consumer.bot)
        if config.organization_id != consumer.bound_organization_id:
            raise HTTPException(401, "Bot configuration changed; sign in again")
    if consumer.bound_organization_id and consumer.organization_id != consumer.bound_organization_id:
        raise HTTPException(403, "Organization mismatch")
    return consumer


def available_organization(db, organization_id, preview=False):
    organization = db.scalar(select(Organization).where(Organization.id == organization_id))
    if organization is None or not organization.is_active or organization.onboarding_required or (not preview and not organization.mini_app_enabled):
        raise HTTPException(404, "Shop is unavailable")
    return organization


def organization_session(consumer: Consumer = Depends(consumer_session), db: Session = Depends(get_db)):
    if consumer.organization_id is None:
        raise HTTPException(403, "Choose a shop first")
    # Count, page, properties and prices observe one committed snapshot.
    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    db.execute(text("SET TRANSACTION READ ONLY"))
    available_organization(db, consumer.organization_id, consumer.preview)
    db.info["organization_id"] = consumer.organization_id
    return consumer
