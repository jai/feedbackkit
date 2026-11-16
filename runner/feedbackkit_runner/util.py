"""The runner's small helpers, moved from Agent Pager's threads hub with the runner: JSON over HTTPS, a decoded JSON
object, a `~/.credentials` record, an owner-only state file, and the note that names a message's screenshots."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from email.message import Message
from pathlib import Path
from typing import IO, NoReturn
from urllib import error, request

# A JSON object as decoded: its values are narrowed with isinstance where they are read.
JsonObject = dict[str, object]

RESPONSE_LIMIT_BYTES = 16 << 20
IMAGE_EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png"}


def json_object(value: object) -> JsonObject:
    """`value` when it is a JSON object, else an empty one: reads a nested field that may be absent or malformed."""
    return value if isinstance(value, dict) else {}


class HttpJsonError(Exception):
    """A request that did not return a JSON object."""

    def __init__(self, reason: str, status: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


@dataclass
class JsonResponse:
    status: int
    body: JsonObject


class _RefuseRedirects(request.HTTPRedirectHandler):
    def redirect_request(
        self, _req: request.Request, _fp: IO[bytes], code: int, _msg: str, _headers: Message, _newurl: str
    ) -> NoReturn:
        raise HttpJsonError(f"HTTP_JSON_REDIRECT_REFUSED: {code:d}", code)


def post_json(url: str, payload: Mapping[str, object], headers: dict[str, str], timeout: float) -> JsonResponse:
    """POST a JSON body; HTTP error statuses come back as JsonResponse when their body is a JSON object. Redirects are
    refused so the bearer never follows one."""
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    outgoing = request.Request(
        url, data=data, method="POST", headers=dict(headers, **{"Content-Type": "application/json"})
    )
    try:
        with request.build_opener(_RefuseRedirects).open(outgoing, timeout=timeout) as response:
            return JsonResponse(response.status, _json_object(response.read(RESPONSE_LIMIT_BYTES + 1)))
    except error.HTTPError as failure:
        try:
            body = _json_object(failure.read(RESPONSE_LIMIT_BYTES + 1))
        except HttpJsonError:
            body = {}
        return JsonResponse(failure.code, body)
    except (error.URLError, OSError, ValueError) as failure:
        raise HttpJsonError(f"HTTP_JSON_UNREACHABLE: {type(failure).__name__}") from failure


def _json_object(raw: bytes) -> JsonObject:
    if len(raw) > RESPONSE_LIMIT_BYTES:
        raise HttpJsonError("HTTP_JSON_RESPONSE_TOO_LARGE")
    try:
        value = json.loads(raw) if raw else {}
    except ValueError as failure:
        raise HttpJsonError("HTTP_JSON_NOT_JSON") from failure
    if not isinstance(value, dict):
        raise HttpJsonError("HTTP_JSON_NOT_OBJECT")
    return value


def credential_record(path: Path, name: str) -> str | None:
    """The value of `NAME=value` (an `export ` prefix and quotes allowed); None when absent or unreadable."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        text = line.strip()
        if text.startswith("export "):
            text = text[len("export ") :].lstrip()
        key, separator, value = text.partition("=")
        if separator and key.strip() == name:
            value = value.strip().strip("'\"")
            return value or None
    return None


def write_private_json(path: Path, value: object) -> None:
    """Owner-only, replaced atomically so a crash never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(dir=str(path.parent), prefix="." + path.name + ".")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        os.chmod(temporary, 0o600)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def image_note(paths: list[str], sender: str) -> str:
    """What the agent reads after a later message's words: where each screenshot is, and that it should look before
    answering."""
    what = "a screenshot" if len(paths) == 1 else f"{len(paths):d} screenshots"
    return "\n\n[{} attached {}. Open each image file and look at it before you answer: {}]".format(
        sender, what, ", ".join(paths)
    )
