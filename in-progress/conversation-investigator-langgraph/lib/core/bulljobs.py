"""Typed BullMQ job state lookup."""

from typing import Literal, cast

from bullmq import Queue

JobState = Literal[
    "completed",
    "failed",
    "delayed",
    "prioritized",
    "active",
    "waiting",
    "waiting-children",
    "unknown",
]


async def queue_get_job_state(queue: Queue, job_id: str) -> JobState:
    """Read the queue state without loading job data or results."""
    return cast(JobState, await queue.getJobState(job_id))
