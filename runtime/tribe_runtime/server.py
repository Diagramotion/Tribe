"""Local HTTP API for the desktop shell and React development preview."""

from __future__ import annotations

import asyncio
import atexit
import base64
import binascii
import json
import logging
import math
import os
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .agent_runtime import AgentSupervisor
from .agents import (
    archive_agent_definition,
    load_agent_definitions,
    update_agent_definition,
    write_agent_definition,
)
from .browser_sessions import BrowserSessionManager
from .capabilities import capability_catalog
from .commands import BackgroundCommandRunner
from .computer_use import MAX_IMAGE_BYTES, ComputerObservationBroker
from .credentials import (
    get_api_key,
    provider_for_model,
    provider_supports_custom_url,
    save_api_key,
    validate_openai_base_url,
)
from .instance_lock import RuntimeInstanceLock
from .mcp_registry import MCPRegistry
from .pdf_analysis import render_pdf_page
from .project_memory import (
    accept_project_memory,
    list_project_memory,
    save_project_memory,
    set_project_memory_status,
)
from .providers import list_ollama_models, list_provider_models
from .recipes import get_recipe, list_recipe_versions, list_recipes, save_recipe
from .skills import SkillCatalog
from .store import MissionStore, default_data_directory
from .tabular_analysis import preview_xlsx_artifact
from .workspace import WorkspaceTools, browse_repository, project_git_diff, project_git_status
from .workspace_restore import (
    MAX_BACKUP_BYTES,
    WorkspaceRestore,
    activate_pending_workspace_restore,
)

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]
RUNTIME_DATA_DIRECTORY = default_data_directory()
RUNTIME_LOCK = RuntimeInstanceLock(RUNTIME_DATA_DIRECTORY / "runtime.lock")
if __name__ == "__main__":
    # A lock belongs to the executable runtime process, never to module imports
    # made by tests or other local tooling.
    RUNTIME_LOCK.acquire()
    restore_error = activate_pending_workspace_restore(RUNTIME_DATA_DIRECTORY)
    if restore_error:
        print(restore_error, flush=True)
STORE = MissionStore(RUNTIME_DATA_DIRECTORY / "tribe.sqlite3")


def _agent_payload(definition) -> dict:
    """Expose reusable capability grants, never the expanded internal tool list."""
    return {
        **definition.__dict__,
        "capabilities": list(definition.capabilities),
    }


def validate_agent_model_override(identifier: str, effort: str = "") -> None:
    """Require role pins to use an allowed tool model and a supported explicit effort."""
    identifier = identifier.strip()
    if not identifier:
        return
    provider_for_model(identifier)
    model = next((entry for entry in STORE.model_catalog() if entry.get("id") == identifier), None)
    if not model or not model.get("allowed"):
        raise ValueError("agent_model_must_be_allowed")
    if STORE.provider_connection(provider_for_model(identifier)).get("enabled") is False:
        raise ValueError("agent_model_provider_disabled")
    if model.get("toolCalling") is False:
        raise ValueError("agent_model_does_not_support_tools")
    supported_efforts = model.get("reasoningEfforts")
    if effort and isinstance(supported_efforts, list) and effort.strip().lower() not in supported_efforts:
        raise ValueError("agent_effort_not_supported_by_model")
BUILTIN_AGENT_DIRECTORY = Path(os.environ.get("TRIBE_AGENT_DIR", ROOT / "agents"))
USER_AGENT_DIRECTORY = Path(os.environ.get("TRIBE_USER_AGENT_DIR", STORE.data_dir / "agents"))
BUILTIN_RECIPE_DIRECTORY = Path(os.environ.get("TRIBE_RECIPE_DIR", ROOT / "recipes"))
USER_RECIPE_DIRECTORY = Path(os.environ.get("TRIBE_USER_RECIPE_DIR", STORE.data_dir / "recipes"))
AGENT_DEFINITIONS = load_agent_definitions(BUILTIN_AGENT_DIRECTORY, USER_AGENT_DIRECTORY)
STORE.ensure_project_agent_memberships([agent.id for agent in AGENT_DEFINITIONS])
AGENT_REGISTRY_LOCK = threading.Lock()
COMPUTER = ComputerObservationBroker()
BROWSER = BrowserSessionManager()
SUPERVISOR = AgentSupervisor(STORE, AGENT_DEFINITIONS, computer_observations=COMPUTER,
                             browser_sessions=BROWSER)
COMMANDS = BackgroundCommandRunner(STORE)
RESTORE_PENDING = threading.Event()
RESTORE_LOCK = threading.Lock()
atexit.register(COMMANDS.close)
atexit.register(BROWSER.close_all)


def _workspace_agent_ids() -> list[str]:
    with AGENT_REGISTRY_LOCK:
        return [agent.id for agent in AGENT_DEFINITIONS]


def _planner_agent_id() -> str:
    with AGENT_REGISTRY_LOCK:
        planner = next((agent.id for agent in AGENT_DEFINITIONS
                        if agent.id == "planner" or agent.role.strip().lower() == "planner"), None)
    if planner is None:
        raise ValueError("project_team_planner_unavailable")
    return planner


class LocalHTTPServer(ThreadingHTTPServer):
    """Bind loopback without a reverse DNS lookup of 127.0.0.1."""

    def server_bind(self) -> None:
        if self.allow_reuse_address:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(self.server_address)
        self.server_address = self.socket.getsockname()
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


class Handler(BaseHTTPRequestHandler):
    server_version = "TribeRuntime/0.1"

    def log_message(self, format: str, *args) -> None:
        return

    def _json(self, status: int, value: dict) -> None:
        body = json.dumps(value).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        if not self._local_origin():
            return self._json(403, {"error": "local_origin_required"})
        self.send_response(204)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and self._local_origin():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition, X-PDF-Page-Count")

    def _body(self) -> dict:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise ValueError("content type must be application/json")
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 14_000_000:
            raise OverflowError("request body is too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def _restore_workspace_backup(self) -> None:
        if RESTORE_PENDING.is_set() or not RESTORE_LOCK.acquire(blocking=False):
            self.close_connection = True
            return self._json(409, {"error": "workspace_restore_already_pending"})
        try:
            return self._stage_workspace_backup()
        finally:
            RESTORE_LOCK.release()

    def _stage_workspace_backup(self) -> None:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json(400, {"error": "invalid_content_length"})
        if content_type != "application/octet-stream":
            self.close_connection = True
            return self._json(415, {"error": "workspace_backup_must_be_binary"})
        if length < 1:
            return self._json(400, {"error": "workspace_backup_empty"})
        if length > MAX_BACKUP_BYTES:
            self.close_connection = True
            return self._json(413, {"error": "workspace_backup_too_large"})
        blockers = STORE.workspace_restore_blockers()
        if blockers:
            self.close_connection = True
            return self._json(409, {
                "error": "workspace_restore_requires_idle",
                "blockers": blockers,
            })

        temporary_path = None
        staged = False
        try:
            STORE.data_dir.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                prefix=".tribe-backup-upload-", dir=STORE.data_dir.parent, delete=False,
            ) as upload:
                temporary_path = Path(upload.name)
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("workspace_backup_upload_incomplete")
                    upload.write(chunk)
                    remaining -= len(chunk)
                upload.flush()
                os.fsync(upload.fileno())
            RESTORE_PENDING.set()
            blockers = STORE.workspace_restore_blockers()
            if blockers:
                RESTORE_PENDING.clear()
                self.close_connection = True
                return self._json(409, {
                    "error": "workspace_restore_requires_idle",
                    "blockers": blockers,
                })
            summary = WorkspaceRestore(STORE.data_dir).stage(temporary_path)
            staged = True
        except OverflowError:
            return self._json(413, {"error": "workspace_backup_too_large"})
        except ValueError as error:
            status = 409 if str(error) == "workspace_restore_already_pending" else 422
            return self._json(status, {"error": str(error)})
        except (OSError, RuntimeError, sqlite3.Error) as error:
            return self._json(500, {"error": f"workspace_restore_failed:{error}"})
        except Exception as error:  # noqa: BLE001 - malformed archives must not crash an HTTP worker
            return self._json(500, {"error": f"workspace_restore_failed:{type(error).__name__}"})
        finally:
            if not staged:
                RESTORE_PENDING.clear()
            if temporary_path:
                temporary_path.unlink(missing_ok=True)

        self._json(202, {"status": "staged", "workspace": summary})

        def stop_for_restore() -> None:
            COMMANDS.close()
            SUPERVISOR.close()
            self.server.shutdown()

        threading.Timer(0.5, stop_for_restore).start()

    def do_GET(self) -> None:
        if not self._local_origin():
            return self._json(403, {"error": "local_origin_required"})
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self._json(200, {"status": "ok", "runtime": "local", "agents": SUPERVISOR.status})
        if parsed.path == "/api/browser/runtime":
            return self._json(200, {"installed": BROWSER.browser_installed(), "headless": True})
        browser_view_match = re.fullmatch(r"/api/missions/([0-9a-f-]{36})/browser", parsed.path)
        if browser_view_match:
            mission_id = browser_view_match.group(1)
            if not STORE.mission(mission_id):
                return self._json(404, {"error": "mission_not_found"})
            return self._json(200, BROWSER.view(mission_id))
        browser_image_match = re.fullmatch(
            r"/api/missions/([0-9a-f-]{36})/browser/([0-9a-f-]{36})/screenshot", parsed.path
        )
        if browser_image_match:
            mission_id, session_id = browser_image_match.groups()
            image = BROWSER.screenshot_for(session_id, mission_id)
            if image is None:
                return self._json(404, {"error": "browser_screenshot_not_found"})
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(image)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(image)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if parsed.path == "/api/computer/requests":
            requests = []
            for request in COMPUTER.pending():
                mission = STORE.mission(request["missionId"])
                if not mission or mission["status"] != "active" or mission.get("archived_at"):
                    COMPUTER.cancel(request["id"], request["missionId"])
                    continue
                if not STORE.project_computer_access(mission["project_id"])["enabled"]:
                    COMPUTER.cancel(request["id"], request["missionId"])
                    continue
                project = STORE.project(mission["project_id"])
                definition = next((item for item in AGENT_DEFINITIONS if item.id == request["agentId"]), None)
                requests.append({
                    **request,
                    "missionTitle": mission["title"],
                    "projectName": project["name"] if project else "Project",
                    "agentName": definition.name if definition else request["agentId"],
                })
            return self._json(200, {"requests": requests})
        if parsed.path == "/api/backup":
            with tempfile.TemporaryDirectory(prefix="tribe-backup-") as directory:
                backup = Path(directory) / "workspace.tribe-backup"
                try:
                    STORE.write_workspace_backup(backup)
                except (OSError, RuntimeError, sqlite3.Error) as error:
                    return self._json(500, {"error": f"backup_failed:{error}"})
                size = backup.stat().st_size
                filename = f"tribe-backup-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}.tribe-backup"
                self.send_response(200)
                self._cors_headers()
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    with backup.open("rb") as source:
                        while chunk := source.read(1024 * 1024):
                            self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
            return
        if parsed.path == "/api/settings":
            return self._json(200, {
                "agents": SUPERVISOR.status,
                "agentDirectory": str(USER_AGENT_DIRECTORY),
                "experimentalContextPruning": STORE.get_setting("experimental_context_pruning") == "true",
                "contextPruningSummary": STORE.context_pruning_summary(),
                "imageGenerationModel": STORE.get_setting("image_generation_model") or "",
            })
        if parsed.path == "/api/models":
            default_model = SUPERVISOR.status.get("model")
            if default_model:
                STORE.register_configured_model(default_model)
            with AGENT_REGISTRY_LOCK:
                pinned_models = [agent.model for agent in AGENT_DEFINITIONS if agent.model]
            for pinned_model in pinned_models:
                STORE.register_configured_model(pinned_model)
            connections = STORE.provider_connections()
            return self._json(200, {
                "models": [{**model, "providerEnabled": connections.get(model.get("provider"), {}).get("enabled", True)} for model in STORE.model_catalog()],
                "defaultModel": default_model,
            })
        if parsed.path == "/api/providers":
            connections = STORE.provider_connections()
            model_counts: dict[str, int] = {}
            for model in STORE.model_catalog():
                provider = model.get("provider")
                if isinstance(provider, str):
                    model_counts[provider] = model_counts.get(provider, 0) + 1
            provider_ids = sorted(set(connections) | set(model_counts))
            def credential_available(provider: str) -> bool:
                if provider == "ollama":
                    return True
                try:
                    return bool(get_api_key(f"{provider}:status"))
                except ValueError:
                    return False
            return self._json(200, {"providers": [{
                "id": provider,
                "enabled": connections.get(provider, {}).get("enabled", True),
                "baseUrl": connections.get(provider, {}).get("baseUrl"),
                "status": connections.get(provider, {}).get("status", "not_checked"),
                "lastVerifiedAt": connections.get(provider, {}).get("lastVerifiedAt"),
                "modelCount": model_counts.get(provider, 0),
                "credentialAvailable": credential_available(provider),
                "discovery": "ollama" if provider == "ollama" else "openai-compatible",
            } for provider in provider_ids]})
        if parsed.path == "/api/providers/ollama/models":
            try:
                return self._json(200, {"models": list_ollama_models()})
            except RuntimeError as error:
                return self._json(503, {"error": str(error)})
        if parsed.path == "/api/projects":
            return self._json(200, {"projects": STORE.bootstrap()["projects"]})
        artifacts_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/artifacts", parsed.path)
        if artifacts_match:
            query = parse_qs(parsed.query)
            try:
                limit = int(query.get("limit", ["50"])[0])
                page = STORE.project_artifacts(
                    artifacts_match.group(1),
                    query.get("q", [""])[0],
                    query.get("before", [None])[0],
                    query.get("beforeId", [None])[0],
                    limit,
                )
                return self._json(200, page)
            except ValueError as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error) or "invalid_request"})
        project_canvas_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/canvas", parsed.path)
        if project_canvas_match:
            project_id = project_canvas_match.group(1)
            if not STORE.project(project_id):
                return self._json(404, {"error": "project_not_found"})
            return self._json(200, {"documents": STORE.project_canvas_documents(project_id)})
        audit_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/audit-export", parsed.path)
        if audit_match:
            project_id = audit_match.group(1)
            project = STORE.project(project_id)
            if not project:
                return self._json(404, {"error": "project_not_found"})
            with tempfile.TemporaryDirectory(prefix="tribe-audit-") as directory:
                archive = Path(directory) / "project-audit.json"
                try:
                    STORE.write_project_audit_export(project_id, archive)
                except ValueError as error:
                    return self._json(404, {"error": str(error)})
                except (OSError, RuntimeError, sqlite3.Error) as error:
                    return self._json(500, {"error": f"audit_export_failed:{error}"})
                safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "-", project["name"]).strip("-_")[:48]
                filename = f"tribe-{safe_name or 'project'}-activity-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}.json"
                size = archive.stat().st_size
                self.send_response(200)
                self._cors_headers()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    with archive.open("rb") as source:
                        while chunk := source.read(1024 * 1024):
                            self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
            return
        files_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/files", parsed.path)
        if files_match:
            project_id = files_match.group(1)
            relative_path = parse_qs(parsed.query).get("path", [""])[0]
            try:
                return self._json(200, {
                    "entry": browse_repository(STORE.repository_for_project(project_id), relative_path)
                })
            except ValueError as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error)})
            except FileNotFoundError:
                return self._json(404, {"error": "repository_path_not_found"})
            except OSError:
                return self._json(422, {"error": "repository_path_could_not_be_read"})
        git_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/git", parsed.path)
        if git_match:
            try:
                return self._json(200, project_git_status(STORE.repository_for_project(git_match.group(1))))
            except ValueError as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error)})
            except OSError:
                return self._json(422, {"error": "repository_path_could_not_be_read"})
        git_diff_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/git/diff", parsed.path)
        if git_diff_match:
            relative_path = parse_qs(parsed.query).get("path", [""])[0]
            try:
                return self._json(200, project_git_diff(STORE.repository_for_project(git_diff_match.group(1)), relative_path))
            except ValueError as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error)})
            except OSError:
                return self._json(422, {"error": "repository_path_could_not_be_read"})
        recipe_versions_match = re.fullmatch(r"/api/recipes/([a-z0-9_-]{2,64})/versions", parsed.path)
        if recipe_versions_match:
            try:
                return self._json(200, {"versions": list_recipe_versions(
                    BUILTIN_RECIPE_DIRECTORY, USER_RECIPE_DIRECTORY, recipe_versions_match.group(1),
                )})
            except (OSError, ValueError):
                return self._json(422, {"error": "workflow_library_could_not_be_read"})
        recipe_version_match = re.fullmatch(r"/api/recipes/([a-z0-9_-]{2,64})", parsed.path)
        if recipe_version_match:
            query = parse_qs(parsed.query)
            try:
                raw_version = query.get("version", [None])[0]
                version = int(raw_version) if raw_version is not None else None
                recipe = get_recipe(
                    BUILTIN_RECIPE_DIRECTORY, USER_RECIPE_DIRECTORY,
                    recipe_version_match.group(1), version,
                )
                if recipe is None:
                    return self._json(404, {"error": "workflow_version_not_found"})
                return self._json(200, {"recipe": recipe.snapshot() | {"source": recipe.source}})
            except (OSError, ValueError):
                return self._json(422, {"error": "workflow_definition_invalid"})
        if parsed.path == "/api/recipes":
            try:
                return self._json(200, {"recipes": [recipe.snapshot() | {"source": recipe.source}
                                                       for recipe in list_recipes(BUILTIN_RECIPE_DIRECTORY, USER_RECIPE_DIRECTORY)]})
            except ValueError as error:
                return self._json(422, {"error": "workflow_definition_invalid", "detail": str(error)})
            except OSError:
                return self._json(422, {"error": "workflow_library_could_not_be_read"})
        if parsed.path == "/api/schedules":
            project_id = parse_qs(parsed.query).get("project", [""])[0]
            return self._json(200, {"schedules": STORE.schedules(project_id)})
        schedule_runs_match = re.fullmatch(r"/api/schedules/([0-9a-f-]{36})/runs", parsed.path)
        if schedule_runs_match:
            query = parse_qs(parsed.query)
            try:
                limit = int(query.get("limit", ["10"])[0])
                result = STORE.schedule_runs(
                    schedule_runs_match.group(1), limit,
                    query.get("beforeStartedAt", [None])[0],
                    query.get("beforeId", [None])[0],
                )
            except ValueError as error:
                return self._json(422, {"error": str(error)})
            return self._json(404, {"error": "schedule_not_found"}) if result is None else self._json(200, result)
        if parsed.path == "/api/usage":
            project_id = parse_qs(parsed.query).get("project", [""])[0]
            if not project_id or not STORE.project(project_id):
                return self._json(404, {"error": "project_not_found"})
            return self._json(200, {"usage": STORE.project_usage(project_id)})
        web_access_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/web-access", parsed.path)
        if web_access_match:
            try:
                return self._json(200, {"webAccess": STORE.project_web_access(web_access_match.group(1))})
            except ValueError as error:
                return self._json(404, {"error": str(error)})
        interactive_access_match = re.fullmatch(
            r"/api/projects/([0-9a-f-]{36})/interactive-access", parsed.path
        )
        if interactive_access_match:
            try:
                return self._json(200, {
                    "interactiveAccess": STORE.project_interactive_access(interactive_access_match.group(1))
                })
            except ValueError as error:
                return self._json(404, {"error": str(error)})
        computer_access_match = re.fullmatch(
            r"/api/projects/([0-9a-f-]{36})/computer-access", parsed.path
        )
        if computer_access_match:
            try:
                return self._json(200, {
                    "computerAccess": STORE.project_computer_access(computer_access_match.group(1))
                })
            except ValueError as error:
                return self._json(404, {"error": str(error)})
        command_tools_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/command-tools", parsed.path)
        if command_tools_match:
            try:
                return self._json(200, {"executables": STORE.project_command_tools(command_tools_match.group(1))})
            except ValueError as error:
                return self._json(404, {"error": str(error)})
        if parsed.path == "/api/interactions/pending":
            return self._json(200, {"interactions": STORE.pending_interactions()})
        if parsed.path == "/api/commands":
            mission_id = parse_qs(parsed.query).get("mission", [""])[0]
            if not STORE.mission(mission_id):
                return self._json(404, {"error": "mission_not_found"})
            return self._json(200, {"runs": COMMANDS.list(mission_id)})
        if parsed.path == "/api/agent-requests":
            query = parse_qs(parsed.query)
            mission_id = query.get("mission", [""])[0]
            if not STORE.mission(mission_id):
                return self._json(404, {"error": "mission_not_found"})
            try:
                limit = int(query.get("limit", ["200"])[0])
            except ValueError:
                return self._json(422, {"error": "invalid_limit"})
            return self._json(200, {"requests": STORE.agent_request_usage_for_mission(mission_id, limit)})
        if parsed.path == "/api/skills":
            query = parse_qs(parsed.query)
            mission_id = query.get("mission", [None])[0]
            project_id = query.get("project", [None])[0]
            root = STORE.project_repository(mission_id) if mission_id else STORE.repository_for_project(project_id) if project_id else Path.cwd()
            return self._json(200, {"skills": SkillCatalog(root).list(query.get("q", [""])[0])})
        if parsed.path == "/api/knowledge":
            project_id = parse_qs(parsed.query).get("project", [None])[0]
            if not project_id:
                return self._json(422, {"error": "project_required"})
            return self._json(200, {
                "knowledge": list_project_memory(STORE, project_id, include_archived=True),
                "proposals": STORE.knowledge_proposals(project_id, pending_only=False),
            })
        mcp_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/mcp", parsed.path)
        if mcp_match:
            try:
                registry = MCPRegistry(STORE)
                return self._json(200, {
                    "config": registry.get_config(mcp_match.group(1)),
                    "secretStatus": registry.secret_status(mcp_match.group(1)),
                })
            except ValueError as error:
                return self._json(404 if str(error) == "project_not_found" else 500, {"error": str(error)})
        mcp_oauth_status_match = re.fullmatch(
            r"/api/projects/([0-9a-f-]{36})/mcp/oauth/([a-zA-Z0-9_-]{1,64})/status", parsed.path,
        )
        if mcp_oauth_status_match:
            try:
                registry = MCPRegistry(STORE)
                return self._json(200, asyncio.run(registry.oauth_status(*mcp_oauth_status_match.groups())))
            except RuntimeError as error:
                return self._json(503, {"error": str(error)})
            except ValueError as error:
                return self._json(404 if str(error) == "project_not_found" else 422, {"error": str(error)})
        if parsed.path == "/api/bootstrap":
            query = parse_qs(parsed.query)
            requested_mission = query.get("mission", [None])[0]
            keep_mission_empty = requested_mission == "__new_chat__"
            data = STORE.bootstrap(
                query.get("project", [None])[0],
                None if keep_mission_empty else requested_mission,
                select_default_mission=not keep_mission_empty,
            )
            if data.get("project"):
                data["knowledge"] = list_project_memory(
                    STORE, data["project"]["id"], include_archived=True,
                )
                data["knowledgeProposals"] = STORE.knowledge_proposals(
                    data["project"]["id"], pending_only=True,
                )
            else:
                data["knowledge"] = []
                data["knowledgeProposals"] = []
            with AGENT_REGISTRY_LOCK:
                available_agents = list(AGENT_DEFINITIONS)
                data["agents"] = [_agent_payload(agent) for agent in available_agents]
            extra_capabilities = {
                grant for agent in available_agents for grant in agent.capabilities
            }
            selected_project = data.get("project")
            if selected_project:
                try:
                    configured_services = MCPRegistry(STORE).get_config(selected_project["id"])
                except (OSError, ValueError):
                    configured_services = {"mcpServers": {}}
                extra_capabilities.update(
                    f"mcp-service:{name}" for name in configured_services["mcpServers"]
                )
            data["capabilityCatalog"] = capability_catalog(tuple(sorted(extra_capabilities)))
            available_agent_ids = [agent.id for agent in available_agents]
            for project in data.get("projects", []):
                project["agentIds"] = STORE.project_agent_ids(project["id"], available_agent_ids)
            data["agentDirectory"] = str(USER_AGENT_DIRECTORY)
            data["agentRuntime"] = SUPERVISOR.status
            data["isolatedWorkspaces"] = STORE.isolated_workspaces_for_mission(data["mission"]["id"]) if data.get("mission") else []
            return self._json(200, data)
        if parsed.path == "/api/stream":
            query = parse_qs(parsed.query)
            mission_id = query.get("mission", ["mission-first"])[0]
            try:
                cursor = max(int(query.get("after", ["0"])[0]), int(self.headers.get("Last-Event-ID", "0")))
            except ValueError:
                cursor = 0
            return self._stream_events(mission_id, cursor)
        if parsed.path == "/api/events":
            query = parse_qs(parsed.query)
            mission_id = query.get("mission", ["mission-first"])[0]
            if "before" in query:
                try:
                    before = float(query["before"][0])
                    if not math.isfinite(before) or before < 0:
                        raise ValueError
                    limit = min(max(int(query.get("limit", ["200"])[0]), 1), 500)
                except ValueError:
                    return self._json(422, {"error": "invalid_event_page"})
                events, has_more = STORE.events_before(mission_id, before, limit)
                return self._json(200, {"events": events, "hasMore": has_more})
            try:
                after = max(0, int(query.get("after", ["0"])[0]))
            except ValueError:
                return self._json(422, {"error": "invalid_event_cursor"})
            try:
                limit = min(max(int(query.get("limit", ["200"])[0]), 1), 500)
            except ValueError:
                return self._json(422, {"error": "invalid_event_page"})
            events, has_more = STORE.events_after_page(mission_id, after, limit)
            return self._json(200, {"events": events, "hasMore": has_more})
        pdf_page_match = re.fullmatch(r"/api/artifacts/([0-9a-f-]{36})/pdf-page", parsed.path)
        if pdf_page_match:
            found = STORE.artifact_content(pdf_page_match.group(1))
            if not found:
                return self._json(404, {"error": "artifact_not_found"})
            artifact, content = found
            try:
                page_number = int(parse_qs(parsed.query).get("page", ["1"])[0])
                image, page_count = render_pdf_page(
                    artifact["name"], artifact.get("media_type", ""), content,
                    page_number=page_number,
                )
            except (ValueError, TypeError) as error:
                return self._json(422, {"error": str(error)})
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(image)))
            self.send_header("X-PDF-Page-Count", str(page_count))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(image)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        xlsx_preview_match = re.fullmatch(r"/api/artifacts/([0-9a-f-]{36})/xlsx-preview", parsed.path)
        if xlsx_preview_match:
            found = STORE.artifact_content(xlsx_preview_match.group(1))
            if not found:
                return self._json(404, {"error": "artifact_not_found"})
            artifact, content = found
            query = parse_qs(parsed.query)
            try:
                offset = int(query.get("offset", ["0"])[0])
                limit = int(query.get("limit", ["50"])[0])
                header_rows = int(query.get("headerRows", ["1"])[0])
                preview = preview_xlsx_artifact(
                    artifact["name"], artifact.get("media_type", ""), content,
                    query.get("sheet", [""])[0], offset, limit,
                    query.get("search", [""])[0], header_rows,
                )
            except (ValueError, TypeError) as error:
                return self._json(422, {"error": str(error)})
            return self._json(200, {"preview": preview})
        artifact_match = re.fullmatch(r"/api/artifacts/([0-9a-f-]{36})", parsed.path)
        if artifact_match:
            found = STORE.artifact_content(artifact_match.group(1))
            if not found:
                return self._json(404, {"error": "artifact_not_found"})
            artifact, content = found
            return self._json(200, {"artifact": artifact, "contentBase64": base64.b64encode(content).decode("ascii")})
        canvas_versions_match = re.fullmatch(
            r"/api/missions/([0-9a-f-]{36})/canvas/([0-9a-f-]{36})/versions/([1-9][0-9]*)",
            parsed.path,
        )
        if canvas_versions_match:
            version = STORE.canvas_version(
                canvas_versions_match.group(1), canvas_versions_match.group(2),
                int(canvas_versions_match.group(3)),
            )
            return self._json(200, {"version": version}) if version else self._json(404, {"error": "canvas_version_not_found"})
        canvas_document_match = re.fullmatch(
            r"/api/missions/([0-9a-f-]{36})/canvas/([0-9a-f-]{36})", parsed.path,
        )
        if canvas_document_match:
            document = STORE.canvas_document(canvas_document_match.group(1), canvas_document_match.group(2))
            return self._json(200, {"document": document}) if document else self._json(404, {"error": "canvas_document_not_found"})
        canvas_list_match = re.fullmatch(r"/api/missions/([0-9a-f-]{36})/canvas", parsed.path)
        if canvas_list_match:
            return self._json(200, {"documents": STORE.canvas_documents(canvas_list_match.group(1))})
        artifact_reviews_match = re.fullmatch(r"/api/artifacts/([0-9a-f-]{36})/reviews", parsed.path)
        if artifact_reviews_match:
            try:
                return self._json(200, {"threads": STORE.artifact_reviews(artifact_reviews_match.group(1))})
            except ValueError as error:
                return self._json(404 if str(error) == "artifact_not_found" else 422, {"error": str(error)})
        return self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if not self._local_origin():
            return self._json(403, {"error": "local_origin_required"})
        if self.path == "/api/backup/restore":
            return self._restore_workspace_backup()
        if RESTORE_PENDING.is_set() and self.path != "/api/shutdown":
            return self._json(503, {"error": "workspace_restore_shutting_down"})
        try:
            body = self._body()
            if self.path == "/api/shutdown":
                COMPUTER.close()
                BROWSER.close_all()
                self._json(202, {"status": "shutting_down"})
                threading.Thread(target=self.server.shutdown, daemon=True,
                                 name="tribe-runtime-shutdown").start()
                return
            if self.path == "/api/browser/install":
                try:
                    BROWSER.install_browser()
                    return self._json(200, {"installed": True})
                except (OSError, RuntimeError) as error:
                    return self._json(503, {"error": str(error)[:300]})
            browser_stop_match = re.fullmatch(
                r"/api/missions/([0-9a-f-]{36})/browser/([0-9a-f-]{36})/stop", self.path
            )
            if browser_stop_match:
                mission_id, session_id = browser_stop_match.groups()
                if not STORE.mission(mission_id):
                    return self._json(404, {"error": "mission_not_found"})
                if not BROWSER.stop(session_id, mission_id):
                    return self._json(404, {"error": "browser_session_not_found"})
                return self._json(200, {"stopped": True})
            browser_open_match = re.fullmatch(r"/api/missions/([0-9a-f-]{36})/browser", self.path)
            browser_action_match = re.fullmatch(
                r"/api/missions/([0-9a-f-]{36})/browser/([0-9a-f-]{36})/(navigate|back|forward|reload|interact)",
                self.path,
            )
            if browser_open_match or browser_action_match:
                mission_id = (browser_open_match or browser_action_match).group(1)
                mission = STORE.mission(mission_id)
                if not mission:
                    return self._json(404, {"error": "mission_not_found"})
                try:
                    policy = STORE.project_web_access(mission["project_id"])
                    allowed = policy["allowedDomains"] if policy["enabled"] else []
                    if browser_open_match:
                        url = str(body.get("url", ""))
                        result = BROWSER.open(mission["project_id"], mission_id, "user", url, allowed)
                    else:
                        session_id, action = browser_action_match.groups()[1:]
                        if action == "navigate":
                            result = BROWSER.navigate_session(mission_id, session_id,
                                                              str(body.get("url", "")), allowed)
                        elif action == "interact":
                            result = BROWSER.interact(
                                mission_id, session_id, str(body.get("action", "")),
                                x=body.get("x", 0), y=body.get("y", 0),
                                value=body.get("value", ""), key=body.get("key", ""),
                                delta_y=body.get("deltaY", 0),
                            )
                        else:
                            result = BROWSER.session_action(mission_id, session_id, action)
                    return self._json(200, {"session": result})
                except ValueError as error:
                    message = str(error) or "browser_action_failed"
                    status = 403 if "allowed website list" in message else 422
                    return self._json(status, {"error": message})
                except RuntimeError as error:
                    return self._json(503, {"error": str(error) or "browser_unavailable"})
            computer_completion = re.fullmatch(
                r"/api/computer/requests/([0-9a-f-]{36})/complete", self.path
            )
            computer_claim = re.fullmatch(
                r"/api/computer/requests/([0-9a-f-]{36})/claim", self.path
            )
            if computer_claim:
                request_id = computer_claim.group(1)
                token = str(body.get("completionToken", ""))
                try:
                    context = COMPUTER.context(request_id, token)
                    mission = STORE.mission(context["missionId"])
                    if not mission or mission["status"] != "active" or mission.get("archived_at"):
                        COMPUTER.cancel(request_id, context["missionId"])
                        return self._json(409, {"error": "mission_not_active"})
                    if not STORE.project_computer_access(mission["project_id"])["enabled"]:
                        COMPUTER.cancel(request_id, context["missionId"])
                        return self._json(409, {"error": "computer_use_disabled"})
                    request = COMPUTER.claim(request_id, token)
                    return self._json(200, {"request": request})
                except ValueError as error:
                    return self._json(409, {"error": str(error) or "observation_request_not_pending"})
            computer_cancel = re.fullmatch(
                r"/api/computer/requests/([0-9a-f-]{36})/cancel", self.path
            )
            if computer_cancel:
                request_id = computer_cancel.group(1)
                token = str(body.get("completionToken", ""))
                try:
                    context = COMPUTER.context(request_id, token)
                    if not COMPUTER.cancel(request_id, context["missionId"]):
                        return self._json(409, {"error": "observation_request_not_pending"})
                    STORE.append("computer.observation.cancelled", "user", context["missionId"], {
                        "requestId": request_id,
                        "agentId": context["agentId"],
                    })
                    return self._json(200, {"status": "cancelled"})
                except ValueError as error:
                    return self._json(409, {"error": str(error) or "observation_request_not_pending"})
            if computer_completion:
                encoded_image = body.get("imageBase64")
                if not isinstance(encoded_image, str) or len(encoded_image) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
                    return self._json(413, {"error": "observation_image_too_large"})
                try:
                    image = base64.b64decode(encoded_image, validate=True)
                    completion_token = str(body.get("completionToken", ""))
                    request_context = COMPUTER.context(
                        computer_completion.group(1), completion_token
                    )
                    mission = STORE.mission(request_context["missionId"])
                    if not mission or mission["status"] != "active":
                        COMPUTER.cancel(request_context["requestId"], request_context["missionId"])
                        return self._json(409, {"error": "mission_not_active"})
                    if not STORE.project_computer_access(mission["project_id"])["enabled"]:
                        COMPUTER.cancel(request_context["requestId"], request_context["missionId"])
                        return self._json(409, {"error": "computer_use_disabled"})
                    request = COMPUTER.complete(
                        request_context["requestId"], completion_token,
                        application=body.get("application", ""),
                        window_title=body.get("windowTitle", ""),
                        accessibility_text=body.get("accessibilityText", ""),
                        image=image,
                    )
                    STORE.append("computer.observation.completed", request["agentId"], request["missionId"], {
                        "requestId": request["requestId"],
                    })
                    return self._json(200, {"status": "completed"})
                except (ValueError, KeyError, binascii.Error) as error:
                    return self._json(422, {"error": str(error) or "invalid_observation"})
            if self.path == "/api/settings/check":
                return self._json(200, {"check": SUPERVISOR.check_connection()})
            if self.path == "/api/providers/connect":
                provider = str(body.get("provider", "")).strip().lower()
                api_key = str(body.get("apiKey", ""))
                base_url = str(body.get("baseUrl", "")).strip()
                if len(provider) > 100 or len(api_key) > 10_000 or len(base_url) > 2048:
                    return self._json(422, {"error": "provider_request_invalid"})
                try:
                    provider_for_model(f"{provider}:connection")
                    if base_url:
                        base_url = validate_openai_base_url(base_url)
                        if not provider_supports_custom_url(provider):
                            return self._json(422, {"error": "provider_custom_url_unsupported"})
                    models = list_provider_models(provider, api_key, base_url)
                    if api_key.strip():
                        save_api_key(f"{provider}:connection", api_key)
                    connection = STORE.set_provider_connection(provider, base_url, verified=True)
                    SUPERVISOR.provider_connection_updated(provider)
                    catalog = STORE.merge_provider_model_catalog(
                        provider, models, SUPERVISOR.status.get("model"),
                    )
                    return self._json(200, {
                        "connection": {"id": provider, **connection},
                        "models": models, "catalog": catalog,
                    })
                except ValueError as error:
                    return self._json(422, {"error": str(error) or "provider_request_invalid"})
                except RuntimeError as error:
                    status = 422 if str(error) == "provider_model_discovery_unsupported" else 503
                    return self._json(status, {"error": str(error) or "provider_models_unavailable"})
            if self.path == "/api/providers/models":
                provider = str(body.get("provider", ""))
                api_key = str(body.get("apiKey", ""))
                base_url = str(body.get("baseUrl", ""))
                if len(provider) > 100 or len(api_key) > 10_000 or len(base_url) > 2048:
                    return self._json(422, {"error": "provider_request_invalid"})
                try:
                    base_url = base_url or STORE.provider_connection(provider).get("baseUrl") or ""
                    models = list_provider_models(provider, api_key, base_url)
                    catalog = STORE.merge_provider_model_catalog(
                        provider, models, SUPERVISOR.status.get("model"),
                    )
                    STORE.set_provider_connection(provider, base_url, verified=True)
                    SUPERVISOR.provider_connection_updated(provider)
                    return self._json(200, {"models": models, "catalog": catalog})
                except ValueError as error:
                    return self._json(422, {"error": str(error) or "provider_request_invalid"})
                except RuntimeError as error:
                    status = 422 if str(error) == "provider_model_discovery_unsupported" else 503
                    return self._json(status, {"error": str(error) or "provider_models_unavailable"})
            if self.path == "/api/settings":
                status = SUPERVISOR.configure(
                    str(body.get("model", "")), str(body.get("apiKey", "")),
                    str(body.get("baseUrl", "")),
                )
                if status.get("model"):
                    STORE.register_configured_model(status["model"])
                return self._json(200, {"agents": status})
            mcp_check_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/mcp/check", self.path)
            if mcp_check_match:
                registry = MCPRegistry(STORE)
                server_name = str(body.get("serverName", ""))
                is_playwright = False
                try:
                    preflight = None
                    if server_name == "playwright":
                        config = registry.validate(registry.get_config(mcp_check_match.group(1)))
                        definition = config["mcpServers"].get(server_name, {})
                        is_playwright = (
                            isinstance(definition, dict)
                            and definition.get("command") == "npx"
                            and any(str(arg).startswith("@playwright/mcp@") for arg in definition.get("args", []))
                        )
                        if is_playwright:
                            preflight = MCPRegistry.check_browser_runtime_dependencies()
                    if preflight and not preflight["ready"]:
                        messages = {
                            "node_missing": "Install Node.js 18 or newer, then restart Tribe.",
                            "npx_missing": "The Node.js installation does not include npx. Install Node.js 18 or newer, then restart Tribe.",
                            "node_unavailable": "Node.js could not be started. Restart Tribe after checking the Node.js installation.",
                            "node_version_unavailable": "Tribe could not determine the Node.js version. Check the Node.js installation and restart Tribe.",
                            "node_version_unsupported": f"Playwright tools need Node.js 18 or newer; this device has Node.js {preflight['nodeVersion']}.",
                        }
                        return self._json(424, {"error": messages.get(preflight["reason"], "Browser tools are not ready on this device.")})
                    if is_playwright:
                        tools = asyncio.run(registry.discover_tools(
                            mcp_check_match.group(1), server_name, verify_browser_launch=True,
                        ))
                        preflight["browserReady"] = True
                    else:
                        tools = asyncio.run(registry.discover_tools(mcp_check_match.group(1), server_name))
                    return self._json(200, {"serverName": server_name, "tools": tools, "preflight": preflight})
                except ValueError as error:
                    status = 404 if str(error) in {"project_not_found", "mcp_server_not_found"} else 422
                    return self._json(status, {"error": str(error)})
                except Exception as error:  # noqa: BLE001 - MCP SDK transports expose backend-specific errors
                    if is_playwright:
                        return self._json(424, {"error": "Playwright could not open its browser. Check the browser installation and retry."})
                    return self._json(502, {"error": f"MCP connection failed ({type(error).__name__})."})
            browser_install_match = re.fullmatch(
                r"/api/projects/([0-9a-f-]{36})/mcp/playwright/install", self.path,
            )
            if browser_install_match:
                try:
                    project_id = browser_install_match.group(1)
                    config = MCPRegistry(STORE).get_config(project_id)
                    definition = config["mcpServers"].get("playwright", {})
                    is_pinned_playwright = (
                        isinstance(definition, dict)
                        and definition.get("command") == "npx"
                        and any(str(arg).startswith("@playwright/mcp@") for arg in definition.get("args", []))
                    )
                    if not is_pinned_playwright:
                        return self._json(409, {"error": "Add the browser tools to this project first."})
                    return self._json(200, MCPRegistry.install_playwright_browser_binary())
                except ValueError as error:
                    status = 404 if str(error) == "project_not_found" else 422
                    return self._json(status, {"error": str(error)})
                except RuntimeError as error:
                    return self._json(424, {"error": str(error)})
            playwright_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/mcp/playwright", self.path)
            if playwright_match:
                registry = MCPRegistry(STORE)
                project_id = playwright_match.group(1)
                config = registry.install_playwright_browser(project_id)
                bootstrap = STORE.bootstrap(project_id)
                for mission in bootstrap["missions"]:
                    if mission["status"] == "active":
                        STORE.append("project.mcp.config.updated", "user", mission["id"], {
                            "servers": sorted(config["mcpServers"]),
                            "installed": "playwright",
                        })
                return self._json(200, {
                    "config": config,
                    "secretStatus": registry.secret_status(project_id),
                })
            if self.path == "/api/agents":
                try:
                    project_id = str(body.get("projectId") or "").strip() or None
                    required_planner_id = _planner_agent_id() if project_id else None
                    with AGENT_REGISTRY_LOCK:
                        agent_id = str(body.get("id", "")).strip()
                        if any(agent.id == agent_id for agent in AGENT_DEFINITIONS):
                            return self._json(409, {"error": f"agent id {agent_id!r} already exists"})
                        previous_project_agent_ids = None
                        if project_id:
                            previous_project_agent_ids = STORE.project_agent_ids(
                                project_id, [agent.id for agent in AGENT_DEFINITIONS],
                            )
                        validate_agent_model_override(
                            str(body.get("model", "")), str(body.get("effort", "")),
                        )
                        definition = write_agent_definition(
                            USER_AGENT_DIRECTORY,
                            agent_id,
                            str(body.get("name", "")),
                            str(body.get("role", "")),
                            str(body.get("instructions", "")),
                            str(body.get("model", "")),
                            str(body.get("repositoryAccess", "workspace_write")),
                            str(body.get("effort", "")),
                            body.get("capabilities", body.get("toolPermissions")),
                        )
                        project_agent_ids = None
                        if project_id:
                            try:
                                project_agent_ids = STORE.set_project_agent_ids(
                                    project_id,
                                    [*previous_project_agent_ids, definition.id],
                                    [agent.id for agent in AGENT_DEFINITIONS] + [definition.id],
                                    required_planner_id or "planner",
                                )
                            except Exception:
                                (USER_AGENT_DIRECTORY / f"{definition.id}.md").unlink(missing_ok=True)
                                raise
                        try:
                            SUPERVISOR.register_agent(definition)
                        except Exception as error:
                            (USER_AGENT_DIRECTORY / f"{definition.id}.md").unlink(missing_ok=True)
                            if project_id and previous_project_agent_ids is not None:
                                STORE.set_project_agent_ids(
                                    project_id, previous_project_agent_ids,
                                    [agent.id for agent in AGENT_DEFINITIONS], required_planner_id or "planner",
                                )
                            raise RuntimeError("agent role could not be registered") from error
                        AGENT_DEFINITIONS.append(definition)
                    return self._json(201, {
                        "agent": _agent_payload(definition),
                        "agentDirectory": str(USER_AGENT_DIRECTORY),
                        **({"projectAgentIds": project_agent_ids} if project_agent_ids is not None else {}),
                    })
                except ValueError as error:
                    return self._json(422, {"error": str(error)})
            if self.path == "/api/recipes":
                try:
                    save_options = {}
                    if "expected_version" in body:
                        save_options["expected_version"] = body["expected_version"]
                    recipe = save_recipe(USER_RECIPE_DIRECTORY, str(body.get("id", "")),
                                         str(body.get("title", "")), str(body.get("description", "")),
                                         str(body.get("instructions", "")), BUILTIN_RECIPE_DIRECTORY,
                                         body.get("stages"), body.get("objective"), body.get("rules"),
                                         body.get("tags"), body.get("initial_stage"),
                                         body.get("terminal_stages"), body.get("transitions"),
                                         **save_options)
                    return self._json(201, {"recipe": recipe.snapshot() | {"source": recipe.source}})
                except ValueError as error:
                    status = 409 if str(error) == "workflow_version_conflict" else 422
                    return self._json(status, {"error": str(error), "currentVersion": getattr(error, "current_version", None)})
                except OSError:
                    return self._json(422, {"error": "workflow_could_not_be_saved"})
            if self.path == "/api/projects":
                fields = [str(body.get(key, "")).strip() for key in ("repository", "name", "missionTitle", "goal")]
                if not fields[0] or not fields[1] or len(fields[1]) > 200:
                    return self._json(422, {"error": "repository_and_project_name_required"})
                if not fields[2] and not fields[3]:
                    try:
                        project = STORE.register_project(fields[0], fields[1])
                        STORE.set_project_agent_ids(
                            project["id"], _workspace_agent_ids(), _workspace_agent_ids(), _planner_agent_id(),
                        )
                        project["agentIds"] = STORE.project_agent_ids(project["id"], _workspace_agent_ids())
                        return self._json(201, {"project": project, "mission": None})
                    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                        return self._json(422, {"error": str(error) or "project_could_not_be_added"})
                project_goal = str(body.get("projectGoal", fields[3])).strip()
                if (any(not value for value in fields) or not project_goal or len(project_goal) > 10_000
                        or len(fields[1]) > 200 or len(fields[2]) > 200 or len(fields[3]) > 10_000):
                    return self._json(422, {"error": "repository_name_mission_title_and_goal_required"})
                recipe_id = str(body.get("recipeId") or "").strip()
                raw_version = body.get("recipeVersion")
                recipe_version = raw_version if isinstance(raw_version, int) and not isinstance(raw_version, bool) else None
                if raw_version is not None and (recipe_version is None or recipe_version < 1):
                    return self._json(422, {"error": "recipe_version_invalid"})
                workflow = None
                if recipe_id:
                    recipe = get_recipe(BUILTIN_RECIPE_DIRECTORY, USER_RECIPE_DIRECTORY, recipe_id, recipe_version)
                    if recipe is None:
                        return self._json(422, {"error": "workflow_recipe_not_found"})
                    workflow = recipe.snapshot()
                reference_files = body.get("referenceFiles", [])
                project, mission = STORE.create_project(
                    *fields, project_goal=project_goal, workflow=workflow, reference_files=reference_files,
                )
                STORE.set_project_agent_ids(
                    project["id"], _workspace_agent_ids(), _workspace_agent_ids(), _planner_agent_id(),
                )
                project["agentIds"] = STORE.project_agent_ids(project["id"], _workspace_agent_ids())
                SUPERVISOR.start_mission(mission["id"], initial_launch=True)
                return self._json(201, {"project": project, "mission": mission})
            if self.path == "/api/projects/clone":
                try:
                    project = STORE.clone_project(
                        str(body.get("url", "")), str(body.get("parentDirectory", "")),
                        str(body.get("name", "")),
                    )
                    STORE.set_project_agent_ids(
                        project["id"], _workspace_agent_ids(), _workspace_agent_ids(), _planner_agent_id(),
                    )
                    project["agentIds"] = STORE.project_agent_ids(project["id"], _workspace_agent_ids())
                    return self._json(201, {"project": project, "mission": None})
                except RuntimeError as error:
                    return self._json(422, {"error": str(error)})
                except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                    return self._json(422, {"error": str(error) or "repository_could_not_be_cloned"})
            if self.path == "/api/knowledge":
                project_id = str(body.get("projectId", ""))
                mission_id = str(body["missionId"]) if body.get("missionId") else None
                title = str(body.get("title", "")).strip()
                content = str(body.get("content", "")).strip()
                if not title or not content or len(title) > 200 or len(content) > 20_000:
                    return self._json(422, {"error": "title_and_content_required"})
                entry = save_project_memory(STORE, project_id, mission_id, "user", title, content)
                return self._json(201, {"entry": entry})
            review_match = re.fullmatch(r"/api/knowledge/([0-9a-f-]{36})/review", self.path)
            if review_match:
                decision = str(body.get("decision", "")).strip()
                result = STORE.review_knowledge_proposal(review_match.group(1), "user", decision)
                if decision == "accept":
                    result = accept_project_memory(STORE, result)
                return self._json(200, result)
            archive_match = re.fullmatch(r"/api/knowledge/([0-9a-f-]{36})/archive", self.path)
            if archive_match:
                mission_id = str(body.get("missionId", ""))
                mission = STORE.mission(mission_id)
                if not mission:
                    return self._json(404, {"error": "mission_not_found"})
                entry = set_project_memory_status(
                    STORE, mission["project_id"], archive_match.group(1), "archived", mission_id,
                )
                return self._json(200, {"entry": entry})
            restore_match = re.fullmatch(r"/api/knowledge/([0-9a-f-]{36})/restore", self.path)
            if restore_match:
                mission_id = str(body.get("missionId", ""))
                mission = STORE.mission(mission_id)
                if not mission:
                    return self._json(404, {"error": "mission_not_found"})
                entry = set_project_memory_status(
                    STORE, mission["project_id"], restore_match.group(1), "active", mission_id,
                )
                return self._json(200, {"entry": entry})
            if self.path == "/api/messages":
                text = str(body.get("text", "")).strip()
                if not text or len(text) > 20_000:
                    return self._json(422, {"error": "message_must_be_1_to_20000_characters"})
                mission_id = str(body.get("missionId", "mission-first"))
                mission = STORE.mission(mission_id)
                if not mission:
                    return self._json(404, {"error": "mission_not_found"})
                recipient_value = body.get("recipient")
                if recipient_value is not None and not isinstance(recipient_value, str):
                    return self._json(422, {"error": "message_recipient_invalid"})
                recipient = recipient_value.strip() if recipient_value is not None else None
                recipient = recipient or None
                if recipient:
                    project_agent_ids = STORE.project_agent_ids(
                        mission["project_id"], _workspace_agent_ids(),
                    )
                    if recipient not in project_agent_ids:
                        return self._json(422, {"error": "message_recipient_not_in_project_team"})
                payload = {
                    "text": text,
                    "recipient": recipient,
                }
                attachment_ids = body.get("attachments", [])
                if (not isinstance(attachment_ids, list) or len(attachment_ids) > 10
                        or any(not isinstance(item, str) for item in attachment_ids)
                        or len(set(attachment_ids)) != len(attachment_ids)):
                    return self._json(422, {"error": "message_attachments_invalid"})
                attached_artifacts = []
                attachment_bytes = 0
                for artifact_id in attachment_ids:
                    found = STORE.artifact_content(artifact_id, mission_id=mission_id)
                    if not found:
                        return self._json(404, {"error": "message_attachment_not_found"})
                    artifact, content = found
                    attachment_bytes += len(content)
                    if attachment_bytes > 20_000_000:
                        return self._json(422, {"error": "message_attachments_too_large"})
                    attached_artifacts.append({
                        "id": artifact["id"], "name": artifact["name"],
                        "mediaType": artifact.get("media_type") or "application/octet-stream",
                    })
                if attached_artifacts:
                    payload["attachments"] = attached_artifacts
                context = body.get("canvasDocument")
                if context is not None:
                    if not isinstance(context, dict):
                        return self._json(422, {"error": "canvas_document_context_invalid"})
                    artifact_id, revision = context.get("artifactId"), context.get("revision")
                    selected_text = context.get("selectedText", "")
                    if (not isinstance(artifact_id, str) or not isinstance(revision, int)
                            or isinstance(revision, bool) or revision < 1
                            or not isinstance(selected_text, str) or len(selected_text.encode("utf-8")) > 4096):
                        return self._json(422, {"error": "canvas_document_context_invalid"})
                    version = STORE.canvas_version(mission_id, artifact_id, revision)
                    if not version:
                        return self._json(404, {"error": "canvas_document_revision_not_found"})
                    payload["canvasDocument"] = {
                        "artifactId": artifact_id, "revision": revision,
                        "title": version["title"], "selectedText": selected_text,
                    }
                event = STORE.append("message.created", "user", mission_id, payload)
                return self._json(201, {"event": event})
            if self.path == "/api/commands":
                mission_id = str(body.get("missionId", ""))
                command_line = str(body.get("command", "")).strip()
                mission = STORE.mission(mission_id)
                if not mission:
                    return self._json(404, {"error": "mission_not_found"})
                approved_tools = STORE.project_command_tools(mission["project_id"])
                run = COMMANDS.start(
                    mission_id, COMMANDS.parse(command_line, approved_tools)
                )
                return self._json(201, {"run": run})
            if self.path == "/api/schedules":
                title = str(body.get("title", "")).strip()
                prompt = str(body.get("prompt", "")).strip()
                if not title or not prompt or len(title) > 200 or len(prompt) > 10_000:
                    return self._json(422, {"error": "title_and_prompt_required"})
                schedule = STORE.create_schedule(str(body.get("projectId", "")), title, prompt,
                                                 str(body.get("cadence", "daily")),
                                                 str(body.get("timezone", "UTC")),
                                                 str(body.get("deliveryTime", "09:00")))
                return self._json(201, {"schedule": schedule})
            schedule_action = re.fullmatch(r"/api/schedules/([0-9a-f-]{36})/(pause|resume|run-now|cancel)", self.path)
            if schedule_action:
                schedule = STORE.update_schedule(*schedule_action.groups())
                return self._json(404, {"error": "schedule_not_found"}) if not schedule else self._json(200, {"schedule": schedule})
            command_stop_match = re.fullmatch(r"/api/commands/([0-9a-f-]{36})/stop", self.path)
            if command_stop_match:
                run = COMMANDS.stop(command_stop_match.group(1))
                if not run:
                    return self._json(404, {"error": "command_run_not_found"})
                return self._json(200, {"run": run})
            if self.path == "/api/missions":
                title = str(body.get("title", "")).strip()
                goal = str(body.get("goal", "")).strip()
                initial_message = str(body.get("initialMessage", "")).strip()
                selected_skills = body.get("selectedSkills", [])
                raw_model_preference = body.get("modelPreference")
                raw_effort_preference = body.get("effortPreference")
                if (not title or not goal or len(title) > 200 or len(goal) > 10_000
                        or (initial_message and len(initial_message) > 20_000)
                        or not isinstance(selected_skills, list)
                        or len(selected_skills) > 20
                        or any(not isinstance(skill, str) or len(skill) > 300 for skill in selected_skills)
                        or raw_model_preference is not None and not isinstance(raw_model_preference, str)
                        or isinstance(raw_model_preference, str) and len(raw_model_preference) > 200
                        or raw_effort_preference is not None and not isinstance(raw_effort_preference, str)
                        or isinstance(raw_effort_preference, str) and len(raw_effort_preference) > 20):
                    return self._json(422, {"error": "title_goal_or_initial_message_invalid"})
                model_preference = raw_model_preference.strip() or None if isinstance(raw_model_preference, str) else None
                effort_preference = raw_effort_preference.strip().lower() or None if isinstance(raw_effort_preference, str) else None
                recipe_id = str(body.get("recipeId") or "").strip()
                raw_version = body.get("recipeVersion")
                recipe_version = raw_version if isinstance(raw_version, int) and not isinstance(raw_version, bool) else None
                if raw_version is not None and (recipe_version is None or recipe_version < 1):
                    return self._json(422, {"error": "recipe_version_invalid"})
                workflow = get_recipe(BUILTIN_RECIPE_DIRECTORY, USER_RECIPE_DIRECTORY, recipe_id, recipe_version) if recipe_id else None
                if recipe_id and not workflow:
                    return self._json(422, {"error": "recipe_not_found"})
                mission = STORE.create_mission(str(body.get("projectId", "")), title, goal,
                                               workflow.snapshot() if workflow else None,
                                               initial_message=initial_message or None,
                                               selected_skills=selected_skills,
                                               model_preference=model_preference,
                                               effort_preference=effort_preference)
                SUPERVISOR.pause_other_missions(mission["id"])
                SUPERVISOR.start_mission(mission["id"], initial_launch=True)
                return self._json(201, {"mission": mission})
            outcome_match = re.fullmatch(r"/api/missions/([0-9a-f-]{36})/outcome", self.path)
            if outcome_match:
                event = STORE.review_mission_outcome(
                    outcome_match.group(1), str(body.get("outcome", "")), str(body.get("notes", "")),
                )
                return self._json(201, {"event": event})
            model_preferences_match = re.fullmatch(
                r"/api/missions/([0-9a-f-]{36})/model-preferences", self.path,
            )
            if model_preferences_match:
                raw_model = body.get("model")
                raw_effort = body.get("effort")
                if raw_model is not None and not isinstance(raw_model, str):
                    return self._json(422, {"error": "model_preference_invalid"})
                if raw_effort is not None and not isinstance(raw_effort, str):
                    return self._json(422, {"error": "effort_preference_invalid"})
                model = raw_model.strip() or None if isinstance(raw_model, str) else None
                effort = raw_effort.strip().lower() or None if isinstance(raw_effort, str) else None
                try:
                    if model and STORE.provider_connection(provider_for_model(model)).get("enabled") is False:
                        return self._json(409, {"error": "agent_model_provider_disabled"})
                    mission = STORE.set_mission_model_preferences(
                        model_preferences_match.group(1), model, effort,
                    )
                    if not mission:
                        return self._json(404, {"error": "mission_not_found"})
                    return self._json(200, {"mission": mission})
                except ValueError as error:
                    return self._json(422, {"error": str(error) or "model_preferences_invalid"})
            if self.path.startswith("/api/missions/") and self.path.endswith("/resume"):
                mission_id = self.path.removeprefix("/api/missions/").removesuffix("/resume").strip("/")
                mission = STORE.activate_mission(mission_id)
                if not mission:
                    existing = STORE.mission(mission_id)
                    if existing and existing.get("archived_at"):
                        return self._json(409, {"error": "mission_archived"})
                    if existing and existing["status"] == "completed":
                        return self._json(409, {"error": "mission_completed"})
                    return self._json(404, {"error": "mission_not_found"})
                if not mission.get("background"):
                    SUPERVISOR.pause_other_missions(mission_id)
                SUPERVISOR.start_mission(mission_id)
                return self._json(200, {"mission": mission})
            pause_match = re.fullmatch(r"/api/missions/([0-9a-f-]{36})/pause", self.path)
            if pause_match:
                mission_id = pause_match.group(1)
                mission = STORE.pause_mission(mission_id)
                if not mission:
                    return self._json(404, {"error": "mission_not_found"})
                COMPUTER.cancel_mission(mission_id)
                SUPERVISOR.pause_mission(mission_id)
                return self._json(200, {"mission": mission})
            archive_match = re.fullmatch(r"/api/missions/([0-9a-f-]{36})/(archive|restore)", self.path)
            if archive_match:
                mission_id, action = archive_match.groups()
                try:
                    mission = (STORE.archive_mission(mission_id) if action == "archive"
                               else STORE.restore_mission(mission_id))
                except ValueError as error:
                    return self._json(409, {"error": str(error)})
                if not mission:
                    return self._json(404, {"error": "mission_not_found"})
                if action == "archive":
                    COMPUTER.cancel_mission(mission_id)
                return self._json(200, {"mission": mission})
            agent_stop_match = re.fullmatch(
                r"/api/missions/([0-9a-f-]{36})/agents/([a-z][a-z0-9_-]{0,49})/stop", self.path
            )
            if agent_stop_match:
                mission_id, agent_id = agent_stop_match.groups()
                if not STORE.mission(mission_id):
                    return self._json(404, {"error": "mission_not_found"})
                if not any(agent.id == agent_id for agent in AGENT_DEFINITIONS):
                    return self._json(404, {"error": "agent_not_found"})
                if not SUPERVISOR.stop_agent_run(mission_id, agent_id):
                    return self._json(409, {"error": "agent_run_not_active"})
                return self._json(202, {"status": "stopping"})
            discard_match = re.fullmatch(r"/api/missions/([0-9a-f-]{36})/isolation/([a-zA-Z0-9_-]{1,100})/discard", self.path)
            if discard_match:
                mission_id, agent_id = discard_match.groups()
                if agent_id not in {agent.id for agent in AGENT_DEFINITIONS}:
                    return self._json(404, {"error": "agent_not_found"})
                result = WorkspaceTools(STORE, mission_id, agent_id).discard_isolated_work()
                return self._json(200, result)
            interactive_action_match = re.fullmatch(
                r"/api/missions/([0-9a-f-]{36})/interactive-artifacts/([0-9a-f-]{36})/actions",
                self.path,
            )
            if interactive_action_match:
                try:
                    result = STORE.record_interactive_artifact_action(
                        interactive_action_match.group(1), interactive_action_match.group(2),
                        body.get("recipient", "planner"), body.get("action", "submit"), body.get("data"),
                    )
                    return self._json(201, result)
                except PermissionError as error:
                    return self._json(403, {"error": str(error)})
                except (TypeError, ValueError, json.JSONDecodeError) as error:
                    status = 404 if str(error) == "interactive_artifact_not_found" else 422
                    return self._json(status, {"error": str(error) or "invalid_request"})
            if self.path == "/api/work-items":
                title = str(body.get("title", "")).strip()
                if not title or len(title) > 500:
                    return self._json(422, {"error": "title_must_be_1_to_500_characters"})
                item = STORE.create_work_item(body.get("missionId", "mission-first"), title, str(body.get("detail", ""))[:5000])
                return self._json(201, {"workItem": item})
            if self.path == "/api/artifacts":
                encoded = str(body.get("contentBase64", ""))
                if len(encoded) > 13_333_336:
                    return self._json(413, {"error": "artifact_too_large"})
                content = base64.b64decode(encoded, validate=True)
                artifact, event = STORE.add_artifact(
                    body.get("missionId", "mission-first"), str(body.get("name", "")),
                    str(body.get("mediaType", "application/octet-stream")),
                    str(body.get("createdBy", "user")), content,
                )
                return self._json(201, {"artifact": artifact, "event": event})
            artifact_comment_match = re.fullmatch(r"/api/artifacts/([0-9a-f-]{36})/comments", self.path)
            if artifact_comment_match:
                result, event = STORE.add_artifact_review_comment(
                    artifact_comment_match.group(1), str(body.get("body", "")),
                    str(body.get("authorId", "user")), body.get("anchor"),
                    str(body["threadId"]) if body.get("threadId") else None,
                )
                return self._json(201, {**result, "event": event})
            canvas_link_match = re.fullmatch(
                r"/api/missions/([0-9a-f-]{36})/canvas/([0-9a-f-]{36})/link", self.path,
            )
            if canvas_link_match:
                try:
                    document, event = STORE.link_canvas_document(*canvas_link_match.groups())
                except ValueError as error:
                    if str(error) == "canvas_document_not_found":
                        return self._json(404, {"error": str(error)})
                    return self._json(409, {"error": str(error)})
                return self._json(201, {"document": document, "event": event})
            canvas_create_match = re.fullmatch(r"/api/missions/([0-9a-f-]{36})/canvas", self.path)
            if canvas_create_match:
                document, event = STORE.create_canvas_document(
                    canvas_create_match.group(1), str(body.get("title", "Untitled document")),
                    str(body.get("kind", "markdown")), str(body.get("language", "")),
                    str(body.get("body", "")), "user",
                )
                return self._json(201, {"document": document, "event": event})
            canvas_comment_match = re.fullmatch(
                r"/api/missions/([0-9a-f-]{36})/canvas/([0-9a-f-]{36})/comments", self.path,
            )
            if canvas_comment_match:
                result, event = STORE.create_canvas_comment(
                    canvas_comment_match.group(1), canvas_comment_match.group(2),
                    str(body.get("body", "")), "user",
                    base_revision=body.get("baseRevision"), quote=str(body.get("quote", "")),
                    start_offset=body.get("startOffset"), end_offset=body.get("endOffset"),
                    thread_id=body.get("threadId"), assignee=body.get("assignee"),
                )
                return self._json(201, {**result, "event": event})
            canvas_resolve_match = re.fullmatch(
                r"/api/missions/([0-9a-f-]{36})/canvas/threads/([0-9a-f-]{36})/resolve",
                self.path,
            )
            if canvas_resolve_match:
                result = STORE.resolve_canvas_comment(
                    canvas_resolve_match.group(1), canvas_resolve_match.group(2), "user",
                )
                if not result:
                    return self._json(409, {"error": "canvas_comment_thread_not_open"})
                thread, event = result
                return self._json(200, {"thread": thread, "event": event})
            canvas_proposal_review_match = re.fullmatch(
                r"/api/missions/([0-9a-f-]{36})/canvas/proposals/([0-9a-f-]{36})/review",
                self.path,
            )
            if canvas_proposal_review_match:
                try:
                    proposal, event = STORE.review_canvas_proposal(
                        canvas_proposal_review_match.group(1), canvas_proposal_review_match.group(2),
                        str(body.get("decision", "")), "user", body.get("acceptedContent"),
                    )
                except ValueError as error:
                    if str(error) == "canvas_proposal_stale":
                        return self._json(409, {"error": str(error)})
                    raise
                return self._json(200, {"proposal": proposal, "event": event})
            resolve_review_match = re.fullmatch(r"/api/artifact-review-threads/([0-9a-f-]{36})/resolve", self.path)
            if resolve_review_match:
                result = STORE.resolve_artifact_review_thread(
                    resolve_review_match.group(1), str(body.get("actorId", "user")),
                )
                if not result:
                    return self._json(409, {"error": "review_thread_missing_or_already_resolved"})
                thread, event = result
                return self._json(200, {"thread": thread, "event": event})
            reopen_review_match = re.fullmatch(
                r"/api/artifact-review-threads/([0-9a-f-]{36})/reopen", self.path,
            )
            if reopen_review_match:
                result = STORE.reopen_artifact_review_thread(
                    reopen_review_match.group(1), str(body.get("actorId", "user")),
                )
                if not result:
                    return self._json(409, {"error": "review_thread_missing_or_already_open"})
                thread, event = result
                return self._json(200, {"thread": thread, "event": event})
            if self.path.startswith("/api/agents/") and self.path.endswith("/claim"):
                agent_id = self.path.removeprefix("/api/agents/").removesuffix("/claim").strip("/")
                if agent_id not in {agent.id for agent in AGENT_DEFINITIONS}:
                    return self._json(404, {"error": "agent_not_found"})
                work_item_id = body.get("workItemId")
                if work_item_id is not None and (
                    not isinstance(work_item_id, str) or not work_item_id or len(work_item_id) > 100
                ):
                    return self._json(422, {"error": "work_item_id_must_be_a_string"})
                item = STORE.claim_work(
                    body.get("missionId", "mission-first"), agent_id,
                    work_item_id=work_item_id,
                )
                return self._json(200, {"workItem": item})
            if self.path == "/api/interactions":
                kind = body.get("type")
                if kind not in {"approval", "question"}:
                    return self._json(422, {"error": "type_must_be_approval_or_question"})
                if not str(body.get("title", "")).strip():
                    return self._json(422, {"error": "title_required"})
                item = STORE.create_interaction(body.get("missionId", "mission-first"), kind,
                    str(body["title"])[:500], str(body.get("details", ""))[:5000],
                    str(body["target"])[:2000] if body.get("target") else None,
                    str(body.get("requestedBy", "agent"))[:100])
                return self._json(201, {"interaction": item})
            if self.path.startswith("/api/interactions/") and self.path.endswith("/resolve"):
                interaction_id = self.path.removeprefix("/api/interactions/").removesuffix("/resolve").strip("/")
                resolution = str(body.get("resolution", "")).strip()
                item = STORE.resolve_interaction(interaction_id, resolution)
                if not item:
                    return self._json(409, {"error": "interaction_missing_or_already_resolved"})
                return self._json(200, {"interaction": item})
        except OverflowError:
            return self._json(413, {"error": "request_too_large"})
        except RuntimeError as error:
            return self._json(503, {"error": str(error)})
        except (ValueError, json.JSONDecodeError, binascii.Error) as error:
            if isinstance(error, ValueError) and str(error):
                return self._json(422, {"error": str(error)})
            return self._json(400, {"error": "invalid_request"})
        return self._json(404, {"error": "not_found"})

    def do_PUT(self) -> None:
        if not self._local_origin():
            return self._json(403, {"error": "local_origin_required"})
        if RESTORE_PENDING.is_set():
            return self._json(503, {"error": "workspace_restore_shutting_down"})
        if self.path == "/api/settings/image-generation":
            try:
                body = self._body()
                model = body.get("model", "")
                supported_models = {
                    "openai:gpt-image-2.5-flare": "openai",
                    "openai:gpt-image-2.5-sunburst": "openai",
                    "openai:gpt-image-2": "openai",
                    "google:gemini-3.1-flash-lite-image": "google",
                    "google:gemini-3.1-flash-image": "google",
                    "google:gemini-3-pro-image": "google",
                    "xai:grok-imagine-image-2.0": "xai",
                    "xai:grok-imagine-image": "xai",
                }
                if not isinstance(model, str) or model not in {"", *supported_models}:
                    return self._json(422, {"error": "image_generation_model_unsupported"})
                if model:
                    provider = supported_models[model]
                    if STORE.provider_connection(provider).get("enabled") is False:
                        return self._json(422, {"error": "image_generation_provider_disabled"})
                    if not get_api_key(f"{provider}:image-generation"):
                        return self._json(422, {"error": "image_generation_provider_not_configured"})
                STORE.set_setting("image_generation_model", model)
                return self._json(200, {"model": model})
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid_request"})
        if self.path == "/api/settings/context-pruning":
            try:
                body = self._body()
                enabled = body.get("enabled")
                if not isinstance(enabled, bool):
                    return self._json(422, {"error": "context_pruning_setting_invalid"})
                STORE.set_setting("experimental_context_pruning", "true" if enabled else "false")
                return self._json(200, {"enabled": enabled})
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid_request"})
        if self.path == "/api/providers/enabled":
            try:
                body = self._body()
                provider = str(body.get("provider", "")).strip().lower()
                enabled = body.get("enabled")
                if not provider or len(provider) > 100 or not isinstance(enabled, bool):
                    return self._json(422, {"error": "provider_enabled_request_invalid"})
                provider_for_model(f"{provider}:connection")
                if not enabled:
                    default_model = SUPERVISOR.status.get("model")
                    default_provider = provider_for_model(default_model) if default_model else ""
                    image_model = STORE.get_setting("image_generation_model") or ""
                    image_provider = provider_for_model(image_model) if image_model else ""
                    with AGENT_REGISTRY_LOCK:
                        pinned = any(agent.model and provider_for_model(agent.model) == provider for agent in AGENT_DEFINITIONS)
                    if image_provider == provider:
                        return self._json(409, {"error": "image_generation_provider_in_use"})
                    if default_provider == provider or pinned:
                        return self._json(409, {"error": "provider_is_in_use"})
                connection = STORE.set_provider_enabled(provider, enabled)
                return self._json(200, {"connection": {"id": provider, **connection}})
            except ValueError as error:
                return self._json(422, {"error": str(error) or "provider_enabled_update_failed"})
            except (json.JSONDecodeError, binascii.Error):
                return self._json(400, {"error": "invalid_request"})
        if self.path == "/api/models/allowed":
            try:
                body = self._body()
                identifier = str(body.get("model", ""))
                allowed = body.get("allowed")
                if not identifier or len(identifier) > 200 or not isinstance(allowed, bool):
                    return self._json(422, {"error": "model_allow_request_invalid"})
                if not allowed:
                    with AGENT_REGISTRY_LOCK:
                        is_pinned = any(agent.model == identifier for agent in AGENT_DEFINITIONS)
                    if is_pinned:
                        return self._json(409, {"error": "model_is_pinned_by_agent"})
                models = STORE.set_model_allowed(identifier, allowed)
                return self._json(200, {"models": models})
            except ValueError as error:
                return self._json(409 if str(error) == "workspace_default_model_must_remain_allowed" else 422,
                                  {"error": str(error) or "model_allow_update_failed"})
            except (json.JSONDecodeError, binascii.Error):
                return self._json(400, {"error": "invalid_request"})
        if self.path == "/api/models/metadata":
            try:
                body = self._body()
                identifier, metadata = body.get("model"), body.get("metadata")
                if not isinstance(identifier, str) or not identifier or len(identifier) > 200:
                    return self._json(422, {"error": "model_identifier_invalid"})
                if not isinstance(metadata, dict):
                    return self._json(422, {"error": "model_metadata_invalid"})
                return self._json(200, {"models": STORE.update_model_metadata(identifier, metadata)})
            except ValueError as error:
                return self._json(422, {"error": str(error) or "model_metadata_invalid"})
            except (json.JSONDecodeError, binascii.Error):
                return self._json(400, {"error": "invalid_request"})
        computer_access_match = re.fullmatch(
            r"/api/projects/([0-9a-f-]{36})/computer-access", self.path
        )
        if computer_access_match:
            try:
                project_id = computer_access_match.group(1)
                policy = STORE.set_project_computer_access(project_id, self._body().get("enabled"))
                if not policy["enabled"]:
                    for mission_id in STORE.mission_ids_for_project(project_id):
                        COMPUTER.cancel_mission(mission_id)
                return self._json(200, {"computerAccess": policy})
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error) or "invalid_request"})
        canvas_match = re.fullmatch(
            r"/api/missions/([0-9a-f-]{36})/canvas/([0-9a-f-]{36})", self.path,
        )
        if canvas_match:
            try:
                body = self._body()
                document, event = STORE.save_canvas_document(
                    canvas_match.group(1), canvas_match.group(2),
                    int(body.get("expectedRevision", 0)),
                    str(body.get("title", "")), str(body.get("kind", "")),
                    str(body.get("language", "")), str(body.get("body", "")),
                )
                return self._json(200, {"document": document, "event": event})
            except ValueError as error:
                if str(error) == "canvas_revision_conflict":
                    return self._json(409, {"error": str(error)})
                return self._json(422, {"error": str(error)})
        team_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/team", self.path)
        if team_match:
            try:
                body = self._body()
                project_id = team_match.group(1)
                selected = STORE.set_project_agent_ids(
                    project_id, body.get("agentIds"), _workspace_agent_ids(), _planner_agent_id(),
                )
                SUPERVISOR.update_project_team(project_id)
                return self._json(200, {"projectId": project_id, "agentIds": selected})
            except OverflowError:
                return self._json(413, {"error": "request_too_large"})
            except (ValueError, json.JSONDecodeError) as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error) or "invalid_request"})

        project_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/goal", self.path)
        if project_match:
            try:
                body = self._body()
                goal = str(body.get("goal", "")).strip()
                project = STORE.update_project_goal(
                    project_match.group(1), str(body.get("missionId", "")), goal,
                    body.get("referenceFiles", []),
                )
                if not project:
                    return self._json(404, {"error": "project_not_found"})
                return self._json(200, {"project": project})
            except OverflowError:
                return self._json(413, {"error": "request_too_large"})
            except (ValueError, json.JSONDecodeError) as error:
                return self._json(422, {"error": str(error) or "invalid_request"})
        usage_budget_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/usage-budget", self.path)
        if usage_budget_match:
            try:
                body = self._body()
                limit = body.get("monthlyTokensLimit")
                max_run_cost = body["maxRunCostUsd"] if "maxRunCostUsd" in body else ...
                max_run_tokens = body["maxRunTokens"] if "maxRunTokens" in body else ...
                budget = STORE.set_project_usage_budget(
                    usage_budget_match.group(1), limit, max_run_cost, max_run_tokens
                )
                return self._json(200, {"budget": budget})
            except OverflowError:
                return self._json(413, {"error": "request_too_large"})
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error) or "invalid_request"})
        web_access_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/web-access", self.path)
        if web_access_match:
            try:
                body = self._body()
                policy = STORE.set_project_web_access(
                    web_access_match.group(1), body.get("enabled"), body.get("allowedDomains", [])
                )
                return self._json(200, {"webAccess": policy})
            except OverflowError:
                return self._json(413, {"error": "request_too_large"})
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error) or "invalid_request"})
        interactive_access_match = re.fullmatch(
            r"/api/projects/([0-9a-f-]{36})/interactive-access", self.path
        )
        if interactive_access_match:
            try:
                policy = STORE.set_project_interactive_access(
                    interactive_access_match.group(1), self._body().get("enabled")
                )
                return self._json(200, {"interactiveAccess": policy})
            except OverflowError:
                return self._json(413, {"error": "request_too_large"})
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error) or "invalid_request"})
        command_tools_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/command-tools", self.path)
        if command_tools_match:
            try:
                body = self._body()
                executables = STORE.set_project_command_tools(
                    command_tools_match.group(1), body.get("executables", [])
                )
                return self._json(200, {"executables": executables})
            except OverflowError:
                return self._json(413, {"error": "request_too_large"})
            except (ValueError, json.JSONDecodeError) as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error) or "invalid_request"})
        mcp_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/mcp", self.path)
        if mcp_match:
            try:
                body = self._body()
                project_id = mcp_match.group(1)
                registry = MCPRegistry(STORE)
                config = registry.save_config(project_id, body.get("config"))
                bootstrap = STORE.bootstrap(project_id)
                for mission in bootstrap["missions"]:
                    if mission["status"] == "active":
                        STORE.append("project.mcp.config.updated", "user", mission["id"], {
                            "servers": sorted(config["mcpServers"]),
                        })
                return self._json(200, {
                    "config": config,
                    "secretStatus": registry.secret_status(project_id),
                })
            except OverflowError:
                return self._json(413, {"error": "request_too_large"})
            except RuntimeError as error:
                return self._json(503, {"error": str(error)})
            except (ValueError, json.JSONDecodeError) as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error) or "invalid_request"})
        mcp_secrets_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})/mcp/secrets", self.path)
        if mcp_secrets_match:
            try:
                body = self._body()
                registry = MCPRegistry(STORE)
                statuses = registry.save_secrets(mcp_secrets_match.group(1), body.get("secrets"))
                return self._json(200, {"secretStatus": statuses})
            except OverflowError:
                return self._json(413, {"error": "request_too_large"})
            except RuntimeError as error:
                return self._json(503, {"error": str(error)})
            except (ValueError, json.JSONDecodeError) as error:
                status = 404 if str(error) == "project_not_found" else 422
                return self._json(status, {"error": str(error) or "invalid_request"})
        match = re.fullmatch(r"/api/agents/([a-z][a-z0-9_-]{0,49})", self.path)
        if not match:
            return self._json(404, {"error": "not_found"})
        agent_id = match.group(1)
        try:
            body = self._body()
            with AGENT_REGISTRY_LOCK:
                index = next(
                    (index for index, agent in enumerate(AGENT_DEFINITIONS) if agent.id == agent_id),
                    None,
                )
                if index is None:
                    return self._json(404, {"error": "agent_not_found"})
                if AGENT_DEFINITIONS[index].source != "user":
                    return self._json(403, {"error": "built_in_agent_is_read_only"})
                validate_agent_model_override(
                    str(body.get("model", "")), str(body.get("effort", "")),
                )
                definition = update_agent_definition(
                    USER_AGENT_DIRECTORY,
                    agent_id,
                    str(body.get("name", "")),
                    str(body.get("role", "")),
                    str(body.get("instructions", "")),
                    str(body.get("model", "")),
                    str(body.get("repositoryAccess", "workspace_write")),
                    str(body.get("effort", "")),
                    body.get("capabilities", body.get("toolPermissions")),
                )
                SUPERVISOR.update_agent(definition)
                AGENT_DEFINITIONS[index] = definition
            return self._json(200, {
                "agent": _agent_payload(definition),
                "agentDirectory": str(USER_AGENT_DIRECTORY),
            })
        except OverflowError:
            return self._json(413, {"error": "request_too_large"})
        except PermissionError as error:
            return self._json(403, {"error": str(error)})
        except RuntimeError as error:
            return self._json(503, {"error": str(error)})
        except ValueError as error:
            return self._json(422, {"error": str(error)})

    def do_DELETE(self) -> None:
        if not self._local_origin():
            return self._json(403, {"error": "local_origin_required"})
        if RESTORE_PENDING.is_set():
            return self._json(503, {"error": "workspace_restore_shutting_down"})
        mcp_oauth_forget_match = re.fullmatch(
            r"/api/projects/([0-9a-f-]{36})/mcp/oauth/([a-zA-Z0-9_-]{1,64})", self.path,
        )
        if mcp_oauth_forget_match:
            try:
                registry = MCPRegistry(STORE)
                return self._json(200, asyncio.run(registry.forget_oauth(*mcp_oauth_forget_match.groups())))
            except RuntimeError as error:
                return self._json(503, {"error": str(error)})
            except ValueError as error:
                return self._json(404 if str(error) == "project_not_found" else 422, {"error": str(error)})
        delete_project_match = re.fullmatch(r"/api/projects/([0-9a-f-]{36})", self.path)
        if delete_project_match:
            project_id = delete_project_match.group(1)
            project = STORE.project(project_id)
            if not project:
                return self._json(404, {"error": "project_not_found"})
            try:
                mcp_registry = MCPRegistry(STORE)
                try:
                    mcp_config = mcp_registry.get_config(project_id)
                except (OSError, ValueError):
                    mcp_config = None
                deleted = STORE.delete_project(project_id)
                if not deleted:
                    return self._json(404, {"error": "project_not_found"})
                credential_cleanup = "complete"
                try:
                    asyncio.run(mcp_registry.delete_project_data(project_id, mcp_config))
                except (OSError, RuntimeError, ValueError) as error:
                    credential_cleanup = "incomplete"
                    LOGGER.warning("Project %s was deleted, but saved MCP credentials could not all be cleared: %s", project_id, error)
                return self._json(200, {"project": deleted, "credentialCleanup": credential_cleanup})
            except ValueError as error:
                return self._json(409 if str(error) == "project_has_unfinished_work" else 404, {"error": str(error)})
        delete_mission_match = re.fullmatch(r"/api/missions/([0-9a-f-]{36})", self.path)
        if delete_mission_match:
            try:
                deleted = STORE.delete_mission(delete_mission_match.group(1))
                if not deleted:
                    return self._json(404, {"error": "mission_not_found"})
                return self._json(200, {"mission": deleted})
            except ValueError as error:
                return self._json(409, {"error": str(error)})
        canvas_unlink_match = re.fullmatch(
            r"/api/missions/([0-9a-f-]{36})/canvas/([0-9a-f-]{36})/link", self.path,
        )
        if canvas_unlink_match:
            result = STORE.unlink_canvas_document(*canvas_unlink_match.groups())
            if not result:
                return self._json(404, {"error": "canvas_document_link_not_found"})
            return self._json(200, {"event": result["event"]})
        match = re.fullmatch(r"/api/agents/([a-z][a-z0-9_-]{0,49})", self.path)
        if not match:
            return self._json(404, {"error": "not_found"})
        agent_id = match.group(1)
        try:
            with AGENT_REGISTRY_LOCK:
                definition = next((item for item in AGENT_DEFINITIONS if item.id == agent_id), None)
                if not definition:
                    return self._json(404, {"error": "agent_not_found"})
                if definition.source != "user":
                    return self._json(403, {"error": "built_in_agent_is_read_only"})
                archived_path = archive_agent_definition(USER_AGENT_DIRECTORY, agent_id)
                try:
                    SUPERVISOR.unregister_agent(agent_id)
                except Exception:
                    archived_path.replace(USER_AGENT_DIRECTORY / f"{agent_id}.md")
                    raise
                AGENT_DEFINITIONS[:] = [item for item in AGENT_DEFINITIONS if item.id != agent_id]
                STORE.remove_agent_from_project_teams(agent_id)
            return self._json(200, {"archived": agent_id, "archivePath": str(archived_path)})
        except ValueError as error:
            return self._json(422, {"error": str(error)})
        except OSError as error:
            return self._json(500, {"error": f"agent_archive_failed: {error}"})

    def _stream_events(self, mission_id: str, cursor: int) -> None:
        if not STORE.mission(mission_id):
            return self._json(404, {"error": "mission_not_found"})
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last_heartbeat = time.monotonic()
        try:
            while True:
                while True:
                    events, has_more = STORE.events_after_page(mission_id, cursor, 200)
                    if not events:
                        break
                    for event in events:
                        frame = f"id: {event['sequence']}\ndata: {json.dumps(event)}\n\n".encode()
                        self.wfile.write(frame)
                        self.wfile.flush()
                        cursor = event["sequence"]
                    if not has_more:
                        break
                if time.monotonic() - last_heartbeat > 15:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    last_heartbeat = time.monotonic()
                time.sleep(0.4)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return

    def _local_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True  # Native local clients do not send Origin.
        parsed = urlparse(origin)
        host = (parsed.hostname or "").lower()
        configured_dev_origin = os.environ.get("TRIBE_DEV_ORIGIN", "").rstrip("/")
        if origin.rstrip("/") == configured_dev_origin and parsed.scheme == "http" and host in {"localhost", "127.0.0.1", "::1"}:
            return True
        if parsed.scheme == "tauri":
            return host == "localhost"
        if host == "tauri.localhost":
            return parsed.scheme in {"http", "https"} and parsed.port is None
        return (parsed.scheme == "http" and host in {"localhost", "127.0.0.1", "::1", "terminal.local"}
                and parsed.port in {4173, 4174, 5173, 5174})


def main() -> None:
    host, port = "127.0.0.1", int(os.environ.get("TRIBE_PORT", "4317"))
    if os.environ.get("TRIBE_BROWSER_API_PORT"):
        from .agent_runtime import configure_browser_api_token
        configure_browser_api_token(sys.stdin.readline(256).strip())
    if not 0 <= port <= 65535:
        raise ValueError("TRIBE_PORT must be between 0 and 65535")
    server = None
    price_updater = None

    def run_scheduler() -> None:
        while True:
            try:
                STORE.reconcile_scheduled_runs()
                if SUPERVISOR.enabled and not RESTORE_PENDING.is_set():
                    for run in STORE.claim_due_schedules():
                        SUPERVISOR.start_mission(run["missionId"])
            except (OSError, RuntimeError, ValueError, sqlite3.Error) as error:
                print(f"Schedule poll failed: {error}", flush=True)
            time.sleep(3)

    try:
        server = LocalHTTPServer((host, port), Handler)
        STORE.recover_usage_reservations()
        STORE.reconcile_repository_file_deletions()
        SUPERVISOR.recover_interrupted_agent_runs()
        SUPERVISOR.start_active_missions()
        threading.Thread(target=run_scheduler, daemon=True, name="tribe-scheduler").start()
        try:
            from pydantic_ai import prices
            price_updater = prices.update_in_background()
        except ImportError:
            pass
        restore_cleanup_error = WorkspaceRestore(STORE.data_dir).finalize_activation()
        if restore_cleanup_error:
            print(restore_cleanup_error, flush=True)
        print(f"Tribe runtime listening on http://{host}:{port}", flush=True)
        signal.signal(signal.SIGTERM, lambda _signum, _frame: threading.Thread(
            target=server.shutdown, daemon=True, name="tribe-runtime-sigterm"
        ).start())
        server.serve_forever()
    finally:
        try:
            if price_updater is not None:
                price_updater.stop()
            COMMANDS.close()
            BROWSER.close_all()
            SUPERVISOR.close()
            if server is not None:
                server.server_close()
        finally:
            RUNTIME_LOCK.release()


if __name__ == "__main__":
    main()
