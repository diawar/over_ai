from .password_policy import NewPassword
"""Administrator settings for the AI research provider."""
import base64
import binascii
import http.client
from io import BytesIO
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from PIL import Image, UnidentifiedImageError

from .ai_research import OPENAI_MODEL_DEFAULT, decrypt_key, encrypt_key, verify_model_access
from .db import get_db
from .models import AIProviderSetting, AuditLog, Organization, User
from .logo_palette import logo_palette
from hashlib import sha256
from .security import hash_password
from . import kimi, openrouter


class OpenAISettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    api_key: str = Field(min_length=1, max_length=500)
    model_id: str = Field(default=OPENAI_MODEL_DEFAULT, min_length=1, max_length=120, pattern=r"^[a-zA-Z0-9._-]+$")


class KimiSettingsInput(OpenAISettingsInput):
    model_id: str = Field(default=kimi.KIMI_MODEL_DEFAULT, min_length=1, max_length=120, pattern=r"^[a-zA-Z0-9._-]+$")


class OpenRouterSettingsInput(OpenAISettingsInput):
    model_id: str = Field(default=openrouter.MODEL_DEFAULT, min_length=3, max_length=120,
                          pattern=r"^[a-zA-Z0-9._-]+/[a-zA-Z0-9._:-]+$")


class AIModeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


class UserCreateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=3, max_length=80, pattern=r"^[a-zA-Z0-9._-]+$")
    password: NewPassword


class UserUpdateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=3, max_length=80, pattern=r"^[a-zA-Z0-9._-]+$")
    password: NewPassword | None = None


class OrganizationBrandingInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    primary_color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")


class OrganizationShortNameInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    short_name: str = Field(max_length=100)


class ProductLinksInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(max_length=2000)


DEFAULT_WELCOME_HEADLINE = ["Ваши задачи.", "Ваш характер.", "Ваш компьютер."]


class OrganizationWelcomeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    welcome_headline: list[str] = Field(min_length=3, max_length=3)

    @field_validator("welcome_headline")
    @classmethod
    def validate_lines(cls, lines):
        lines = [line.strip() for line in lines]
        if any(not line or len(line) > 80 or "\n" in line or "\r" in line for line in lines):
            raise ValueError("Каждая строка должна содержать от 1 до 80 символов без переноса строки")
        return lines


class OrganizationLogoInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image_base64: str = Field(min_length=1, max_length=3_500_000)


def user_view(user):
    return {"id": user.id, "username": user.username, "role": user.role,
            "must_change_password": user.must_change_password}


def current_organization_id(db, user):
    return db.info.get("organization_id", getattr(user, "organization_id", 1))


def settings_router(admin_dependency, chief_dependency, csrf_dependency):
    router = APIRouter(prefix="/api/v1/admin/settings", dependencies=[Depends(admin_dependency)])

    @router.get('/product-links')
    def get_product_links(sku: str | None = None, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        from .product_links import lookup
        org = db.get(Organization, current_organization_id(db, user))
        settings = org.product_links or {}
        return {'url': settings.get('url', ''), 'count': len(settings.get('items', {})),
                'updated_at': settings.get('updated_at'), 'product_url': lookup(settings, sku) if sku else None}

    @router.put('/product-links', dependencies=[Depends(csrf_dependency)])
    def save_product_links(body: ProductLinksInput, db: Session = Depends(get_db), user=Depends(chief_dependency)):
        from .product_links import download_feed, public_url
        try:
            url = public_url(body.url) if body.url.strip() else ''
            items = download_feed(url) if url else {}
        except (ValueError, OSError, http.client.HTTPException) as exc:
            raise HTTPException(422, 'Не удалось загрузить ссылки. Проверьте адрес и формат XML. ' + (str(exc) if isinstance(exc, ValueError) else 'Сайт недоступен.')) from exc
        org_id = current_organization_id(db, user)
        settings = {'url': url, 'items': items, 'updated_at': datetime.now(timezone.utc).isoformat()}
        db.execute(update(Organization).where(Organization.id == org_id).values(product_links=settings))
        db.add(AuditLog(organization_id=org_id, user_id=user.id, action='settings.product_links_updated',
                        object_type='organization', object_id=str(org_id), details={'url': url, 'count': len(items)}))
        db.commit()
        return {'url': url, 'count': len(items), 'updated_at': settings['updated_at']}

    @router.get("/openai")
    def get_openai(db: Session = Depends(get_db), user=Depends(admin_dependency)):
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "openai"))
        return {"provider": "OpenAI", "configured": row is not None,
                "model_id": row.model_id if row else OPENAI_MODEL_DEFAULT}

    @router.put("/openai", dependencies=[Depends(csrf_dependency)])
    def save_openai(body: OpenAISettingsInput, db: Session = Depends(get_db), user=Depends(chief_dependency)):
        value = body.api_key.strip()
        if not value.startswith("sk-") or len(value) < 20:
            raise HTTPException(422, "Проверьте формат API-ключа OpenAI")
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "openai"))
        if row is None:
            row = AIProviderSetting(organization_id=current_organization_id(db, user), provider="openai",
                                    encrypted_api_key=encrypt_key(value), model_id=body.model_id)
            db.add(row)
        else:
            row.encrypted_api_key = encrypt_key(value)
            row.model_id = body.model_id
            row.updated_at = datetime.now(timezone.utc)
        db.add(AuditLog(user_id=user.id, action="settings.openai_key_saved", object_type="ai_provider", object_id="openai",
                        details={"model_id": body.model_id, "key_changed": True}))
        db.commit()
        return {"provider": "OpenAI", "configured": True, "model_id": row.model_id}

    @router.post("/openai/test", dependencies=[Depends(csrf_dependency)])
    def test_openai(db: Session = Depends(get_db), user=Depends(chief_dependency)):
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "openai"))
        if row is None:
            raise HTTPException(409, "Сначала сохраните API-ключ OpenAI")
        verify_model_access(decrypt_key(row.encrypted_api_key), row.model_id)
        db.add(AuditLog(user_id=user.id, action="settings.openai_connection_tested", object_type="ai_provider", object_id="openai",
                        details={"model_id": row.model_id, "status": "success"}))
        db.commit()
        return {"status": "success", "model_id": row.model_id}

    @router.delete("/openai", dependencies=[Depends(csrf_dependency)])
    def delete_openai(db: Session = Depends(get_db), user=Depends(chief_dependency)):
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "openai"))
        if row is not None:
            db.delete(row)
            db.add(AuditLog(user_id=user.id, action="settings.openai_key_deleted", object_type="ai_provider", object_id="openai",
                            details={"key_deleted": True}))
            db.commit()
        return {"configured": False}

    @router.get("/kimi")
    def get_kimi(db: Session = Depends(get_db), user=Depends(admin_dependency)):
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "kimi"))
        return {"provider": "Kimi", "configured": row is not None,
                "model_id": row.model_id if row else kimi.KIMI_MODEL_DEFAULT}

    @router.put("/kimi", dependencies=[Depends(csrf_dependency)])
    def save_kimi(body: KimiSettingsInput, db: Session = Depends(get_db), user=Depends(chief_dependency)):
        value = body.api_key.strip()
        if len(value) < 20 or any(char.isspace() for char in value):
            raise HTTPException(422, "Проверьте формат API-ключа Kimi")
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "kimi"))
        if row is None:
            row = AIProviderSetting(organization_id=current_organization_id(db, user), provider="kimi",
                                    encrypted_api_key=encrypt_key(value), model_id=body.model_id)
            db.add(row)
        else:
            row.encrypted_api_key = encrypt_key(value)
            row.model_id = body.model_id
            row.updated_at = datetime.now(timezone.utc)
        db.add(AuditLog(user_id=user.id, action="settings.kimi_key_saved", object_type="ai_provider", object_id="kimi",
                        details={"model_id": body.model_id, "key_changed": True}))
        db.commit()
        return {"provider": "Kimi", "configured": True, "model_id": row.model_id}

    @router.post("/kimi/test", dependencies=[Depends(csrf_dependency)])
    def test_kimi(db: Session = Depends(get_db), user=Depends(chief_dependency)):
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "kimi"))
        if row is None:
            raise HTTPException(409, "Сначала сохраните API-ключ Kimi")
        kimi.verify_model_access(decrypt_key(row.encrypted_api_key), row.model_id)
        db.add(AuditLog(user_id=user.id, action="settings.kimi_connection_tested", object_type="ai_provider", object_id="kimi",
                        details={"model_id": row.model_id, "status": "success"}))
        db.commit()
        return {"status": "success", "model_id": row.model_id}

    @router.delete("/kimi", dependencies=[Depends(csrf_dependency)])
    def delete_kimi(db: Session = Depends(get_db), user=Depends(chief_dependency)):
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "kimi"))
        if row is not None:
            db.delete(row)
            db.add(AuditLog(user_id=user.id, action="settings.kimi_key_deleted", object_type="ai_provider", object_id="kimi",
                            details={"key_deleted": True}))
            db.commit()
        return {"configured": False}

    @router.get("/openrouter")
    def get_openrouter(db: Session = Depends(get_db), user=Depends(admin_dependency)):
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "openrouter"))
        return {"provider": "OpenRouter", "configured": row is not None,
                "model_id": row.model_id if row else openrouter.MODEL_DEFAULT}

    @router.put("/openrouter", dependencies=[Depends(csrf_dependency)])
    def save_openrouter(body: OpenRouterSettingsInput, db: Session = Depends(get_db), user=Depends(chief_dependency)):
        value = body.api_key.strip()
        if len(value) < 20 or any(char.isspace() for char in value):
            raise HTTPException(422, "Проверьте формат API-ключа OpenRouter")
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "openrouter"))
        if row is None:
            row = AIProviderSetting(organization_id=current_organization_id(db, user), provider="openrouter",
                                    encrypted_api_key=encrypt_key(value), model_id=body.model_id,
                                    updated_at=datetime.now(timezone.utc))
            db.add(row)
        else:
            row.encrypted_api_key = encrypt_key(value)
            row.model_id = body.model_id
            row.updated_at = datetime.now(timezone.utc)
        db.add(AuditLog(user_id=user.id, action="settings.openrouter_key_saved", object_type="ai_provider",
                        object_id="openrouter", details={"model_id": body.model_id, "key_changed": True}))
        db.commit()
        return {"provider": "OpenRouter", "configured": True, "model_id": row.model_id}

    @router.post("/openrouter/test", dependencies=[Depends(csrf_dependency)])
    def test_openrouter(db: Session = Depends(get_db), user=Depends(chief_dependency)):
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "openrouter"))
        if row is None:
            raise HTTPException(409, "Сначала сохраните API-ключ OpenRouter")
        openrouter.verify_model_access(decrypt_key(row.encrypted_api_key), row.model_id)
        db.add(AuditLog(user_id=user.id, action="settings.openrouter_connection_tested", object_type="ai_provider",
                        object_id="openrouter", details={"model_id": row.model_id, "status": "success"}))
        db.commit()
        return {"status": "success", "model_id": row.model_id}

    @router.delete("/openrouter", dependencies=[Depends(csrf_dependency)])
    def delete_openrouter(db: Session = Depends(get_db), user=Depends(chief_dependency)):
        row = db.get(AIProviderSetting, (current_organization_id(db, user), "openrouter"))
        if row is not None:
            db.delete(row)
            db.add(AuditLog(user_id=user.id, action="settings.openrouter_key_deleted", object_type="ai_provider",
                            object_id="openrouter", details={"key_deleted": True}))
            db.commit()
        return {"configured": False}

    @router.get("/ai/active")
    def get_active_ai(db: Session = Depends(get_db), user=Depends(admin_dependency)):
        row = kimi.active_provider(db, current_organization_id(db, user), include_disabled=True)
        enabled = db.scalar(select(Organization.ai_enabled).where(
            Organization.id == current_organization_id(db, user)))
        return {"provider": row.provider if row else "openai", "enabled": enabled is True}

    @router.put("/ai/mode", dependencies=[Depends(csrf_dependency)])
    def set_ai_mode(body: AIModeInput, db: Session = Depends(get_db), user=Depends(chief_dependency)):
        organization_id = current_organization_id(db, user)
        organization = db.get(Organization, organization_id)
        if organization is None:
            raise HTTPException(404, "Организация не найдена")
        organization.ai_enabled = body.enabled
        db.add(AuditLog(user_id=user.id, action="settings.ai_mode_changed", object_type="organization",
                        object_id=str(organization_id), details={"enabled": body.enabled}))
        db.commit()
        return {"enabled": organization.ai_enabled}

    @router.post("/ai/{provider}/activate", dependencies=[Depends(csrf_dependency)])
    def activate_ai(provider: str, db: Session = Depends(get_db), user=Depends(chief_dependency)):
        if provider not in ("openai", "kimi", "openrouter"):
            raise HTTPException(404, "Неизвестный провайдер ИИ")
        row = db.get(AIProviderSetting, (current_organization_id(db, user), provider))
        if row is None:
            raise HTTPException(409, "Сначала сохраните API-ключ")
        row.updated_at = datetime.now(timezone.utc)
        db.add(AuditLog(user_id=user.id, action="settings.ai_provider_selected", object_type="ai_provider",
                       object_id=provider, details={"model_id": row.model_id}))
        db.commit()
        return {"provider": provider}

    @router.get("/organization")
    def organization(db: Session = Depends(get_db), user=Depends(admin_dependency)):
        row = db.execute(select(Organization.id, Organization.name, Organization.short_name, Organization.welcome_headline, Organization.primary_color,
                                Organization.logo_content_type, Organization.logo_data)
                         .where(Organization.id == user.organization_id)).one()
        return {"id": row.id, "name": row.name, "short_name": row.short_name, "welcome_headline": row.welcome_headline or DEFAULT_WELCOME_HEADLINE, "role": user.role,
                "primary_color": row.primary_color,
                "logo_palette": logo_palette(row.logo_data),
                "logo_url": f"/api/v1/organizations/{row.id}/branding/logo?v={sha256(row.logo_data).hexdigest()[:16]}" if row.logo_content_type and row.logo_data else None}

    @router.put("/organization/short-name", dependencies=[Depends(csrf_dependency)])
    def save_organization_short_name(body: OrganizationShortNameInput, db: Session = Depends(get_db),
                                     chief=Depends(chief_dependency)):
        short_name = body.short_name.strip() or None
        db.execute(update(Organization).where(Organization.id == chief.organization_id).values(short_name=short_name))
        db.add(AuditLog(user_id=chief.id, action="settings.organization_short_name_changed",
                        object_type="organization", object_id=str(chief.organization_id),
                        details={"short_name": short_name}))
        db.commit()
        return {"short_name": short_name}

    @router.put("/organization/welcome", dependencies=[Depends(csrf_dependency)])
    def save_organization_welcome(body: OrganizationWelcomeInput, db: Session = Depends(get_db),
                                  chief=Depends(chief_dependency)):
        db.execute(update(Organization).where(Organization.id == chief.organization_id)
                   .values(welcome_headline=body.welcome_headline))
        db.add(AuditLog(user_id=chief.id, action="settings.organization_welcome_changed",
                        object_type="organization", object_id=str(chief.organization_id),
                        details={"welcome_headline": body.welcome_headline}))
        db.commit()
        return {"welcome_headline": body.welcome_headline}

    @router.put("/organization/branding", dependencies=[Depends(csrf_dependency)])
    def save_organization_branding(body: OrganizationBrandingInput, db: Session = Depends(get_db),
                                   chief=Depends(chief_dependency)):
        row = db.execute(select(Organization.primary_color, Organization.logo_data).where(Organization.id == chief.organization_id)).one()
        if not row.logo_data:
            raise HTTPException(422, "Сначала добавьте логотип организации")
        color = body.primary_color.lower()
        db.execute(update(Organization).where(Organization.id == chief.organization_id).values(primary_color=color))
        db.add(AuditLog(user_id=chief.id, action="settings.organization_color_changed",
                        object_type="organization", object_id=str(chief.organization_id),
                        details={"old_color": row.primary_color, "primary_color": color}))
        db.commit()
        return {"primary_color": color}

    @router.put("/organization/logo", dependencies=[Depends(csrf_dependency)])
    def save_organization_logo(body: OrganizationLogoInput, db: Session = Depends(get_db),
                               chief=Depends(chief_dependency)):
        try:
            image_data = base64.b64decode(body.image_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(422, "Файл логотипа повреждён") from exc
        if len(image_data) > 2_500_000:
            raise HTTPException(413, "Размер логотипа не должен превышать 2,5 МБ")
        try:
            with Image.open(BytesIO(image_data)) as image:
                if image.size != (512, 512):
                    raise HTTPException(422, "Логотип должен быть размером 512 × 512 пикселей")
                image.verify()
                image_format = image.format
        except HTTPException:
            raise
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
            raise HTTPException(422, "Загрузите корректный PNG, JPEG или WebP файл") from exc
        content_type = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}.get(image_format)
        if content_type is None:
            raise HTTPException(422, "Поддерживаются форматы PNG, JPEG и WebP")
        db.execute(update(Organization).where(Organization.id == chief.organization_id).values(
            logo_data=image_data, logo_content_type=content_type))
        db.add(AuditLog(user_id=chief.id, action="settings.organization_logo_changed",
                        object_type="organization", object_id=str(chief.organization_id),
                        details={"content_type": content_type, "size": len(image_data)}))
        db.commit()
        return {"logo_url": f"/api/v1/organizations/{chief.organization_id}/branding/logo"}

    @router.delete("/organization/logo", dependencies=[Depends(csrf_dependency)])
    def delete_organization_logo(db: Session = Depends(get_db), chief=Depends(chief_dependency)):
        has_logo = db.scalar(select(Organization.logo_content_type).where(
            Organization.id == chief.organization_id)) is not None
        if has_logo:
            db.execute(update(Organization).where(Organization.id == chief.organization_id).values(
                logo_data=None, logo_content_type=None))
            db.add(AuditLog(user_id=chief.id, action="settings.organization_logo_deleted",
                            object_type="organization", object_id=str(chief.organization_id), details={"logo_deleted": True}))
            db.commit()
        return {"logo_url": None}

    @router.get("/users")
    def users(db: Session = Depends(get_db), user=Depends(admin_dependency)):
        rows = db.scalars(select(User).where(User.organization_id == user.organization_id).order_by(User.id))
        return {"items": [user_view(row) for row in rows]}

    @router.post("/users", dependencies=[Depends(csrf_dependency)])
    def create_user(body: UserCreateInput, db: Session = Depends(get_db), chief=Depends(chief_dependency)):
        username = body.username.strip()
        if db.scalar(select(User.id).where(User.username == username)) is not None:
            raise HTTPException(409, "Такой логин уже занят")
        row = User(organization_id=chief.organization_id, username=username,
                   password_hash=hash_password(body.password), role="admin", must_change_password=True)
        db.add(row)
        try:
            db.flush()
            db.add(AuditLog(user_id=chief.id, action="settings.user_created", object_type="user",
                            object_id=str(row.id), details={"username": username, "role": "admin"}))
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(409, "Такой логин уже занят") from exc
        return user_view(row)

    @router.patch("/users/{user_id}", dependencies=[Depends(csrf_dependency)])
    def update_user(user_id: int, body: UserUpdateInput, db: Session = Depends(get_db), chief=Depends(chief_dependency)):
        row = db.get(User, user_id)
        if row is None or row.organization_id != chief.organization_id or row.role != "admin":
            raise HTTPException(404, "Профиль не найден")
        old_username = row.username
        row.username = body.username.strip()
        if body.password is not None:
            row.password_hash = hash_password(body.password)
            row.must_change_password = True
        db.add(AuditLog(user_id=chief.id, action="settings.user_updated", object_type="user",
                        object_id=str(row.id), details={"old_username": old_username,
                                                       "username": row.username, "password_reset": body.password is not None}))
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(409, "Такой логин уже занят") from exc
        return user_view(row)

    @router.delete("/users/{user_id}", dependencies=[Depends(csrf_dependency)])
    def delete_user(user_id: int, db: Session = Depends(get_db), chief=Depends(chief_dependency)):
        row = db.get(User, user_id)
        if row is None or row.organization_id != chief.organization_id or row.role != "admin":
            raise HTTPException(404, "Профиль не найден")
        username = row.username
        db.delete(row)
        db.add(AuditLog(user_id=chief.id, action="settings.user_deleted", object_type="user",
                        object_id=str(user_id), details={"username": username}))
        db.commit()
        return {"deleted": True}

    return router


def public_branding_router():
    router = APIRouter(prefix="/api/v1/organizations")

    @router.get("/{organization_id}/branding")
    def public_organization_branding(organization_id: int, db: Session = Depends(get_db)):
        row = db.execute(select(Organization.id, Organization.name, Organization.short_name, Organization.welcome_headline, Organization.primary_color,
                                Organization.logo_content_type)
                         .where(Organization.id == organization_id)).one_or_none()
        if row is None:
            raise HTTPException(404, "Organization not found")
        return {"organization_id": row.id, "name": row.name, "short_name": row.short_name, "welcome_headline": row.welcome_headline or DEFAULT_WELCOME_HEADLINE, "primary_color": row.primary_color,
                "logo_url": f"/api/v1/organizations/{row.id}/branding/logo" if row.logo_content_type else None}

    @router.get("/{organization_id}/branding/logo")
    def public_organization_logo(organization_id: int, db: Session = Depends(get_db)):
        row = db.execute(select(Organization.logo_data, Organization.logo_content_type)
                         .where(Organization.id == organization_id)).one_or_none()
        if row is None or row.logo_data is None or row.logo_content_type is None:
            raise HTTPException(404, "Organization logo not found")
        return Response(content=row.logo_data, media_type=row.logo_content_type,
                        headers={"Cache-Control": "public, no-cache, must-revalidate"})

    return router
