"""Required initial company settings, validated against saved data."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .db import get_db
from .models import Organization, AuditLog, User
from sqlalchemy import select
from .organization_operations import Operations


class OrganizationProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    short_name: str = Field(min_length=1, max_length=100)
    mini_app_enabled: bool


def missing_fields(org):
    missing = []
    if not org.name or not org.name.strip(): missing.append("Название организации")
    if not org.short_name or not org.short_name.strip(): missing.append("Короткое название организации")
    if not org.logo_data or not org.logo_content_type: missing.append("Логотип организации")
    if org.mini_app_enabled:
        if not org.operations:
            missing.append("Сохранённые сроки сборки, филиалы и календари")
        try:
            operations = Operations.model_validate(org.operations or {})
        except ValidationError:
            missing.append("Корректные филиалы, маршруты и календари")
            return missing
        active = [branch for branch in operations.branches if branch.active]
        if not any(branch.kind == "branch" for branch in active): missing.append("Хотя бы один активный филиал получения")
        for branch in active:
            if not branch.city: missing.append(f"Город: {branch.name}")
            if not branch.address: missing.append(f"Адрес: {branch.name}")
    return missing


def onboarding_router(admin, chief, csrf):
    router = APIRouter(prefix="/api/v1/admin/onboarding")

    @router.get("")
    def read(user=Depends(admin), db: Session = Depends(get_db)):
        org = db.get(Organization, user.organization_id)
        chief_name = db.scalar(select(User.username).where(User.organization_id == org.id, User.role == "chief_admin", User.is_active.is_(True)).order_by(User.id))
        return {"required": org.onboarding_required, "missing": missing_fields(org),
                "name": org.name, "short_name": org.short_name or "", "username": chief_name or "Не назначен",
                "mini_app_enabled": org.mini_app_enabled,
                "logo_url": f"/api/v1/organizations/{org.id}/branding/logo" if org.logo_content_type else None}

    @router.put("/profile", dependencies=[Depends(csrf)])
    def save(body: OrganizationProfile, user=Depends(chief), db: Session = Depends(get_db)):
        org = db.get(Organization, user.organization_id)
        if not org.onboarding_required:
            raise HTTPException(409, "Первоначальная настройка уже завершена. Используйте настройки организации.")
        org.name, org.short_name, org.mini_app_enabled = body.name, body.short_name, body.mini_app_enabled
        db.add(AuditLog(organization_id=org.id, user_id=user.id, action="settings.onboarding_profile_saved",
                        object_type="organization", object_id=str(org.id), details={"mini_app_enabled": body.mini_app_enabled}))
        try: db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "Организация с таким названием уже существует") from None
        return {"saved": True, "missing": missing_fields(org)}

    @router.post("/complete", dependencies=[Depends(csrf)])
    def complete(user=Depends(chief), db: Session = Depends(get_db)):
        from sqlalchemy import select
        org = db.scalar(select(Organization).where(Organization.id == user.organization_id).with_for_update())
        missing = missing_fields(org)
        if missing: raise HTTPException(422, {"message": "Заполните обязательные поля", "missing": missing})
        if org.onboarding_required:
            org.onboarding_required = False
            db.add(AuditLog(organization_id=org.id, user_id=user.id, action="settings.onboarding_completed",
                            object_type="organization", object_id=str(org.id), details={"mini_app_enabled": org.mini_app_enabled}))
            db.commit()
        return {"completed": True}

    return router
