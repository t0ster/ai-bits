"""JSON-output CLI for conversation ingestion, chat, and investigations."""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import aclosing
from pathlib import Path
from typing import Annotated

import typer
from pydantic_core import to_json

from lib.core.durdur import EntityRequestError
from lib.database.engine import engine, pool, setup_database
from lib.shared import (
    ChatInput,
    HistoryInput,
    queue,
    redis_client,
)
from packages.chat.read_chat_history import read_chat_history
from packages.chat.send_chat_message import send_chat_message
from packages.ingestion.ingest_conversations import (
    IngestInput,
    ingest_conversations,
)
from packages.investigation import InvestigationEvent
from packages.investigation.get_investigation import (
    InvestigationLookup,
    get_investigation,
)
from packages.investigation.reply_investigation import (
    InvestigationReply,
    reply_investigation,
)
from packages.investigation.start_investigation import (
    InvestigationStart,
    start_investigation,
)

runner = asyncio.Runner()


app = typer.Typer(
    add_completion=False,
    pretty_exceptions_enable=False,
    no_args_is_help=True,
    help="Investigate conversations. Commands print JSON.",
)


chat = typer.Typer(
    no_args_is_help=True, help="Stream chat replies and inspect history."
)
investigation = typer.Typer(
    no_args_is_help=True,
    help="Start investigations, read scope, and answer clarifications.",
)
app.add_typer(investigation, name="investigation")
app.add_typer(chat, name="chat")


@app.command("setup-database")
def setup_database_command() -> None:
    """Create all application and checkpoint tables and missing indexes."""
    runner.run(setup_database())
    print(to_json({"status": "ready"}).decode())


# Required --request-id option shared by commands that enqueue work.
RequestIdOption = Annotated[
    str, typer.Option(help="Globally unique request ID; also the BullMQ job ID.")
]
# Required --investigation-id option shared by investigation start and reply.
InvestigationIdOption = Annotated[str, typer.Option(help="Investigation ID.")]


@app.command("ingest")
def ingest(
    path: Annotated[
        Path, typer.Argument(help="JSONL file, one conversation per line.")
    ],
) -> None:
    """Ingest conversations from a JSONL file."""
    request = IngestInput.model_validate({"path": path})
    print(runner.run(ingest_conversations(request.path)).model_dump_json())


@chat.command("send")
def chat_send(
    message: Annotated[str, typer.Argument(help="Message text.")],
    thread_id: Annotated[str, typer.Option(help="Chat thread ID.")],
    message_id: Annotated[str, typer.Option(help="Message ID.")],
    request_id: RequestIdOption,
) -> None:
    """Print live or saved chat events as JSON."""
    request = ChatInput.model_validate(
        {
            "request_id": request_id,
            "message_id": message_id,
            "message": message,
            "thread_id": thread_id,
        }
    )

    async def print_events() -> None:
        async for event in send_chat_message(request):
            if event is not None:
                print(event.model_dump_json(), flush=True)

    runner.run(print_events())


@chat.command("history")
def get_chat_history(
    thread_id: Annotated[str, typer.Argument(help="Chat thread ID.")],
) -> None:
    """Return saved messages for the supplied thread ID."""
    request = HistoryInput.model_validate({"thread_id": thread_id})
    result = runner.run(asyncio.wait_for(read_chat_history(request), timeout=10))
    print(result.model_dump_json(exclude_none=True))


async def _print_investigation_events(
    events: AsyncGenerator[InvestigationEvent | None],
) -> None:
    async with aclosing(events):
        async for event in events:
            if event is not None:
                print(event.model_dump_json(), flush=True)


@investigation.command("start")
def investigation_start(
    question: Annotated[str, typer.Argument(help="Investigation question.")],
    investigation_id: InvestigationIdOption,
    request_id: RequestIdOption,
    today: Annotated[
        str | None,
        typer.Option(help="Reference date (YYYY-MM-DD); defaults to today."),
    ] = None,
) -> None:
    """Submit a question and print execution events as JSON lines."""
    request = InvestigationStart.model_validate(
        {
            "request_id": request_id,
            "investigation_id": investigation_id,
            "question": question,
            "today": today,
        }
    )
    runner.run(_print_investigation_events(start_investigation(request)))


@investigation.command("get")
def investigation_get(
    investigation_id: Annotated[str, typer.Argument(help="Investigation ID.")],
) -> None:
    """Read saved graph state by investigation ID, independently of queue jobs."""
    request = InvestigationLookup.model_validate({"investigation_id": investigation_id})
    result = runner.run(get_investigation(request))
    print(to_json(result).decode())


@investigation.command("reply")
def investigation_reply(
    reply: Annotated[str, typer.Argument(help="Clarification reply.")],
    investigation_id: InvestigationIdOption,
    clarification_id: Annotated[
        str, typer.Option(help="Clarification ID from the current interrupt.")
    ],
    request_id: RequestIdOption,
) -> None:
    """Submit a clarification reply and print execution events as JSON lines."""
    request = InvestigationReply.model_validate(
        {
            "request_id": request_id,
            "investigation_id": investigation_id,
            "clarification_id": clarification_id,
            "reply": reply,
        }
    )
    runner.run(_print_investigation_events(reply_investigation(request)))


def main() -> None:
    """Run the CLI and close its queue before the event loop shuts down."""
    with runner:
        runner.run(pool.open())
        try:
            app()
        except EntityRequestError as error:
            print(
                to_json({"error": {"code": error.code, "message": str(error)}}).decode()
            )
            raise SystemExit(1) from error
        finally:
            runner.run(engine.dispose())
            runner.run(pool.close())
            runner.run(queue.close())
            runner.run(redis_client.aclose())


if __name__ == "__main__":
    main()
