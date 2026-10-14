"""Worker-only investigation graph execution."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import date

from langchain_core.runnables import RunnableConfig
from langgraph.graph import START
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command
from pydantic import BaseModel, Field
from pydantic_core import to_json

from lib.core.durdur import (
    EntityRef,
    claim_entity_request,
    finish_entity_request,
)
from lib.shared import Id, Unvalidated

from .lib.events import (
    InvestigationDoneEvent,
    InvestigationErrorEvent,
    InvestigationSnapshotEvent,
    publish_investigation_event,
)
from .lib.graph import build_investigation_graph
from .lib.types import (
    InvestigationGraphSnapshot,
    InvestigationReference,
)

__all__ = [
    "InvestigationReplyJobInput",
    "InvestigationStartJobInput",
    "build_investigation_graph",
    "investigation_reply_job",
    "investigation_start_job",
]


class InvestigationStartJobInput(BaseModel):
    """Start job input with reference date and timezone fixed at submission."""

    request_id: Id
    investigation_id: Id
    question: str = Field(min_length=1)
    today: date
    timezone: str = Field(min_length=1)


class InvestigationReplyJobInput(BaseModel):
    """Reply job input identifying the saved clarification to resume."""

    request_id: Id
    investigation_id: Id
    clarification_id: str = Field(min_length=1)
    reply: str = Field(min_length=1)


# TODO: Failures after acceptance (e.g. LLM errors) are terminal; support
# retrying a failed investigation.
@asynccontextmanager
async def _investigation_execution(
    reference: InvestigationReference,
) -> AsyncGenerator[None]:
    entity = EntityRef(type="investigation", id=reference.investigation_id)
    try:
        await claim_entity_request(entity, reference.job_id)
        try:
            yield
        except Exception:
            await finish_entity_request(entity, reference.job_id, "failed")
            raise
        # Completion errors preserve the running reservation.
        await finish_entity_request(entity, reference.job_id, "completed")
    except Exception:
        # Observed bookkeeping failures still terminate the live stream.
        await publish_investigation_event(
            reference,
            InvestigationErrorEvent(message="Investigation execution failed."),
        )
        raise
    await publish_investigation_event(reference, InvestigationDoneEvent())


async def investigation_start_job(
    graph: CompiledStateGraph,
    payload: Unvalidated[InvestigationStartJobInput],
) -> InvestigationReference:
    """Claim before scope resolution; uncertain termination retains the reservation."""
    request = payload.validate()
    investigation_id = request.investigation_id
    result = InvestigationReference(
        investigation_id=request.investigation_id, job_id=request.request_id
    )
    async with _investigation_execution(result):
        await _execute_investigation(
            graph,
            result,
            {
                "question": request.question,
                "today": request.today.isoformat(),
                "timezone": request.timezone,
                "replies": [],
                "scope": None,
                "clarification_question": None,
            },
            {"configurable": {"thread_id": f"investigation:{investigation_id}"}},
        )
    return result


async def investigation_reply_job(
    graph: CompiledStateGraph, payload: Unvalidated[InvestigationReplyJobInput]
) -> InvestigationReference:
    """Claim before checking clarification; stale replies fail and release the slot."""
    request = payload.validate()
    result = InvestigationReference(
        investigation_id=request.investigation_id, job_id=request.request_id
    )
    async with _investigation_execution(result):
        config: RunnableConfig = {
            "configurable": {"thread_id": f"investigation:{request.investigation_id}"}
        }
        state = await graph.aget_state(config)
        if not any(item.id == request.clarification_id for item in state.interrupts):
            raise ValueError("Investigation clarification is not pending")
        await _execute_investigation(
            graph,
            result,
            Command(resume={request.clarification_id: request.reply}),
            config,
        )
    return result


async def _execute_investigation(
    graph: CompiledStateGraph,
    reference: InvestigationReference,
    graph_input: dict[str, object] | Command,
    config: RunnableConfig,
) -> None:
    """Stream full graph snapshots; interrupt updates carry the final clarification."""
    snapshot: InvestigationGraphSnapshot | None = None
    async for event in graph.astream(
        graph_input,
        config,
        stream_mode=["checkpoints", "updates"],
        durability="sync",
        version="v2",
    ):
        if event["type"] == "checkpoints":
            data = event["data"]
            next_nodes = data["next"]
            if len(next_nodes) > 1:
                raise ValueError(
                    "Investigation snapshot expected at most one next node"
                )
            next_node = next_nodes[0] if next_nodes else None
            snapshot = InvestigationGraphSnapshot.model_validate_json(
                to_json(
                    {
                        "values": data["values"],
                        "next": "initialize" if next_node == START else next_node,
                        "interrupts": [
                            interrupt
                            for task in data["tasks"]
                            for interrupt in task.get("interrupts", [])
                        ],
                    }
                )
            )
        elif (
            event["type"] == "updates"
            and "__interrupt__" in event["data"]
            and snapshot is not None
        ):
            snapshot = InvestigationGraphSnapshot.model_validate_json(
                to_json(
                    {
                        **snapshot.model_dump(),
                        "interrupts": event["data"]["__interrupt__"],
                    }
                )
            )
        else:
            continue
        await publish_investigation_event(
            reference, InvestigationSnapshotEvent(snapshot=snapshot)
        )
