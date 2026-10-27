"""Ephemeral broker between agent workers and the native desktop adapter.

Screenshots and accessibility text must stay inside this process-memory broker.
Only request metadata is exposed to the desktop client; the completion token is
one-use and is never written to the event store or logs.
"""

from __future__ import annotations

import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Callable

MAX_PENDING_REQUESTS = 16
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_ACCESSIBILITY_CHARS = 20_000
DEFAULT_TTL_SECONDS = 90


@dataclass
class _PendingObservation:
    id: str
    mission_id: str
    agent_id: str
    purpose: str
    completion_token: str
    expires_monotonic: float
    expires_at: str
    condition: threading.Condition = field(default_factory=threading.Condition)
    status: str = "pending"
    observation: dict | None = None


class ComputerObservationBroker:
    """Match an agent's observe request to one native response in memory."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._lock = threading.RLock()
        self._requests: dict[str, _PendingObservation] = {}
        self._closed = False

    def create(self, mission_id: str, agent_id: str, ttl_seconds: int = DEFAULT_TTL_SECONDS,
               *, purpose: str = "") -> dict[str, str]:
        if not mission_id or not agent_id:
            raise ValueError("mission_and_agent_required")
        if not isinstance(purpose, str) or len(purpose.strip()) > 500:
            raise ValueError("observation_purpose_must_be_at_most_500_characters")
        if not isinstance(ttl_seconds, int) or isinstance(ttl_seconds, bool) or not 1 <= ttl_seconds <= 300:
            raise ValueError("observation_ttl_must_be_1_to_300_seconds")
        with self._lock:
            self._expire_locked()
            if self._closed:
                raise RuntimeError("computer_observation_broker_closed")
            if len(self._requests) >= MAX_PENDING_REQUESTS:
                raise ValueError("too_many_pending_observations")
            created = datetime.now(UTC)
            request_id = str(uuid.uuid4())
            request = _PendingObservation(
                id=request_id,
                mission_id=mission_id,
                agent_id=agent_id,
                purpose=purpose.strip(),
                completion_token=secrets.token_urlsafe(32),
                expires_monotonic=self._clock() + ttl_seconds,
                expires_at=datetime.fromtimestamp(
                    created.timestamp() + ttl_seconds, UTC
                ).isoformat(),
            )
            self._requests[request_id] = request
            return {
                "id": request_id,
                "missionId": mission_id,
                "agentId": agent_id,
                "expiresAt": request.expires_at,
            }

    def pending(self) -> list[dict[str, str]]:
        """Return live requests for the local desktop client, including one-use tokens."""
        with self._lock:
            self._expire_locked()
            return [{
                "id": request.id,
                "missionId": request.mission_id,
                "agentId": request.agent_id,
                "purpose": request.purpose,
                "expiresAt": request.expires_at,
                "completionToken": request.completion_token,
            } for request in self._requests.values() if request.status == "pending"]

    def context(self, request_id: str, completion_token: str) -> dict[str, str]:
        with self._lock:
            self._expire_locked()
            request = self._requests.get(request_id)
            if request is None or request.status not in {"pending", "dispatched", "completed"}:
                raise ValueError("observation_request_not_pending")
            if not secrets.compare_digest(request.completion_token, completion_token):
                raise ValueError("observation_completion_token_invalid")
            return {
                "requestId": request.id,
                "missionId": request.mission_id,
                "agentId": request.agent_id,
            }

    def claim(self, request_id: str, completion_token: str) -> dict[str, str]:
        """Atomically grant the desktop client one attempt to invoke the OS picker."""
        with self._lock:
            self._expire_locked()
            request = self._requests.get(request_id)
            if request is None or request.status != "pending":
                raise ValueError("observation_request_not_pending")
            if not secrets.compare_digest(request.completion_token, completion_token):
                raise ValueError("observation_completion_token_invalid")
            request.status = "dispatched"
            return {
                "id": request.id,
                "missionId": request.mission_id,
                "agentId": request.agent_id,
                "expiresAt": request.expires_at,
                "completionToken": request.completion_token,
            }

    def complete(self, request_id: str, completion_token: str, *,
                 application: str, window_title: str, accessibility_text: str,
                 image: bytes, content_type: str = "image/png") -> dict[str, str]:
        if content_type != "image/png":
            raise ValueError("observation_must_be_png")
        if not isinstance(image, bytes) or not image or len(image) > MAX_IMAGE_BYTES:
            raise ValueError("observation_image_must_be_1_to_5242880_bytes")
        if not isinstance(accessibility_text, str) or len(accessibility_text) > MAX_ACCESSIBILITY_CHARS:
            raise ValueError("accessibility_outline_too_large")
        if not isinstance(application, str) or not application.strip() or len(application) > 200:
            raise ValueError("application_name_required")
        if not isinstance(window_title, str) or len(window_title) > 500:
            raise ValueError("window_title_too_large")

        with self._lock:
            self._expire_locked()
            request = self._requests.get(request_id)
            if request is None or request.status != "dispatched":
                raise ValueError("observation_request_not_pending")
            if not secrets.compare_digest(request.completion_token, completion_token):
                raise ValueError("observation_completion_token_invalid")
            with request.condition:
                request.observation = {
                    "requestId": request.id,
                    "missionId": request.mission_id,
                    "agentId": request.agent_id,
                    "application": application.strip(),
                    "windowTitle": window_title,
                    "accessibilityText": accessibility_text,
                    "image": image,
                    "contentType": content_type,
                }
                request.status = "completed"
                request.condition.notify_all()
        return {
            "requestId": request.id,
            "missionId": request.mission_id,
            "agentId": request.agent_id,
        }

    def wait(self, request_id: str, timeout: float | None = None) -> dict | None:
        with self._lock:
            self._expire_locked()
            request = self._requests.get(request_id)
            if request is None:
                return None
        deadline = min(request.expires_monotonic, self._clock() + timeout) if timeout is not None else request.expires_monotonic
        with request.condition:
            while request.status in {"pending", "dispatched"}:
                remaining = deadline - self._clock()
                if remaining <= 0:
                    break
                request.condition.wait(remaining)
        with self._lock:
            with request.condition:
                if request.status in {"pending", "dispatched"}:
                    if self._clock() < request.expires_monotonic:
                        return None
                    request.status = "expired"
                    request.observation = None
                result = request.observation if request.status == "completed" else None
                self._requests.pop(request_id, None)
            return result

    def is_live(self, request_id: str) -> bool:
        with self._lock:
            self._expire_locked()
            request = self._requests.get(request_id)
            return request is not None and request.status in {"pending", "dispatched", "completed"}

    def cancel(self, request_id: str, mission_id: str | None = None) -> bool:
        with self._lock:
            request = self._requests.get(request_id)
            if request is None or request.status not in {"pending", "dispatched", "completed"}:
                return False
            if mission_id is not None and request.mission_id != mission_id:
                return False
            with request.condition:
                request.status = "cancelled"
                request.observation = None
                self._requests.pop(request_id, None)
                request.condition.notify_all()
        return True

    def cancel_mission(self, mission_id: str) -> int:
        with self._lock:
            requests = [item for item in self._requests.values()
                        if item.mission_id == mission_id
                        and item.status in {"pending", "dispatched", "completed"}]
            for request in requests:
                with request.condition:
                    request.status = "cancelled"
                    request.observation = None
                    self._requests.pop(request.id, None)
                    request.condition.notify_all()
        return len(requests)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            requests = list(self._requests.values())
            for request in requests:
                with request.condition:
                    request.status = "cancelled"
                    request.observation = None
                    self._requests.pop(request.id, None)
                    request.condition.notify_all()

    def _expire_locked(self) -> None:
        expired = [request for request in self._requests.values()
                   if request.expires_monotonic <= self._clock()]
        for request in expired:
            with request.condition:
                request.status = "expired"
                request.observation = None
                request.condition.notify_all()
            self._requests.pop(request.id, None)
