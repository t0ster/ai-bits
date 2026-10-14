"""Reserve an entity while its request is queued or running.

- Acceptance reserves the entity before enqueueing. Competing requests fail busy.
- Request IDs are globally unique. Resubmitting the same request returns its
  record without enqueueing again; another entity cannot reuse its ID.
- Each request can start execution only once.

Tasks must claim before execution and finish only after execution stops.
Completion or definitive failure releases the entity; crashes, cancellation,
and uncertain completion do not automatically release it.

Database acceptance and queue publication are separate steps. A missing job
does not free the entity. Recovery is out of scope.
"""

from datetime import datetime
from typing import ClassVar, Literal

from pydantic import BaseModel, JsonValue
from sqlalchemy import Table, and_, func, select, true, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncConnection

from lib.database.engine import engine
from lib.database.tables import chats, investigations, requests
from lib.shared import Id, queue

# Leaking intentionally, and this is by design for now.
EntityType = Literal["chat", "investigation"]
# Submission creates a missing entity as initializing and its request as pending,
# in one transaction before enqueueing. Callers mark the entity ready once
# initialization is complete; its request may still be running.
EntityStatus = Literal["initializing", "ready"]
RequestStatus = Literal["pending", "running", "completed", "failed"]

# Concrete registration tables used to create, lock, and read each entity type.
_ENTITY_TABLES: dict[EntityType, Table] = {
    "chat": chats,
    "investigation": investigations,
}


class EntityRequestError(Exception):
    """Expected request failure translated by the CLI or HTTP boundary."""

    code: ClassVar[str] = "entity_request_error"


class EntityBusyError(EntityRequestError):
    """A pending or running request already reserves the entity."""

    code: ClassVar[str] = "entity_busy"


class EntityNotFoundError(EntityRequestError):
    """No entity registration exists."""

    code: ClassVar[str] = "entity_not_found"


class RequestIdentityConflictError(EntityRequestError):
    """Globally unique request IDs cannot be reused for another entity."""

    code: ClassVar[str] = "request_identity_conflict"


class RequestNotFoundError(EntityRequestError):
    """No accepted request exists for the supplied identity."""

    code: ClassVar[str] = "request_not_found"


class RequestStateError(EntityRequestError):
    """The request's status does not allow this operation."""

    code: ClassVar[str] = "request_state_error"


class EntityRef(BaseModel):
    """Concrete entity identity; each type selects its own registration table."""

    type: EntityType
    id: Id


class EntityRequest(BaseModel):
    """Request ID is globally unique and also identifies its retained queue job."""

    request_id: str
    entity: EntityRef
    execution_status: RequestStatus
    created_at: datetime


class EntitySnapshot(BaseModel):
    """Entity status and selected request read from one PostgreSQL snapshot."""

    status: EntityStatus
    request: EntityRequest | None


def _request_entity_clause(entity: EntityRef):
    return and_(
        requests.c.entity_type == entity.type,
        requests.c.entity_id == entity.id,
    )


def _entity_request(row: RowMapping) -> EntityRequest:
    return EntityRequest.model_validate(
        {
            "request_id": row["request_id"],
            "entity": {"type": row["entity_type"], "id": row["entity_id"]},
            "execution_status": row["execution_status"],
            "created_at": row["created_at"],
        }
    )


async def _lock_entity(connection: AsyncConnection, entity: EntityRef) -> None:
    table = _ENTITY_TABLES[entity.type]
    result = await connection.execute(
        select(table.c.id).where(table.c.id == entity.id).with_for_update()
    )
    if result.scalar_one_or_none() is None:
        raise EntityNotFoundError("Entity registration not found")


def _check_request_identity(reference: EntityRequest, entity: EntityRef) -> None:
    if reference.entity != entity:
        raise RequestIdentityConflictError("Request ID belongs to another entity")


async def enqueue_entity_request(
    entity: EntityRef,
    *,
    request_id: str,
    job_name: str,
    payload: dict[str, JsonValue],
) -> EntityRequest:
    """Create the entity if missing, then reserve and enqueue its request.

    Duplicates return the original request without enqueueing again.
    Publication failure leaves the request accepted.
    """
    async with engine.begin() as connection:
        table = _ENTITY_TABLES[entity.type]
        _ = await connection.execute(
            insert(table)
            .values(
                id=entity.id,
                status="initializing",
                created_at=func.clock_timestamp(),
            )
            .on_conflict_do_nothing(index_elements=[table.c.id])
        )
        await _lock_entity(connection, entity)
        original = await connection.execute(
            select(requests).where(requests.c.request_id == request_id)
        )
        row = original.mappings().one_or_none()
        if row is not None:
            reference = _entity_request(row)
            _check_request_identity(reference, entity)
            return reference
        reserved = await connection.execute(
            select(requests.c.request_id).where(
                _request_entity_clause(entity),
                requests.c.execution_status.in_(["pending", "running"]),
            )
        )
        if reserved.scalar_one_or_none() is not None:
            raise EntityBusyError("Entity is busy with an accepted request")
        result = await connection.execute(
            insert(requests)
            .values(
                request_id=request_id,
                entity_type=entity.type,
                entity_id=entity.id,
                execution_status="pending",
                created_at=func.clock_timestamp(),
            )
            .on_conflict_do_nothing(index_elements=[requests.c.request_id])
            .returning(requests)
        )
        row = result.mappings().one_or_none()
        if row is None:
            # A simultaneous submission on another entity won the global request ID.
            raise RequestIdentityConflictError("Request ID belongs to another entity")
        reference = _entity_request(row)
    # A failed or uncertain commit never authorizes publication.
    _ = await queue.add(job_name, payload, {"jobId": request_id, "attempts": 1})
    return reference


async def claim_entity_request(entity: EntityRef, request_id: str) -> None:
    """Commit running before execution; reject any request that is not pending."""
    async with engine.begin() as connection:
        await _lock_entity(connection, entity)
        result = await connection.execute(
            select(requests).where(requests.c.request_id == request_id)
        )
        row = result.mappings().one_or_none()
        if row is None:
            raise RequestNotFoundError("Request not found")
        reference = _entity_request(row)
        _check_request_identity(reference, entity)
        if reference.execution_status != "pending":
            raise RequestStateError(
                f"Request claim requires pending status; found {reference.execution_status}"
            )
        _ = await connection.execute(
            update(requests)
            .where(requests.c.request_id == request_id)
            .values(execution_status="running")
        )


async def finish_entity_request(
    entity: EntityRef, request_id: str, status: Literal["completed", "failed"]
) -> None:
    """Release only after execution ends; cancellation must retain running status.

    Call completed outside the method's exception handler so persistence failures
    cannot be mistaken for method failures and release an uncertain reservation.
    """
    if status not in {"completed", "failed"}:
        raise RequestStateError(
            "Request completion requires completed or failed status"
        )
    async with engine.begin() as connection:
        await _lock_entity(connection, entity)
        result = await connection.execute(
            update(requests)
            .where(
                _request_entity_clause(entity),
                requests.c.request_id == request_id,
                requests.c.execution_status == "running",
            )
            .values(execution_status=status)
            .returning(requests.c.request_id)
        )
        if result.scalar_one_or_none() is None:
            result = await connection.execute(
                select(requests.c.execution_status).where(
                    _request_entity_clause(entity), requests.c.request_id == request_id
                )
            )
            current_status = result.scalar_one_or_none()
            if current_status is None:
                raise RequestNotFoundError("Request not found")
            raise RequestStateError(
                f"Request completion requires running status; found {current_status}"
            )


async def mark_entity_ready(entity: EntityRef) -> None:
    """Mark ready after entity initialization is complete."""
    table = _ENTITY_TABLES[entity.type]
    async with engine.begin() as connection:
        _ = await connection.execute(
            update(table)
            .where(table.c.id == entity.id, table.c.status == "initializing")
            .values(status="ready")
        )


async def read_entity(
    entity: EntityRef, request_id: str | None = None
) -> EntitySnapshot:
    """Read entity status with a specific request, or the latest when no ID is given.

    An explicit request ID must exist for this entity; otherwise raise not found.
    """
    table = _ENTITY_TABLES[entity.type]
    selection = select(requests).where(_request_entity_clause(entity))
    if request_id is not None:
        selection = selection.where(requests.c.request_id == request_id)
    else:
        selection = selection.order_by(
            requests.c.created_at.desc(), requests.c.request_id.desc()
        ).limit(1)
    selected_request = selection.subquery()
    async with engine.begin() as connection:
        result = await connection.execute(
            select(table.c.status.label("entity_status"), selected_request)
            .select_from(table.outerjoin(selected_request, true()))
            .where(table.c.id == entity.id)
        )
        row = result.mappings().one_or_none()
    if row is None:
        raise EntityNotFoundError("Entity registration not found")
    if request_id is not None and row["request_id"] is None:
        raise RequestNotFoundError("Request not found")
    return EntitySnapshot.model_validate(
        {
            "status": row["entity_status"],
            "request": _entity_request(row) if row["request_id"] is not None else None,
        }
    )
