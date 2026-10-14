"""Read investigation state directly from PostgreSQL checkpoints."""

from langgraph.graph import START
from pydantic import BaseModel
from pydantic_core import to_json

from lib.core.durdur import EntityRef, read_entity
from lib.database.engine import create_checkpointer
from lib.shared import Id

from .lib.graph import build_investigation_graph
from .lib.types import InvestigationGraphSnapshot, InvestigationRequest


class InvestigationLookup(BaseModel):
    """Stable investigation identity, independent of retained queue jobs."""

    investigation_id: Id


class InvestigationSnapshot(InvestigationGraphSnapshot):
    """Saved graph snapshot and the latest accepted request, if any."""

    last_request: InvestigationRequest | None


async def get_investigation(request: InvestigationLookup) -> InvestigationSnapshot:
    """Read the saved graph snapshot and the latest accepted request."""
    entity = EntityRef(type="investigation", id=request.investigation_id)
    registration = await read_entity(entity)
    saver = create_checkpointer()
    graph = build_investigation_graph(saver)
    snapshot = await graph.aget_state(
        {
            "configurable": {"thread_id": f"investigation:{request.investigation_id}"},
        }
    )
    if len(snapshot.next) > 1:
        raise ValueError("Investigation snapshot expected at most one next node")
    next_node = snapshot.next[0] if snapshot.next else None
    if next_node == START:
        next_node = "initialize"
    # Normalize LangGraph's native interrupt values at the service boundary.
    return InvestigationSnapshot.model_validate_json(
        to_json(
            {
                "last_request": (
                    {
                        "request_id": registration.request.request_id,
                        "status": registration.request.execution_status,
                    }
                    if registration.request is not None
                    else None
                ),
                "values": snapshot.values,
                "next": next_node,
                "interrupts": snapshot.interrupts,
            }
        )
    )
