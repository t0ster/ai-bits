"""Shared investigation inputs, scope, report, and graph state models."""

from typing import Annotated, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    model_validator,
)

from lib.core.durdur import RequestStatus
from lib.shared import Id

from .storage import Conversation, ConversationSearchHit


class TimeRange(BaseModel):
    """Timezone-aware start inclusive and end exclusive."""

    start: AwareDatetime
    end: AwareDatetime

    @model_validator(mode="after")
    def validate_order(self):
        if self.start >= self.end:
            raise ValueError("Investigation date range must have start before end")
        return self


class InvestigationScope(BaseModel):
    """Validated retrieval query and conversation filters."""

    query: str = Field(min_length=1)
    time_range: TimeRange
    agent_id: str | None
    team_id: str | None


class InvestigationCitation(BaseModel):
    """Exact quote referencing original transcript entries."""

    conversation_id: str
    transcript_entry_ids: list[str] = Field(min_length=1)
    quote: str


class InvestigationFinding(BaseModel):
    """An explained finding requires at least one supporting citation."""

    title: str
    explanation: str
    citations: list[InvestigationCitation] = Field(min_length=1)


class InvestigationReport(BaseModel):
    """Final result contains only summary and findings; empty findings are allowed."""

    summary: str
    findings: list[InvestigationFinding]


class ScopeResolution(BaseModel):
    """Exactly one resolved scope or scope clarification question."""

    scope: InvestigationScope | None
    question: str | None

    @model_validator(mode="after")
    def validate_resolution(self):
        if (self.scope is None) == (self.question is None):
            raise ValueError("Investigation resolution requires scope or question")
        if self.question is not None and not self.question.strip():
            raise ValueError("Investigation clarification must not be empty")
        return self


class InvestigationReference(BaseModel):
    """Investigation and execution identifiers, without duplicated graph state."""

    investigation_id: Id
    job_id: Id


class SearchInvestigationAction(BaseModel):
    """Search query and page; resolved scope filters cannot be overridden."""

    type: Literal["search"]
    query: str = Field(min_length=1)
    offset: int = Field(ge=0)


class ReadInvestigationAction(BaseModel):
    """Read one conversation by ID."""

    type: Literal["read"]
    conversation_id: str = Field(min_length=1)


class DraftInvestigationAction(BaseModel):
    """Finish gathering evidence and draft the report."""

    type: Literal["draft"]


class InvestigationAction(BaseModel):
    """Discriminated model decision with fields required by its selected operation."""

    action: Annotated[
        SearchInvestigationAction | ReadInvestigationAction | DraftInvestigationAction,
        Field(discriminator="type"),
    ]


class InvestigationClarificationReply(BaseModel):
    """One answered scope clarification, retained for later interpretation."""

    question: str
    reply: str


class InvestigationSearch(BaseModel):
    """Executed search and number of passages returned."""

    query: str
    offset: int
    count: int


class InvestigationState(BaseModel):
    """Checkpointed investigation inputs, evidence, and validated report."""

    question: str
    today: str
    timezone: str
    replies: list[InvestigationClarificationReply] = Field(default_factory=list)
    scope: InvestigationScope | None = None
    clarification_question: str | None = None
    citations_valid: bool | None = None
    draft_report: InvestigationReport | None = None
    report: InvestigationReport | None = None
    search_results: list[ConversationSearchHit] = Field(default_factory=list)
    read_conversations: list[Conversation] = Field(default_factory=list)
    action: InvestigationAction | None = None
    search_history: list[InvestigationSearch] = Field(default_factory=list)


class InvestigationEmptyState(BaseModel):
    """Empty state before the worker saves its first checkpoint."""

    model_config = ConfigDict(extra="forbid")  # pyright: ignore[reportUnannotatedClassAttribute]


class InvestigationClarification(BaseModel):
    """Question emitted by the graph's clarification interrupt."""

    question: str


class InvestigationInterrupt(BaseModel):
    """Pending clarification and the identity required to answer it."""

    id: str
    value: InvestigationClarification


class InvestigationRequest(BaseModel):
    """ID and status of the latest accepted investigation request."""

    request_id: Id
    status: RequestStatus


class InvestigationGraphSnapshot(BaseModel):
    """Graph state and pending clarification, independent of execution bookkeeping."""

    values: InvestigationState | InvestigationEmptyState
    next: (
        Literal[
            "initialize",
            "interpret",
            "clarify",
            "investigate",
            "search",
            "read",
            "draft",
            "validate",
        ]
        | None
    )
    interrupts: tuple[InvestigationInterrupt, ...]
