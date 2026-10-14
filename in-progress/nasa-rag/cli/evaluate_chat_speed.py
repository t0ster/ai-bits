"""Compare Chat API throughput with one request per model and no retries.

Usage: uv run --no-sync cli/evaluate_chat_speed.py --request request.json
The file is a Chat Completions request body containing messages. Model is overridden. Output rates include request latency, not just token decoding.
"""

import argparse
import json
import time
from collections.abc import Iterable
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from lib.config import settings


def read_chat_stream(response: Iterable[bytes]) -> dict:
    """Read Chat SSE events through DONE, retaining model and final token usage."""
    result = {}
    event_lines = []
    for raw_line in response:
        line = raw_line.decode("utf-8").rstrip("\r\n")
        if line.startswith("data:"):
            event_lines.append(line[5:].lstrip(" "))
        elif not line and event_lines:
            event = "\n".join(event_lines)
            event_lines.clear()
            if event == "[DONE]":
                return result
            chunk = json.loads(event)
            if chunk.get("error"):
                raise ValueError("Chat speed stream returned an error")
            if chunk.get("model"):
                result["model"] = chunk["model"]
            if chunk.get("usage"):
                result["usage"] = chunk["usage"]
    raise ValueError("Chat speed stream ended before DONE")


def evaluate_chat_speed() -> int:
    """Print one result per model; missing usage stays unknown, never zero."""
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument(
        "--request", type=Path, required=True, help="Chat request JSON"
    )
    _ = parser.add_argument("--output", type=Path, help="Save results as JSON")
    _ = parser.add_argument(
        "--stream",
        action="store_true",
        help="Use streaming Chat API with final token usage",
    )
    args = parser.parse_args()
    payload = json.loads(args.request.read_text())
    if not isinstance(payload, dict) or not isinstance(payload.get("messages"), list):
        parser.error("Chat speed request must contain a messages array")
    if not payload["messages"]:
        parser.error("Chat speed request messages must not be empty")
    if payload.get("n", 1) != 1:
        parser.error("Chat speed request must generate exactly one completion")
    payload.pop("stream", None)
    payload.pop("stream_options", None)
    if args.stream:
        payload.update(stream=True, stream_options={"include_usage": True})
    results = []
    failed = False
    for model in settings.chat_speed_models:
        body = {**payload, "model": model}
        request = Request(
            str(settings.generation_base_url).rstrip("/") + "/chat/completions",
            data=json.dumps(body).encode(),
            headers={
                "Authorization": "Bearer "
                + settings.generation_api_key.get_secret_value(),
                "Content-Type": "application/json",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urlopen(request, timeout=120) as response:
                data = (
                    read_chat_stream(response)
                    if args.stream
                    else json.loads(response.read())
                )
            elapsed = time.perf_counter() - started
            usage = data.get("usage") or {}
            output = usage.get("completion_tokens")
            result = {
                "model": model,
                "returned_model": data.get("model"),
                "stream": args.stream,
                "seconds": round(elapsed, 3),
                "input_tokens": usage.get("prompt_tokens"),
                "output_tokens": output,
                "tokens_per_second": round(output / elapsed, 2)
                if output is not None
                else None,
            }
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            failed = True
            result = {
                "model": model,
                "seconds": round(time.perf_counter() - started, 3),
                "error": type(error).__name__,
                "http_status": error.code if isinstance(error, HTTPError) else None,
            }
        results.append(result)
        print(json.dumps(result), flush=True)
        if args.output:
            args.output.write_text(json.dumps(results, indent=2) + "\n")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(evaluate_chat_speed())
