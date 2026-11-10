"""Read-only access to public GitHub Actions workflow-run metadata."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from typing import Any, Callable

GITHUB_API_ROOT = "https://api.github.com"
GITHUB_API_VERSION = "2026-03-10"
MAX_RESPONSE_BYTES = 2_000_000
_OWNER = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_CONCLUSIONS = {
    "success", "failure", "cancelled", "timed_out", "action_required",
    "neutral", "skipped", "stale",
}


class GitHubActionsError(ValueError):
    """A safe, user-facing GitHub Actions source error."""

    def __init__(self, code: str, *, rate_limit: dict[str, Any] | None = None,
                 retry_at: str = "") -> None:
        super().__init__(code)
        self.rate_limit = rate_limit or {}
        self.retry_at = retry_at


def _response_rate_limit(headers: Any) -> dict[str, Any]:
    if headers is None:
        return {}
    result: dict[str, Any] = {}
    for header, key in (("X-RateLimit-Limit", "limit"), ("X-RateLimit-Remaining", "remaining")):
        try:
            value = int(headers.get(header, ""))
        except (TypeError, ValueError):
            continue
        if 0 <= value <= 1_000_000:
            result[key] = value
    try:
        reset = int(headers.get("X-RateLimit-Reset", ""))
        if reset > 0:
            result["reset_at"] = datetime.fromtimestamp(reset, UTC).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        pass
    return result


def _retry_at(headers: Any, rate_limit: dict[str, Any]) -> str:
    retry_after = ""
    try:
        retry_after = headers.get("Retry-After", "") if headers else ""
    except AttributeError:
        pass
    try:
        delay = int(retry_after)
    except (TypeError, ValueError):
        delay = 0
    if 0 < delay <= 86_400:
        return (datetime.now(UTC) + timedelta(seconds=delay)).isoformat()
    reset_at = rate_limit.get("reset_at", "")
    if reset_at and rate_limit.get("remaining") == 0:
        return reset_at
    return (datetime.now(UTC) + timedelta(minutes=1)).isoformat()


def parse_public_repository(value: str) -> tuple[str, str]:
    """Accept an owner/repository pair or canonical public GitHub URL."""
    if not isinstance(value, str) or len(value) > 512:
        raise GitHubActionsError("github_repository_invalid")
    text = value.strip()
    if text.startswith("https://"):
        try:
            parsed = urllib.parse.urlsplit(text)
            port = parsed.port
        except ValueError as error:
            raise GitHubActionsError("github_repository_invalid") from error
        if (parsed.scheme != "https" or parsed.hostname != "github.com" or port
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise GitHubActionsError("github_repository_must_be_a_public_github_repository")
        text = parsed.path.strip("/")
        if text.endswith(".git"):
            text = text[:-4]
    if text.count("/") != 1:
        raise GitHubActionsError("github_repository_invalid")
    owner, repository = text.split("/", 1)
    if (not _OWNER.fullmatch(owner) or not _REPOSITORY.fullmatch(repository)
            or repository in {".", ".."}):
        raise GitHubActionsError("github_repository_invalid")
    return owner, repository


def workflow_runs_url(repository: str, branch: str = "") -> str:
    owner, name = parse_public_repository(repository)
    query: dict[str, str] = {"status": "completed", "per_page": "100"}
    if branch:
        if (not isinstance(branch, str) or len(branch) > 250
                or any(ord(char) < 32 for char in branch)):
            raise GitHubActionsError("github_branch_invalid")
        query["branch"] = branch
    path = "/repos/{}/{}/actions/runs".format(
        urllib.parse.quote(owner, safe=""),
        urllib.parse.quote(name, safe=""),
    )
    return f"{GITHUB_API_ROOT}{path}?{urllib.parse.urlencode(query)}"


def _clean_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join("".join(char if ord(char) >= 32 else " " for char in value).split())[:limit]


def _clean_run(item: Any, repository: str) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    run_id = item.get("id")
    workflow_id = item.get("workflow_id")
    if (not isinstance(run_id, int) or isinstance(run_id, bool) or run_id < 1
            or not isinstance(workflow_id, int) or isinstance(workflow_id, bool) or workflow_id < 1
            or item.get("status") != "completed"
            or item.get("conclusion") not in _CONCLUSIONS):
        return None
    owner, repo = parse_public_repository(repository)
    url = item.get("html_url")
    expected_prefix = f"https://github.com/{owner}/{repo}/actions/runs/{run_id}"
    if not isinstance(url, str) or url.lower() != expected_prefix.lower():
        return None
    updated_at = item.get("updated_at")
    if not isinstance(updated_at, str) or len(updated_at) > 40:
        return None
    try:
        datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return {
        "id": run_id,
        "workflow_id": workflow_id,
        "run_number": item.get("run_number") if isinstance(item.get("run_number"), int) else None,
        "name": _clean_text(item.get("name"), 160),
        "display_title": _clean_text(item.get("display_title"), 240),
        "event": _clean_text(item.get("event"), 80),
        "head_branch": _clean_text(item.get("head_branch"), 250),
        "head_sha": _clean_text(item.get("head_sha"), 64),
        "conclusion": item["conclusion"],
        "updated_at": updated_at,
        "html_url": expected_prefix,
    }


def parse_completed_runs(payload: Any, repository: str) -> list[dict[str, Any]]:
    """Keep only bounded fields needed to form source-linked CI events."""
    if not isinstance(payload, dict) or not isinstance(payload.get("workflow_runs"), list):
        raise GitHubActionsError("github_actions_response_invalid")
    runs = [
        cleaned for item in payload["workflow_runs"][:100]
        if (cleaned := _clean_run(item, repository)) is not None
    ]
    return sorted(runs, key=lambda item: item["id"])


class _GitHubApiRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: Any, fp: Any, code: int, message: str,
                         headers: Any, new_url: str) -> Any:
        try:
            target = urllib.parse.urlsplit(new_url)
            port = target.port
        except ValueError as error:
            raise GitHubActionsError("github_actions_redirect_rejected") from error
        if target.scheme != "https" or target.hostname != "api.github.com" or port:
            raise GitHubActionsError("github_actions_redirect_rejected")
        return super().redirect_request(request, fp, code, message, headers, new_url)


def _open_github_api(request: urllib.request.Request, *, timeout: float) -> Any:
    opener = urllib.request.build_opener(_GitHubApiRedirectHandler())
    return opener.open(request, timeout=timeout)


def fetch_public_workflow_runs(
    repository: str,
    branch: str = "",
    *,
    timeout: float = 8,
    open_url: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Fetch public workflow-run metadata from GitHub's fixed API origin."""
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 < timeout <= 15:
        raise GitHubActionsError("github_actions_timeout_invalid")
    url = workflow_runs_url(repository, branch)
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "Tribe-local-event-trigger",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    })
    rate_limit: dict[str, Any] = {}
    try:
        with (open_url or _open_github_api)(request, timeout=timeout) as response:
            status = getattr(response, "status", response.getcode())
            rate_limit = _response_rate_limit(getattr(response, "headers", None))
            if status != 200:
                raise GitHubActionsError("github_actions_request_failed", rate_limit=rate_limit)
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code == 403 or error.code == 429:
            rate_limit = _response_rate_limit(error.headers)
            raise GitHubActionsError(
                "github_actions_rate_limited_or_forbidden", rate_limit=rate_limit,
                retry_at=_retry_at(error.headers, rate_limit),
            ) from error
        if error.code == 404:
            raise GitHubActionsError("github_repository_not_found_or_private") from error
        raise GitHubActionsError("github_actions_request_failed") from error
    except (OSError, TimeoutError) as error:
        raise GitHubActionsError("github_actions_unavailable") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise GitHubActionsError("github_actions_response_too_large")
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GitHubActionsError("github_actions_response_invalid") from error
    return {
        "repository": "/".join(parse_public_repository(repository)),
        "fetched_at": datetime.now(UTC).isoformat(),
        "rate_limit": rate_limit,
        "runs": parse_completed_runs(payload, repository),
    }
