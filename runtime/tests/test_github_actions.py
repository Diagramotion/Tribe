from __future__ import annotations

import io
import json
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from tribe_runtime.github_actions import (
    GITHUB_API_ROOT,
    GitHubActionsError,
    fetch_public_workflow_runs,
    parse_completed_runs,
    parse_public_repository,
    workflow_runs_url,
)
from tribe_runtime.store import MissionStore


class _Response(io.BytesIO):
    status = 200

    def __init__(self, *args: object, headers: dict[str, str] | None = None) -> None:
        super().__init__(*args)
        self.headers = headers or {}

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def getcode(self) -> int:
        return self.status


def _run(run_id: int, **overrides: object) -> dict[str, object]:
    return {
        "id": run_id,
        "workflow_id": 3,
        "run_number": run_id,
        "name": "Checks",
        "display_title": "Update dependency",
        "event": "pull_request",
        "status": "completed",
        "conclusion": "failure",
        "head_branch": "feature/test",
        "head_sha": "a" * 40,
        "updated_at": "2026-11-02T01:02:03Z",
        "html_url": f"https://github.com/tribe-fixtures/sample/actions/runs/{run_id}",
        **overrides,
    }


class GitHubActionsTests(unittest.TestCase):
    def test_accepts_only_a_public_github_repository_identifier(self) -> None:
        self.assertEqual(parse_public_repository("Tribe-Fixtures/Sample"), ("Tribe-Fixtures", "Sample"))
        self.assertEqual(
            parse_public_repository("https://github.com/Tribe-Fixtures/Sample.git"),
            ("Tribe-Fixtures", "Sample"),
        )
        for value in (
            "https://github.com.evil/owner/repo",
            "https://user@github.com/owner/repo",
            "https://github.com/owner/repo?token=secret",
            "https://github.com/owner/repo#branch",
            "owner/repo/extra",
            "../repo",
            "owner/..",
        ):
            with self.subTest(value=value), self.assertRaises(GitHubActionsError):
                parse_public_repository(value)

    def test_constructs_a_fixed_github_api_url_and_encodes_branch(self) -> None:
        url = workflow_runs_url("owner/repo", "release/next")
        parsed = urllib.parse.urlsplit(url)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "api.github.com")
        self.assertEqual(parsed.path, "/repos/owner/repo/actions/runs")
        self.assertEqual(
            urllib.parse.parse_qs(parsed.query),
            {"status": ["completed"], "per_page": ["100"], "branch": ["release/next"]},
        )
        with self.assertRaisesRegex(GitHubActionsError, "github_branch_invalid"):
            workflow_runs_url("owner/repo", "main\nbranch")

    def test_keeps_only_valid_completed_runs_and_minimal_source_linked_fields(self) -> None:
        payload = {
            "workflow_runs": [
                _run(8, display_title="Private\u0000 instruction"),
                _run(12, status="in_progress"),
                _run(14, html_url="https://attacker.invalid/collect"),
                _run(5, conclusion="success"),
            ],
            "repository": {"description": "This unneeded field is ignored"},
        }

        runs = parse_completed_runs(payload, "tribe-fixtures/sample")

        self.assertEqual([run["id"] for run in runs], [5, 8])
        self.assertEqual(runs[1]["display_title"], "Private instruction")
        self.assertEqual(runs[1]["html_url"], "https://github.com/tribe-fixtures/sample/actions/runs/8")
        self.assertNotIn("repository", runs[0])
        self.assertNotIn("actor", runs[0])

    def test_fetch_uses_anonymous_read_only_request_and_returns_bounded_run_data(self) -> None:
        response = _Response(
            json.dumps({"workflow_runs": [_run(8)]}).encode(),
            headers={"X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "52",
                     "X-RateLimit-Reset": str(int((datetime.now(UTC) + timedelta(minutes=30)).timestamp()))},
        )
        captured: dict[str, object] = {}

        def open_url(request: urllib.request.Request, *, timeout: float) -> _Response:
            captured["request"] = request
            captured["timeout"] = timeout
            return response

        result = fetch_public_workflow_runs("tribe-fixtures/sample", open_url=open_url)

        request = captured["request"]
        assert isinstance(request, urllib.request.Request)
        self.assertTrue(request.full_url.startswith(f"{GITHUB_API_ROOT}/repos/"))
        self.assertEqual(request.get_header("Authorization"), None)
        self.assertEqual(request.get_header("X-github-api-version"), "2026-03-10")
        self.assertEqual(captured["timeout"], 8)
        self.assertEqual(result["repository"], "tribe-fixtures/sample")
        self.assertEqual([run["id"] for run in result["runs"]], [8])
        self.assertEqual(result["rate_limit"]["limit"], 60)
        self.assertEqual(result["rate_limit"]["remaining"], 52)
        self.assertTrue(result["rate_limit"]["reset_at"])
        self.assertIn("fetched_at", result)

    def test_maps_rate_limits_and_oversized_responses_to_safe_errors(self) -> None:
        def rate_limited(_request: urllib.request.Request, *, timeout: float) -> _Response:
            raise urllib.error.HTTPError(
                "https://api.github.com", 403, "rate limit",
                {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(int((datetime.now(UTC) + timedelta(minutes=5)).timestamp()))},
                None,
            )

        with self.assertRaisesRegex(GitHubActionsError, "rate_limited_or_forbidden"):
            fetch_public_workflow_runs("owner/repo", open_url=rate_limited)

        try:
            fetch_public_workflow_runs("owner/repo", open_url=rate_limited)
        except GitHubActionsError as error:
            self.assertEqual(error.rate_limit["remaining"], 0)
            self.assertTrue(error.retry_at)
        else:
            self.fail("expected a rate limit error")

        class LargeResponse(_Response):
            def read(self, size: int = -1) -> bytes:
                return b"x" * size

        with self.assertRaisesRegex(GitHubActionsError, "response_too_large"):
            fetch_public_workflow_runs(
                "owner/repo", open_url=lambda _request, **_kwargs: LargeResponse(b""),
            )

    def test_secondary_rate_limit_honours_retry_after(self) -> None:
        before = datetime.now(UTC)

        def rate_limited(_request: urllib.request.Request, *, timeout: float) -> _Response:
            raise urllib.error.HTTPError(
                "https://api.github.com", 429, "secondary rate limit",
                {"Retry-After": "75", "X-RateLimit-Remaining": "8"}, None,
            )

        with self.assertRaises(GitHubActionsError) as caught:
            fetch_public_workflow_runs("owner/repo", open_url=rate_limited)

        retry_at = datetime.fromisoformat(caught.exception.retry_at)
        self.assertGreaterEqual(retry_at, before + timedelta(seconds=74))
        self.assertLessEqual(retry_at, before + timedelta(seconds=76))

    def test_public_ci_failure_becomes_one_durable_project_event_after_explicit_access(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-github-trigger-") as directory:
            root = Path(directory)
            repository = root / "project"
            repository.mkdir()
            store = MissionStore(root / "tribe.sqlite3")
            project, source = store.create_project(
                str(repository), "Public CI", "Monitor builds", "Review failed builds",
            )
            kwargs = {
                "project_id": project["id"], "title": "Review CI failures",
                "prompt": "Investigate failed builds", "cadence": "event", "timezone": "UTC",
                "trigger_event_type": "github.workflow_run.failed",
                "event_source_mission_id": source["id"],
                "event_external_repository": "tribe-fixtures/sample",
            }
            with self.assertRaisesRegex(ValueError, "github_actions_requires_project_web_access"):
                store.create_schedule(**kwargs)

            store.set_project_web_access(project["id"], True, ["api.github.com"])
            schedule = store.create_schedule(**kwargs)
            self.assertEqual(schedule["event_external_repository"], "tribe-fixtures/sample")
            self.assertGreater(schedule["event_external_next_poll_at"], schedule["created_at"])

            with store._connect() as db:
                db.execute(
                    "UPDATE schedules SET event_external_next_poll_at=? WHERE id=?",
                    ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), schedule["id"]),
                )
            groups = store.claim_due_github_action_polls()
            self.assertEqual(groups[0]["repository"], "tribe-fixtures/sample")
            self.assertEqual([item["id"] for item in groups[0]["schedules"]], [schedule["id"]])
            self.assertEqual(store.claim_due_github_action_polls(), [])

            future = (datetime.now(UTC) + timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
            runs = [_run(22, updated_at=future), _run(23, updated_at=future, name="Release checks")]
            result = store.record_github_action_poll(schedule["id"], runs)
            self.assertTrue(result["published"])
            self.assertEqual(result["cursor"], 23)
            self.assertFalse(store.record_github_action_poll(schedule["id"], runs)["published"])
            with store._connect() as db:
                event = db.execute(
                    "SELECT payload FROM events WHERE sequence=?", (result["eventSequence"],),
                ).fetchone()
            payload = json.loads(event["payload"])
            self.assertEqual(payload["failureCount"], 2)
            self.assertEqual([item["runId"] for item in payload["runs"]], [22, 23])

            claimed = store.claim_event_schedules()
            self.assertEqual(len(claimed), 1)
            triggered = store.mission(claimed[0]["missionId"])
            self.assertIn("A GitHub Actions workflow failed", triggered["goal"])
            self.assertIn("tribe-fixtures/sample", triggered["goal"])
            self.assertIn("untrusted context", triggered["goal"])
            self.assertEqual(store.claim_event_schedules(), [])
    def test_anonymous_api_budget_is_shared_and_survives_store_restart(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-github-quota-") as directory:
            path = Path(directory) / "tribe.sqlite3"
            store = MissionStore(path)
            current = datetime(2026, 11, 2, 12, tzinfo=UTC)
            self.assertTrue(store.reserve_github_actions_api_request(budget_per_hour=2, at=current)["allowed"])
            self.assertTrue(store.reserve_github_actions_api_request(budget_per_hour=2, at=current + timedelta(minutes=1))["allowed"])

            restarted = MissionStore(path)
            limited = restarted.reserve_github_actions_api_request(
                budget_per_hour=2, at=current + timedelta(minutes=2),
            )

            self.assertFalse(limited["allowed"])
            self.assertEqual(limited["retry_at"], (current + timedelta(hours=1)).isoformat())

    def test_rate_limit_headers_pause_other_repositories_until_reset(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-github-rate-state-") as directory:
            store = MissionStore(Path(directory) / "tribe.sqlite3")
            current = datetime(2026, 11, 2, 12, tzinfo=UTC)
            reset = current + timedelta(minutes=20)
            store.update_github_actions_api_rate_limit(
                {"remaining": 0, "reset_at": reset.isoformat()}, retry_at=reset.isoformat(),
            )

            limited = store.reserve_github_actions_api_request(at=current + timedelta(minutes=1))

            self.assertFalse(limited["allowed"])
            self.assertEqual(limited["retry_at"], reset.isoformat())
            store.update_github_actions_api_rate_limit({"remaining": 7, "reset_at": reset.isoformat()})
            self.assertTrue(store.reserve_github_actions_api_request(at=reset + timedelta(seconds=1))["allowed"])

    def test_shared_budget_deferral_is_visible_without_counting_a_provider_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-github-quota-deferral-") as directory:
            root = Path(directory)
            repository = root / "project"
            repository.mkdir()
            store = MissionStore(root / "tribe.sqlite3")
            project, source = store.create_project(
                str(repository), "Quota", "Watch builds", "Investigate failures",
            )
            store.set_project_web_access(project["id"], True, ["api.github.com"])
            schedule = store.create_schedule(
                project["id"], "CI failure", "Investigate", "event", "UTC",
                trigger_event_type="github.workflow_run.failed",
                event_source_mission_id=source["id"],
                event_external_repository="owner/repo",
            )
            retry_at = (datetime.now(UTC) + timedelta(minutes=25)).isoformat()

            store.defer_github_action_polls([schedule["id"]], retry_at, "github_actions_local_rate_budget")

            updated = store.schedules(project["id"])[0]
            self.assertEqual(updated["event_external_next_poll_at"], retry_at)
            self.assertEqual(updated["event_external_error"], "github_actions_local_rate_budget")
            self.assertEqual(updated["event_external_failures"], 0)

    def test_due_repositories_rotate_after_the_last_request(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-github-quota-fairness-") as directory:
            root = Path(directory)
            repository = root / "project"
            repository.mkdir()
            store = MissionStore(root / "tribe.sqlite3")
            project, source = store.create_project(
                str(repository), "Fair polling", "Watch builds", "Investigate failures",
            )
            store.set_project_web_access(project["id"], True, ["api.github.com"])
            schedules = [store.create_schedule(
                project["id"], f"CI failure {name}", "Investigate", "event", "UTC",
                trigger_event_type="github.workflow_run.failed",
                event_source_mission_id=source["id"],
                event_external_repository=f"owner/{name}",
            ) for name in ("alpha", "bravo", "charlie")]
            with store._connect() as db:
                due = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
                db.execute("UPDATE schedules SET event_external_next_poll_at=?", (due,))
            store.advance_github_actions_poll_cursor("owner/bravo")

            groups = store.claim_due_github_action_polls()

            self.assertEqual([group["repository"] for group in groups], ["owner/charlie", "owner/alpha", "owner/bravo"])

    def test_external_trigger_stops_when_project_access_is_revoked(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-github-trigger-policy-") as directory:
            root = Path(directory)
            repository = root / "project"
            repository.mkdir()
            store = MissionStore(root / "tribe.sqlite3")
            project, source = store.create_project(
                str(repository), "Policy", "Watch builds", "Investigate failures",
            )
            store.set_project_web_access(project["id"], True, ["api.github.com"])
            schedule = store.create_schedule(
                project["id"], "CI failure", "Investigate", "event", "UTC",
                trigger_event_type="github.workflow_run.failed",
                event_source_mission_id=source["id"],
                event_external_repository="owner/repo",
            )
            store.set_project_web_access(project["id"], False, [])

            result = store.record_github_action_poll(schedule["id"], [_run(9)])

            self.assertFalse(result["published"])
            self.assertEqual(result["reason"], "project_web_access_required")
            self.assertEqual(store.claim_event_schedules(), [])
            self.assertEqual(
                store.schedules(project["id"])[0]["event_external_error"],
                "github_actions_requires_project_web_access",
            )

    def test_rate_limit_error_persists_backoff_without_enqueuing_work(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-github-trigger-backoff-") as directory:
            root = Path(directory)
            repository = root / "project"
            repository.mkdir()
            store = MissionStore(root / "tribe.sqlite3")
            project, source = store.create_project(
                str(repository), "Backoff", "Watch builds", "Investigate failures",
            )
            store.set_project_web_access(project["id"], True, ["api.github.com"])
            schedule = store.create_schedule(
                project["id"], "CI failure", "Investigate", "event", "UTC",
                trigger_event_type="github.workflow_run.failed",
                event_source_mission_id=source["id"],
                event_external_repository="owner/repo",
            )
            with store._connect() as db:
                db.execute(
                    "UPDATE schedules SET event_external_next_poll_at=? WHERE id=?",
                    ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), schedule["id"]),
                )
            store.claim_due_github_action_polls()

            result = store.record_github_action_poll(
                schedule["id"], error="github_actions_rate_limited_or_forbidden",
            )

            updated = store.schedules(project["id"])[0]
            self.assertFalse(result["published"])
            self.assertEqual(updated["event_external_failures"], 1)
            self.assertGreater(
                datetime.fromisoformat(updated["event_external_next_poll_at"]),
                datetime.now(UTC) + timedelta(minutes=50),
            )
            self.assertEqual(store.claim_event_schedules(), [])
