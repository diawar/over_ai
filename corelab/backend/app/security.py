import secrets
import hashlib
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import get_settings

hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, ValueError):
        return False


def session_serializer():
    return URLSafeTimedSerializer(get_settings().session_secret, salt="corelab-session-v1")


def issue_session(user_id: int) -> str:
    return session_serializer().dumps({"sub": user_id, "nonce": secrets.token_hex(32)})


def session_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def password_fingerprint(password_hash: str) -> str:
    return hashlib.sha256(password_hash.encode()).hexdigest()


def read_session(token: str, max_age: int = 8 * 60 * 60):
    try:
        payload = session_serializer().loads(token, max_age=max_age)
        if not isinstance(payload, dict) or type(payload.get("sub")) is not int or payload["sub"] < 1:
            return None
        return payload["sub"]
    except (BadSignature, KeyError, TypeError, ValueError):
        return None


def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def issue_organization_context(user_id: int, organization_id: int) -> str:
    signer = URLSafeTimedSerializer(get_settings().session_secret, salt="corelab-organization-context-v1")
    return signer.dumps({"sub": user_id, "organization_id": organization_id})


def read_organization_context(token: str, user_id: int):
    try:
        signer = URLSafeTimedSerializer(get_settings().session_secret, salt="corelab-organization-context-v1")
        payload = signer.loads(token, max_age=8 * 60 * 60)
        if payload.get("sub") != user_id or type(payload.get("organization_id")) is not int or payload["organization_id"] < 1:
            return None
        return payload["organization_id"]
    except (BadSignature, KeyError, TypeError, ValueError):
        return None
