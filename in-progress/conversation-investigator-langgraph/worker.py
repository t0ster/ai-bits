"""BullMQ worker executing LangGraph with PostgreSQL checkpoints."""

import asyncio
import json
import signal
import sys

from bullmq import Job, Worker

from lib.config import settings
from lib.database.engine import create_checkpointer, engine, pool
from lib.shared import ChatInput, Unvalidated, redis_client
from packages.chat import build_chat_graph
from packages.chat.jobs import chat_send_job
from packages.investigation.jobs import (
    InvestigationReplyJobInput,
    InvestigationStartJobInput,
    build_investigation_graph,
    investigation_reply_job,
    investigation_start_job,
)


async def _run_worker() -> None:
    """Process jobs and drain on termination."""
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)

    saver = create_checkpointer()
    chat_graph = build_chat_graph(saver)
    investigation_graph = build_investigation_graph(saver)

    async def process_job(job: Job, _token: str | None):
        if job.name not in {"chat.send", "investigation.start", "investigation.reply"}:
            raise ValueError(f"Unknown job name: {job.name}")
        if job.data.get("request_id") != str(job.id):
            raise ValueError("Entity job ID does not match its request ID")
        if job.name == "chat.send":
            result = await chat_send_job(chat_graph, Unvalidated(ChatInput, job.data))
        elif job.name == "investigation.start":
            result = await investigation_start_job(
                investigation_graph,
                Unvalidated(InvestigationStartJobInput, job.data),
            )
        else:
            result = await investigation_reply_job(
                investigation_graph,
                Unvalidated(InvestigationReplyJobInput, job.data),
            )
        return result.model_dump(mode="json")

    worker = Worker(
        settings.investigator_queue,
        # BullMQ documents async processors but annotates them as Future.
        process_job,  # pyright: ignore[reportArgumentType]
        {"connection": settings.redis_url, "concurrency": 10},
    )

    def log_worker_error(*_args: object) -> None:
        print(json.dumps({"event": "worker_error"}), file=sys.stderr)

    def log_job_failed(*_args: object) -> None:
        print(json.dumps({"event": "job_failed"}), file=sys.stderr)

    _ = worker.on("error", log_worker_error)
    _ = worker.on("failed", log_job_failed)
    print(json.dumps({"event": "worker_ready"}), flush=True)
    try:
        _ = await stopped.wait()
    finally:
        await worker.close()
        await redis_client.aclose()


async def run_worker() -> None:
    """Own the process database pool for the worker's lifetime."""
    await pool.open()
    try:
        await _run_worker()
    finally:
        await engine.dispose()
        await pool.close()


if __name__ == "__main__":
    asyncio.run(run_worker())
