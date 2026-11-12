from .password_policy import NewPassword
from contextlib import asynccontextmanager
import asyncio
import time
from pathlib import Path
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import TypeAdapter, BaseModel, Field, ConfigDict, field_validator
from sqlalchemy import select, delete
from sqlalchemy.orm import Session
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from .config import get_settings
from .db import get_db
from .models import AdminSession, Organization, User, CatalogSource, AuditLog
from .security import (hash_password, issue_session, new_csrf_token, read_session,
                       read_organization_context, verify_password, session_hash, password_fingerprint)
from .platform_admin import OrganizationUser, platform_router
from . import tenant  # noqa: F401 - install organization scope on ORM sessions

settings = get_settings()
limiter = Limiter(key_func=get_remote_address)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Alembic creates schema before the server starts. Provision only the configured
    # local bootstrap account; never emit credentials to logs.
    from .db import SessionLocal
    with SessionLocal() as db:
        organization = db.get(Organization, 1)
        if organization is None:
            organization = Organization(name='ТОО "OVER-SHOP.KZ"')
            db.add(organization)
            db.flush()
        user = db.scalar(select(User).where(User.username == settings.admin_username))
        if user is None:
            try:
                bootstrap_password = TypeAdapter(NewPassword).validate_python(settings.admin_password)
            except ValueError:
                raise RuntimeError('ADMIN_PASSWORD requires at least 8 characters and a special character') from None
            db.add(User(username=settings.admin_username, password_hash=hash_password(bootstrap_password),
                        role="chief_admin", organization_id=organization.id,
                        must_change_password=settings.app_env != "local"))
            db.commit()
        db.info["organization_id"] = organization.id
        from .property_service import ensure_defaults
        ensure_defaults(db)
        db.commit()
    from .validity_worker import run_worker
    stop = asyncio.Event()
    worker = asyncio.create_task(run_worker(stop))
    try:
        yield
    finally:
        stop.set()
        await worker


app = FastAPI(title="CoreLab Admin", version="0.1.0", lifespan=lifespan)
mini_app_dir = next((path for path in (
    Path(__file__).resolve().parents[2] / "mini-app",
    Path(__file__).resolve().parent.parent / "mini-app",
) if (path / "index.html").is_file()), None)
if mini_app_dir is not None:
    app.mount("/catalog-preview", StaticFiles(directory=mini_app_dir, html=True), name="catalog-preview")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(CORSMiddleware, allow_origins=[v.strip() for v in settings.cors_origins.split(",") if v.strip()],
                   allow_credentials=True, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allow_headers=["Content-Type", "X-CSRF-Token", "Authorization", "X-CoreLab-Organization-Context"])


class LoginInput(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


class PasswordChangeInput(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: NewPassword


class RegistrationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    username: str = Field(min_length=3, max_length=80, pattern=r"^[a-zA-Z0-9._-]+$")
    password: NewPassword

    @field_validator("name", "username", mode="before")
    @classmethod
    def strip_names(cls, value):
        return value.strip() if isinstance(value, str) else value


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get("corelab_session")
    user_id = read_session(token) if token else None
    user = db.get(User, user_id) if user_id else None
    saved = db.get(AdminSession, session_hash(token)) if user is not None else None
    if (user is None or not user.is_active or saved is None or saved.user_id != user.id
            or saved.expires_at <= time.time()
            or not secrets_compare(saved.password_fingerprint, password_fingerprint(user.password_hash))):
        raise HTTPException(status_code=401, detail="Authentication required")
    db.info["actor_user"] = user
    organization_id = user.organization_id
    context = request.headers.get("X-CoreLab-Organization-Context")
    if context:
        if user.role != "platform_admin":
            raise HTTPException(403, "Доступ к другой организации запрещён")
        organization_id = read_organization_context(context, user.id)
        if organization_id is None or db.get(Organization, organization_id) is None:
            raise HTTPException(403, "Контекст организации истёк или недействителен. Войдите заново.")
    db.info["organization_id"] = organization_id
    if user.role == "platform_admin":
        return OrganizationUser(actor=user, organization_id=organization_id)
    return user


def admin_user(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)) -> User:
    if user.role not in ("admin", "chief_admin", "platform_admin"):
        raise HTTPException(status_code=403, detail="Admin role required")
    if user.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    organization = db.get(Organization, user.organization_id)
    if organization is None or (not organization.is_active and user.role != "platform_admin"):
        raise HTTPException(403, "Доступ к организации приостановлен")
    setup_paths = ("/api/v1/admin/auth/", "/api/v1/admin/settings/", "/api/v1/admin/onboarding", "/api/v1/admin/mini-app/settings", "/api/v1/admin/platform/")
    if organization.onboarding_required and not request.url.path.startswith(setup_paths):
        raise HTTPException(403, "Завершите первоначальную настройку организации")
    return user


def chief_admin_user(user: User = Depends(admin_user)) -> User:
    if user.role not in ("chief_admin", "platform_admin"):
        raise HTTPException(status_code=403, detail="Chief admin role required")
    return user


def verify_csrf(request: Request):
    cookie = request.cookies.get("corelab_csrf")
    header = request.headers.get("X-CSRF-Token")
    if not cookie or not header or not secrets_compare(cookie, header):
        raise HTTPException(status_code=403, detail="CSRF token invalid")


def secrets_compare(left, right):
    import hmac
    return hmac.compare_digest(left, right)


@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    db.execute(select(1))
    return {"status": "ok"}


def session_view(user, organization):
    return {"username": user.username, "role": user.role,
            "organization": {"id": organization.id, "name": organization.name,
                             "short_name": organization.short_name, "primary_color": organization.primary_color,
                             "is_active": organization.is_active,
                             "logo_url": f"/api/v1/organizations/{organization.id}/branding/logo" if organization.logo_content_type else None},
            "onboarding_required": organization.onboarding_required,
            "must_change_password": user.must_change_password}


def session_cookies(response, user, db):
    csrf = new_csrf_token()
    token = issue_session(user.id)
    db.execute(delete(AdminSession).where(AdminSession.expires_at <= int(time.time())))
    db.add(AdminSession(token_hash=session_hash(token), user_id=user.id,
                        password_fingerprint=password_fingerprint(user.password_hash),
                        expires_at=int(time.time()) + 8 * 60 * 60))
    db.commit()
    response.set_cookie("corelab_session", token, httponly=True, secure=settings.app_env != "local",
                        samesite="lax", path="/", max_age=8 * 60 * 60)
    response.set_cookie("corelab_csrf", csrf, httponly=False, secure=settings.app_env != "local",
                        samesite="lax", path="/", max_age=8 * 60 * 60)
    return csrf


@app.post("/api/v1/admin/auth/register", status_code=201)
@limiter.limit("5/hour")
def register(request: Request, response: Response, body: RegistrationInput, db: Session = Depends(get_db)):
    from sqlalchemy.exc import IntegrityError
    if db.scalar(select(User.id).where(User.username == body.username)) is not None:
        raise HTTPException(409, "Этот логин уже занят")
    if db.scalar(select(Organization.id).where(Organization.name == body.name)) is not None:
        raise HTTPException(409, "Организация с таким названием уже существует")
    try:
        org = Organization(name=body.name, onboarding_required=True, mini_app_enabled=False, ai_enabled=False)
        db.add(org); db.flush()
        user = User(organization_id=org.id, username=body.username, password_hash=hash_password(body.password), role="chief_admin")
        db.add(user); db.flush()
        db.info["organization_id"] = org.id
        db.add(CatalogSource(organization_id=org.id, code="corelab", name="CoreLab", endpoint="local://corelab/catalog"))
        from .property_service import ensure_defaults
        ensure_defaults(db)
        db.add(AuditLog(organization_id=org.id, user_id=user.id, action="settings.organization_registered", object_type="organization", object_id=str(org.id), details={}))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Название организации или логин уже заняты") from None
    return {**session_view(user, org), "csrf_token": session_cookies(response, user, db)}


@app.post("/api/v1/admin/auth/login")
@limiter.limit("5/minute")
def login(request: Request, response: Response, body: LoginInput, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == body.username))
    if user is None or not user.is_active or not verify_password(user.password_hash, body.password):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    organization = db.get(Organization, user.organization_id)
    if not organization.is_active and user.role != "platform_admin":
        raise HTTPException(403, "Доступ к организации приостановлен")
    return {**session_view(user, organization), "csrf_token": session_cookies(response, user, db)}


@app.get("/api/v1/admin/auth/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    organization = db.get(Organization, user.organization_id)
    return session_view(user, organization)


@app.post("/api/v1/admin/auth/change-password")
def change_password(request: Request, response: Response, body: PasswordChangeInput, user: User = Depends(current_user), db: Session = Depends(get_db)):
    verify_csrf(request)
    if user.role not in ("admin", "chief_admin", "platform_admin"):
        raise HTTPException(status_code=403, detail="Admin role required")
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    actor = db.info.get("actor_user", user)
    db.info["organization_id"] = actor.organization_id
    actor.password_hash = hash_password(body.new_password)
    actor.must_change_password = False
    db.execute(delete(AdminSession).where(AdminSession.user_id == actor.id))
    session_cookies(response, actor, db)
    return {"status": "ok"}


@app.post("/api/v1/admin/auth/logout")
def logout(request: Request, response: Response, user: User = Depends(current_user), db: Session = Depends(get_db)):
    verify_csrf(request)
    db.execute(delete(AdminSession).where(AdminSession.token_hash == session_hash(request.cookies['corelab_session']),
                                         AdminSession.user_id == user.id))
    db.commit()
    response.delete_cookie("corelab_session", path="/")
    response.delete_cookie("corelab_csrf", path="/")
    return {"status": "ok"}


from .journal_views import journal_router
app.include_router(platform_router(admin_user, verify_csrf))
from .onboarding import onboarding_router
app.include_router(onboarding_router(admin_user, chief_admin_user, verify_csrf))
app.include_router(journal_router(admin_user))
from .source_views import source_router
app.include_router(source_router(admin_user))
from .organization_operations import operations_router
app.include_router(operations_router(admin_user, chief_admin_user, verify_csrf))
from .catalog_views import catalog_router
app.include_router(catalog_router(admin_user, verify_csrf))
from .property_spreadsheet import spreadsheet_router
app.include_router(spreadsheet_router(admin_user, verify_csrf))
from .performance_views import performance_router
app.include_router(performance_router(admin_user))
from .property_views import property_router
app.include_router(property_router(admin_user, verify_csrf))
from .property_values import values_router
app.include_router(values_router(admin_user, verify_csrf))
from .settings_views import public_branding_router, settings_router
app.include_router(settings_router(admin_user, chief_admin_user, verify_csrf))
app.include_router(public_branding_router())

from .mini_views import mini_router, mini_admin_router
app.include_router(mini_router())
app.include_router(mini_admin_router(admin_user, chief_admin_user, verify_csrf))
from .dialogue_views import internal_dialogue_router
app.include_router(internal_dialogue_router())
