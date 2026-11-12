"""Scope ORM reads and writes to the signed-in user's organization."""

from fastapi import HTTPException
from sqlalchemy import event
from sqlalchemy.orm import Session, with_loader_criteria

from .models import OrganizationOwned, AuditLog


@event.listens_for(Session, "do_orm_execute")
def scope_select(execute_state):
    organization_id = execute_state.session.info.get("organization_id")
    if organization_id is None or not execute_state.is_select:
        return
    execute_state.statement = execute_state.statement.options(with_loader_criteria(
        OrganizationOwned, lambda row: row.organization_id == organization_id,
        include_aliases=True))


@event.listens_for(Session, "before_flush")
def scope_writes(session, _flush_context, _instances):
    organization_id = session.info.get("organization_id")
    if organization_id is None:
        return
    for row in session.new:
        actor = session.info.get("actor_user")
        if isinstance(row, AuditLog) and actor is not None and actor.role == "platform_admin":
            row.details = {**(row.details or {}), "actor_username": actor.username, "actor_role": actor.role}
        if isinstance(row, OrganizationOwned):
            if row.organization_id is None:
                row.organization_id = organization_id
            elif row.organization_id != organization_id:
                raise HTTPException(403, "Organization mismatch")
    for row in session.dirty | session.deleted:
        if isinstance(row, OrganizationOwned) and row.organization_id != organization_id:
            raise HTTPException(403, "Organization mismatch")
