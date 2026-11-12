from .password_policy import NewPassword
"""Explicit, audited organization contexts for the platform administrator."""
from dataclasses import dataclass
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from typing import Literal
from sqlalchemy.orm import Session
from .db import get_db
from .models import AuditLog, Organization, User, CatalogSource
from .security import issue_organization_context, hash_password


@dataclass(frozen=True)
class OrganizationUser:
    actor: User
    organization_id: int

    def __getattr__(self, name):
        return getattr(self.actor, name)


class EnterOrganization(BaseModel):
    model_config = ConfigDict(extra="forbid")
    organization_id: int = Field(gt=0, strict=True)


class OrganizationEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    short_name: str = Field(max_length=100)
    is_active: bool


class PlatformUserInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=3, max_length=80, pattern=r"^[a-zA-Z0-9._-]+$")
    role: Literal["admin", "chief_admin", "platform_admin"]
    is_active: bool = True
    password: NewPassword | None = None

    @field_validator("username", mode="before")
    @classmethod
    def strip_username(cls, value):
        return value.strip() if isinstance(value, str) else value


class PlatformUserCreate(PlatformUserInput):
    organization_id: int = Field(gt=0, strict=True)
    password: NewPassword


class OrganizationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    username: str = Field(min_length=3, max_length=80, pattern=r"^[a-zA-Z0-9._-]+$")
    password: NewPassword

    @field_validator("name", "username", mode="before")
    @classmethod
    def strip_names(cls, value):
        return value.strip() if isinstance(value, str) else value


def platform_router(admin_dependency, csrf_dependency):
    router = APIRouter(prefix="/api/v1/admin/platform")

    def platform_user(user=Depends(admin_dependency), db: Session = Depends(get_db)):
        if user.role != "platform_admin":
            raise HTTPException(403, "Доступ только для администратора CoreLab")
        # Only this authenticated role can use cross-organization management routes.
        db.info.pop("organization_id", None)
        return user

    def commit(db):
        try: db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "Название организации или логин уже заняты") from None

    def org_view(org):
        return {"id": org.id, "name": org.name, "short_name": org.short_name,
                "is_active": org.is_active, "onboarding_required": org.onboarding_required}

    def user_view(row, name):
        return {"id": row.id, "username": row.username, "role": row.role, "is_active": row.is_active,
                "organization_id": row.organization_id, "organization_name": name, "must_change_password": row.must_change_password}

    @router.get("/organizations")
    def organizations(user=Depends(platform_user), db: Session = Depends(get_db)):
        rows = db.scalars(select(Organization).order_by(Organization.name))
        return {"items": [org_view(row) for row in rows]}

    @router.patch("/organizations/{organization_id}", dependencies=[Depends(csrf_dependency)])
    def edit_organization(organization_id: int, body: OrganizationEdit, user=Depends(platform_user), db: Session = Depends(get_db)):
        org = db.get(Organization, organization_id)
        if org is None: raise HTTPException(404, "Организация не найдена")
        org.name, org.short_name, org.is_active = body.name, body.short_name or None, body.is_active
        db.add(AuditLog(organization_id=org.id, user_id=user.id, action="settings.platform_organization_updated", object_type="organization", object_id=str(org.id), details={"is_active": org.is_active}))
        commit(db)
        return org_view(org)

    @router.post("/organizations", dependencies=[Depends(csrf_dependency)], status_code=201)
    def create_organization(body: OrganizationCreate, user=Depends(platform_user), db: Session = Depends(get_db)):
        if db.scalar(select(User.id).where(User.username == body.username)) or db.scalar(select(Organization.id).where(Organization.name == body.name)):
            raise HTTPException(409, "Название организации или логин уже заняты")
        org = Organization(name=body.name, onboarding_required=True, ai_enabled=False)
        db.add(org)
        try: db.flush()
        except IntegrityError:
            db.rollback(); raise HTTPException(409, "Название организации уже занято") from None
        db.add(User(organization_id=org.id, username=body.username, password_hash=hash_password(body.password), role="chief_admin", must_change_password=True))
        db.add(CatalogSource(organization_id=org.id, code="corelab", name="CoreLab", endpoint="local://corelab/catalog"))
        db.info["organization_id"] = org.id
        from .property_service import ensure_defaults
        ensure_defaults(db)
        db.add(AuditLog(organization_id=org.id, user_id=user.id, action="settings.platform_organization_created", object_type="organization", object_id=str(org.id), details={}))
        commit(db)
        return org_view(org)

    @router.get("/users")
    def users(user=Depends(platform_user), db: Session = Depends(get_db)):
        rows = db.execute(select(User, Organization.name).join(Organization, User.organization_id == Organization.id).order_by(User.username))
        return {"items": [user_view(row, name) for row, name in rows]}

    @router.post("/users", dependencies=[Depends(csrf_dependency)], status_code=201)
    def create_user(body: PlatformUserCreate, user=Depends(platform_user), db: Session = Depends(get_db)):
        org = db.get(Organization, body.organization_id)
        if org is None: raise HTTPException(404, "Организация не найдена")
        if db.scalar(select(User.id).where(User.username == body.username)): raise HTTPException(409, "Этот логин уже занят")
        row = User(organization_id=org.id, username=body.username, role=body.role, is_active=body.is_active,
                   password_hash=hash_password(body.password), must_change_password=True)
        db.add(row)
        db.add(AuditLog(organization_id=org.id, user_id=user.id, action="settings.platform_user_created", object_type="user", details={"username": body.username, "role": body.role}))
        commit(db)
        return user_view(row, org.name)

    @router.patch("/users/{user_id}", dependencies=[Depends(csrf_dependency)])
    def edit_user(user_id: int, body: PlatformUserInput, user=Depends(platform_user), db: Session = Depends(get_db)):
        # Serialize role changes so two admins cannot concurrently remove the last chief.
        rows = list(db.scalars(select(User).order_by(User.id).with_for_update()))
        row = next((row for row in rows if row.id == user_id), None)
        if row is None: raise HTTPException(404, "Пользователь не найден")
        if row.id == user.id and (body.role != "platform_admin" or not body.is_active or body.password):
            raise HTTPException(409, "Нельзя отключить свою учётную запись, понизить свою роль или сбросить собственный пароль")
        if row.role == "chief_admin" and row.is_active and (body.role != "chief_admin" or not body.is_active):
            if not any(other.id != row.id and other.organization_id == row.organization_id and other.role == "chief_admin" and other.is_active for other in rows):
                raise HTTPException(409, "Сначала назначьте другого главного администратора организации")
        old_role = row.role
        row.username, row.role, row.is_active = body.username, body.role, body.is_active
        if body.password:
            row.password_hash = hash_password(body.password); row.must_change_password = True
        db.add(AuditLog(organization_id=row.organization_id, user_id=user.id, action="settings.platform_user_updated", object_type="user", object_id=str(row.id), details={"old_role": old_role, "role": row.role, "is_active": row.is_active, "password_reset": bool(body.password)}))
        commit(db)
        return user_view(row, db.get(Organization, row.organization_id).name)

    @router.post("/organization-context", dependencies=[Depends(csrf_dependency)])
    def enter(body: EnterOrganization, user=Depends(platform_user), db: Session = Depends(get_db)):
        target = db.get(Organization, body.organization_id)
        if target is None:
            raise HTTPException(404, "Организация не найдена")
        previous = user.organization_id
        actor_id = user.id
        db.info["organization_id"] = target.id
        db.add(AuditLog(organization_id=target.id, user_id=user.id,
            action="settings.platform_organization_entered", object_type="organization", object_id=str(target.id),
            details={"from_organization_id": previous, "to_organization_id": target.id,
                     "actor_username": user.username, "actor_role": user.role}))
        db.commit()
        return {"organization_context": issue_organization_context(actor_id, target.id),
                "organization_id": target.id}

    return router
