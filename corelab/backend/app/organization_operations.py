"""Validated per-organization logistics and working-day calendar."""
from datetime import date, timedelta
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import get_db
from .models import Organization, AuditLog


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CalendarException(Input):
    date: date
    working: bool
    note: str = Field(default="", max_length=160)


class Calendar(Input):
    weekly_days_off: list[StrictInt] = Field(default_factory=lambda: [5, 6], max_length=6)
    calendar_exceptions: list[CalendarException] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def check_calendar(self):
        if any(not 0 <= day <= 6 for day in self.weekly_days_off) or len(set(self.weekly_days_off)) != len(self.weekly_days_off):
            raise ValueError("Проверьте дни недели; хотя бы один день должен быть рабочим")
        dates = [row.date for row in self.calendar_exceptions]
        if len(set(dates)) != len(dates):
            raise ValueError("Для каждой даты допускается одно исключение")
        return self


class Branch(Calendar):
    code: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=160)
    city: str = Field(default="", max_length=120)
    address: str = Field(default="", max_length=500)
    kind: Literal["branch", "warehouse", "supplier_warehouse"] = "branch"
    source_label: str = Field(default="", max_length=160)
    active: bool = True


class Transit(Input):
    from_branch: str
    to_branch: str
    workdays: int = Field(ge=0, le=365, strict=True)


class Operations(Input):
    version: int = Field(default=0, ge=0)
    assembly_workdays: int = Field(default=2, ge=0, le=365, strict=True)
    branches: list[Branch] = Field(default_factory=list, max_length=200)
    routes: list[Transit] = Field(default_factory=list, max_length=5000)

    @model_validator(mode="before")
    @classmethod
    def migrate_calendar(cls, value):
        # Read old snapshots without retaining a shared calendar in the new schema.
        if isinstance(value, dict) and ("weekly_days_off" in value or "calendar_exceptions" in value):
            value = dict(value)
            calendar = Calendar.model_validate({key: value.pop(key) for key in ("weekly_days_off", "calendar_exceptions") if key in value}).model_dump(mode="json")
            value["branches"] = [{**calendar, **branch} for branch in value.get("branches", [])]
        return value

    @model_validator(mode="after")
    def check_references(self):
        codes = [branch.code for branch in self.branches]
        if len(set(codes)) != len(codes):
            raise ValueError("Коды филиалов должны быть уникальными")
        labels = [branch.source_label for branch in self.branches if branch.source_label]
        if len(set(labels)) != len(labels):
            raise ValueError("Обозначения складов в прайс-листе должны быть уникальными")
        pairs = set()
        for route in self.routes:
            pair = (route.from_branch, route.to_branch)
            if route.from_branch not in codes or route.to_branch not in codes or pair[0] == pair[1]:
                raise ValueError("Маршрут должен соединять два разных филиала организации")
            if pair in pairs:
                raise ValueError("Маршрут в этом направлении уже задан")
            pairs.add(pair)
        return self


def working_day(day, settings):
    exception = next((row for row in settings.calendar_exceptions if row.date == day), None)
    return exception.working if exception else day.weekday() not in settings.weekly_days_off


def add_workdays(start, count, settings):
    # Normalize a nonworking start; count full workdays after that start.
    day = start
    for _ in range(4000):
        if working_day(day, settings):
            break
        day += timedelta(days=1)
    else:
        raise ValueError("Нет рабочих дат в доступном диапазоне")
    while count:
        day += timedelta(days=1)
        if working_day(day, settings):
            count -= 1
    return day


class Estimate(Input):
    from_branch: str
    to_branch: str
    start_date: date


def estimate(settings, request):
    active = {branch.code: branch for branch in settings.branches if branch.active}
    if request.from_branch not in active or request.to_branch not in active:
        raise ValueError("Выберите действующие филиалы")
    transit = 0
    if request.from_branch != request.to_branch:
        route = next((r for r in settings.routes if r.from_branch == request.from_branch and r.to_branch == request.to_branch), None)
        if route is None:
            raise ValueError("Перемещение между выбранными филиалами не разрешено: добавьте маршрут")
        transit = route.workdays
    source, target = active[request.from_branch], active[request.to_branch]
    start = add_workdays(request.start_date, 0, source)
    arrival = add_workdays(add_workdays(start, transit, source), 0, target)
    ready = add_workdays(arrival, settings.assembly_workdays, target)
    return {"start_date": start, "arrival_date": arrival, "ready_date": ready,
            "transit_workdays": transit, "assembly_workdays": settings.assembly_workdays,
            "total_workdays": transit + settings.assembly_workdays}


def operations_router(admin_dependency, chief_dependency, csrf_dependency):
    router = APIRouter(prefix="/api/v1/admin/settings/organization/operations", dependencies=[Depends(admin_dependency)])

    def organization(db, user, lock=False):
        statement = select(Organization).where(Organization.id == user.organization_id)
        row = db.scalar(statement.with_for_update() if lock else statement)
        if row is None:
            raise HTTPException(404, "Организация не найдена")
        return row

    @router.get("")
    def read(db: Session = Depends(get_db), user=Depends(admin_dependency)):
        return Operations.model_validate(organization(db, user).operations or {})

    @router.put("", dependencies=[Depends(csrf_dependency)])
    def save(body: Operations, db: Session = Depends(get_db), user=Depends(chief_dependency)):
        row = organization(db, user, lock=True)
        current = Operations.model_validate(row.operations or {})
        if current.version != body.version:
            raise HTTPException(409, "Настройки изменены в другой вкладке. Обновите страницу перед сохранением.")
        body.version += 1
        row.operations = body.model_dump(mode="json")
        db.add(AuditLog(organization_id=row.id, user_id=user.id, action="settings.organization_operations_changed", object_type="organization",
                        object_id=str(row.id), details={"version": body.version, "branches": len(body.branches), "routes": len(body.routes)}))
        db.commit()
        return body

    @router.post("/estimate", dependencies=[Depends(csrf_dependency)])
    def calculate(body: Estimate, db: Session = Depends(get_db), user=Depends(admin_dependency)):
        settings = Operations.model_validate(organization(db, user).operations or {})
        try:
            return estimate(settings, body)
        except (ValueError, OverflowError) as reason:
            raise HTTPException(422, str(reason)) from None

    return router
