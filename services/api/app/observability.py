from __future__ import annotations

import json
import logging
import math
import os
import re
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from fastapi import Request


SCHEMA_VERSION = "castingcompass.log/1.0.0"
SERVICE = "castingcompass-api"
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:/-]{1,160}$")
SAFE_FIELD_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
FORBIDDEN_FIELD_NAME = re.compile(
    r"(^|_)(account_id|actor|authorization|body|cookie|coordinates|email|ip_address|latitude|"
    r"longitude|note|object_key|password|passphrase|payload|photo_key|prompt|secret|site_id|"
    r"token|trip_id|user_id)(_|$)"
)
RESERVED_FIELD_NAMES = {
    "actor_session_key",
    "environment",
    "event",
    "level",
    "method",
    "operation_id",
    "request_id",
    "route",
    "schema_version",
    "service",
    "timestamp",
    "trace_id",
    "worker_version_id",
}
LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}


@dataclass(frozen=True)
class ApiLogContext:
    request_id: str
    trace_id: str | None
    environment: str
    method: str
    route: str
    minimum_level: int


_context: ContextVar[ApiLogContext | None] = ContextVar("castingcompass_api_log_context", default=None)


def configure_logger(logger: logging.Logger) -> None:
    logger.setLevel(_configured_level())


def begin_request(request: Request) -> Token[ApiLogContext | None]:
    hostname = request.url.hostname or ""
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        environment = "development"
    elif hostname.endswith(".onrender.com"):
        environment = "preview"
    elif request.url.scheme == "https" and hostname == "api.castingcompass.com":
        environment = "production"
    else:
        environment = "unknown"
    context = ApiLogContext(
        request_id=str(uuid.uuid4()),
        trace_id=_safe_trace_identifier(request.headers.get("CF-Ray")),
        environment=environment,
        method=request.method if request.method in {"GET", "HEAD", "OPTIONS"} else "OTHER",
        route=route_template(request.url.path),
        minimum_level=_configured_level(),
    )
    return _context.set(context)


def end_request(token: Token[ApiLogContext | None]) -> None:
    _context.reset(token)


def current_request_id() -> str | None:
    return _context.get().request_id if _context.get() else None


def log_event(logger: logging.Logger, level: str, event: str, **fields: Any) -> None:
    numeric_level = LEVELS.get(level, logging.INFO)
    context = _context.get()
    minimum_level = context.minimum_level if context else _configured_level()
    if numeric_level < minimum_level:
        return
    entry: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "service": SERVICE,
        "level": level if level in LEVELS else "info",
        "event": event if re.fullmatch(r"[a-z][a-z0-9_.]{0,95}", event) else "observability.invalid_event",
    }
    if context:
        entry.update(
            request_id=context.request_id,
            trace_id=context.trace_id,
            environment=context.environment,
            method=context.method,
            route=context.route,
        )
    for key, value in fields.items():
        if key in RESERVED_FIELD_NAMES or not SAFE_FIELD_NAME.fullmatch(key) or FORBIDDEN_FIELD_NAME.search(key):
            continue
        sanitized = _safe_value(value)
        if sanitized is not None:
            entry[key] = sanitized
    logger.log(numeric_level, json.dumps(entry, separators=(",", ":"), sort_keys=True))


def safe_error_fields(error: object, code: str = "internal_error") -> dict[str, str]:
    return {
        "error_name": _safe_identifier(type(error).__name__) or "UnknownError",
        "error_code": _safe_identifier(code) or "internal_error",
    }


def route_template(path: str) -> str:
    if path in {"/health", "/v1/sites", "/v1/opportunities", "/docs", "/redoc", "/openapi.json"}:
        return path
    if re.fullmatch(r"/v1/sites/[a-z0-9-]+", path):
        return "/v1/sites/:site_id"
    return "/:unknown"


def _safe_identifier(value: object) -> str | None:
    return value if isinstance(value, str) and SAFE_IDENTIFIER.fullmatch(value) else None


def _safe_trace_identifier(value: object) -> str | None:
    if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{16,32}(?:-[A-Za-z]{3})?", value):
        return value
    return None


def _configured_level() -> int:
    return LEVELS.get(os.getenv("LOG_LEVEL", "info").lower(), logging.INFO)


def _safe_value(value: object) -> str | int | float | bool | list[str] | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return value if SAFE_IDENTIFIER.fullmatch(value) else None
    if isinstance(value, (list, tuple)):
        identifiers = [item for item in value[:16] if isinstance(item, str) and SAFE_IDENTIFIER.fullmatch(item)]
        return identifiers or None
    return None
