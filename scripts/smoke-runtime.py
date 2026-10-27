"""Launch a packaged runtime and verify its local health endpoint responds."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]


def default_executable(root: Path, target: str) -> Path:
    if target.endswith("apple-darwin"):
        return root / "src-tauri/target" / target / "release/bundle/macos/Tribe.app/Contents/MacOS/tribe-runtime"
    suffix = ".exe" if target.endswith("windows-msvc") else ""
    return root / "src-tauri/binaries" / f"tribe-runtime-{target}{suffix}"


def free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def post_json(endpoint: str, payload: dict) -> dict:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        if response.status not in {200, 201}:
            raise RuntimeError(f"unexpected response from {endpoint}: {response.status}")
        return json.loads(response.read())


def get_json(endpoint: str) -> dict:
    with urllib.request.urlopen(endpoint, timeout=5) as response:
        return json.loads(response.read())


def verify_browser_install_requires_project_setup(base_url: str, project_id: str) -> None:
    """Exercise the packaged installer route without triggering a browser download."""
    request = urllib.request.Request(
        f"{base_url}/api/projects/{project_id}/mcp/playwright/install",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=5)
    except urllib.error.HTTPError as error:
        with error:
            payload = json.loads(error.read())
        if error.code != 409 or payload.get("error") != "Add the browser tools to this project first.":
            raise RuntimeError(f"packaged browser installer returned an unexpected guard response: {payload!r}")
    else:
        raise RuntimeError("packaged browser installer must require the project browser tools")


def verify_command_stop(base_url: str, mission_id: str) -> None:
    """Check the packaged command stop endpoint reaches a durable terminal state."""
    run = post_json(f"{base_url}/api/commands", {
        "missionId": mission_id,
        "command": "python -m http.server 0",
    }).get("run", {})
    run_id = run.get("id")
    if not run_id:
        raise RuntimeError(f"packaged runtime did not start a background command: {run!r}")
    post_json(f"{base_url}/api/commands/{run_id}/stop", {})
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        runs = get_json(f"{base_url}/api/commands?mission={mission_id}").get("runs", [])
        current = next((item for item in runs if item.get("id") == run_id), None)
        if current and current.get("status") != "running":
            if current["status"] != "cancelled":
                raise RuntimeError(f"packaged command stop ended as {current['status']!r}")
            return
        time.sleep(0.1)
    raise RuntimeError("packaged command did not stop within the expected time")


def shutdown_runtime(base_url: str, process: subprocess.Popen) -> None:
    """Ask the packaged sidecar to stop cleanly, then bound the fallback wait."""
    if process.poll() is not None:
        return
    request = urllib.request.Request(
        f"{base_url}/api/shutdown",
        data=b"{}",
        headers={"Content-Type": "application/json", "Origin": "tauri://localhost"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            shutdown_accepted = response.status == 202
    except OSError:
        shutdown_accepted = False
    if not shutdown_accepted:
        process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def verify_local_model_discovery(base_url: str) -> None:
    endpoint = f"{base_url}/api/providers/ollama/models"
    try:
        payload = get_json(endpoint)
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read())
        if error.code != 503 or payload.get("error") != "ollama_unavailable":
            raise RuntimeError(f"unexpected local model discovery failure: {payload!r}") from error
        return
    models = payload.get("models")
    if not isinstance(models, list) or any(
        not isinstance(item, dict) or not isinstance(item.get("name"), str)
        for item in models
    ):
        raise RuntimeError(f"packaged runtime returned invalid local model discovery data: {payload!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--agent-dir", type=Path, required=True)
    parser.add_argument("--executable", type=Path)
    parser.add_argument("--live-inference", action="store_true")
    parser.add_argument("--model", default="ollama:qwen3")
    args = parser.parse_args()

    executable = args.executable or default_executable(ROOT, args.target)
    executable = executable.resolve(strict=True)
    provider_check = subprocess.run(
        [str(executable), "--smoke-providers"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if provider_check.returncode:
        raise RuntimeError(
            "packaged runtime could not construct all configured PydanticAI providers: "
            f"{provider_check.stderr[-4000:]}"
        )
    print(provider_check.stdout.strip())
    agent_dir = args.agent_dir.resolve(strict=True)
    port = free_loopback_port()
    environment = {
        **os.environ,
        "TRIBE_DATA_DIR": "",
        "TRIBE_AGENT_DIR": str(agent_dir),
        "TRIBE_PORT": str(port),
    }

    with tempfile.TemporaryDirectory(prefix="tribe-sidecar-smoke-") as data_dir:
        environment["TRIBE_DATA_DIR"] = data_dir
        if args.live_inference:
            agent_dir = Path(data_dir) / "smoke-agents"
            agent_dir.mkdir()
            (agent_dir / "smoke_agent.md").write_text(
                "---\nid: smoke_agent\nname: Smoke agent\nrole: Local integration checker\n"
                "repository_access: read_only\n---\n"
                "Use only the Tribe mission tools list_plan_items, claim_work and post_update. First, "
                "call list_plan_items and find the task titled 'Claim the packaged-runtime smoke task'. "
                "Call claim_work with that exact task's ID as work_item_id. If the claim succeeds, call "
                "post_update with a short message naming the task. Do not post an update before claiming "
                "work, and do not claim a different item. "
                "Do not call repository, artifact, shell, skill, or other tools. Do not describe tool "
                "calls in prose; invoke the named tools directly.\n",
                encoding="utf-8",
            )
        environment["TRIBE_AGENT_DIR"] = str(agent_dir)
        process = subprocess.Popen(
            [str(executable)],
            cwd=Path.cwd(),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            base_url = f"http://127.0.0.1:{port}"
            endpoint = f"{base_url}/api/health"
            deadline = time.monotonic() + 60
            last_error: Exception | None = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"packaged runtime exited with code {process.returncode}")
                try:
                    with urllib.request.urlopen(endpoint, timeout=1) as response:
                        payload = json.loads(response.read())
                    if response.status != 200 or payload.get("status") != "ok" or payload.get("runtime") != "local":
                        raise RuntimeError(f"unexpected runtime health response: {payload!r}")
                    break
                except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                    last_error = error
                    time.sleep(0.25)
            else:
                raise RuntimeError(f"packaged runtime did not become healthy: {last_error}")

            model = args.model if args.live_inference else "ollama:qwen3"
            verify_local_model_discovery(base_url)
            configured = post_json(f"{base_url}/api/settings", {"model": model, "apiKey": ""})
            if not configured.get("agents", {}).get("configured"):
                raise RuntimeError(f"packaged runtime did not configure Ollama: {configured!r}")
            repository = Path(data_dir) / "smoke-repository"
            repository.mkdir()
            subprocess.run(["git", "init", "--quiet", str(repository)], check=True)
            project = post_json(f"{base_url}/api/projects", {
                "repository": str(repository),
                "name": "Sidecar smoke test",
                "projectGoal": "Verify packaged model provider construction",
                "missionTitle": "Start local models",
                "goal": "Construct local Ollama agent providers without making inference requests",
            })
            if not project.get("mission", {}).get("id"):
                raise RuntimeError(f"packaged runtime did not start a mission: {project!r}")
            verify_browser_install_requires_project_setup(base_url, project["project"]["id"])
            verify_command_stop(base_url, project["mission"]["id"])
            with urllib.request.urlopen(f"{base_url}/api/settings", timeout=5) as response:
                settings = json.loads(response.read())
            if not settings.get("agents", {}).get("enabled"):
                raise RuntimeError(f"packaged agent providers did not start: {settings!r}")
            if args.live_inference:
                connection = post_json(f"{base_url}/api/settings/check", {}).get("check", {})
                if not connection.get("ok") or not connection.get("toolCalling"):
                    raise RuntimeError(
                        "configured model must pass the native tool-calling check before the live-agent smoke: "
                        f"{connection!r}"
                    )
            mission_id = project["mission"]["id"]
            query = urlencode({"project": project["project"]["id"], "mission": mission_id})
            with urllib.request.urlopen(f"{base_url}/api/bootstrap?{query}", timeout=5) as response:
                bootstrap = json.loads(response.read())
            if not bootstrap.get("agents"):
                raise RuntimeError("packaged runtime did not load agent role definitions")
            audit_request = urllib.request.Request(
                f"{base_url}/api/projects/{project['project']['id']}/audit-export",
                headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(audit_request, timeout=5) as response:
                audit = json.loads(response.read())
            if audit.get("format") != "tribe.project-audit" or audit.get("schemaVersion") != 1:
                raise RuntimeError(f"packaged runtime returned an invalid project audit: {audit!r}")
            if audit.get("project", {}).get("id") != project["project"]["id"]:
                raise RuntimeError("project audit did not preserve project identity")
            exported_missions = {item["id"]: item for item in audit.get("missions", [])}
            if mission_id not in exported_missions or not any(
                event.get("type") == "mission.created"
                for event in exported_missions[mission_id].get("events", [])
            ):
                raise RuntimeError("project audit did not contain the mission creation event")
            if args.live_inference:
                mission_id = project["mission"]["id"]
                item = post_json(f"{base_url}/api/work-items", {
                    "missionId": mission_id,
                    "title": "Claim the packaged-runtime smoke task",
                    "detail": "Claim this task and post a brief update to the mission channel.",
                })["workItem"]
                cursor = 0
                claimed = False
                updated = False
                observed: list[str] = []
                deadline = time.monotonic() + 180
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f"packaged runtime exited with code {process.returncode}")
                    events = get_json(f"{base_url}/api/events?mission={mission_id}&after={cursor}")["events"]
                    for event in events:
                        cursor = max(cursor, event["sequence"])
                        if event["type"] in {"agent.activity", "agent.run.failed", "agent.message.created",
                                               "plan.item.claimed", "plan.item.created"}:
                            summary = f"{event['sequence']}:{event['actorId']}:{event['type']}"
                            if event["type"] == "agent.message.created":
                                summary += f":{event['payload'].get('text', '')[:240]}"
                            observed.append(summary)
                        if (event["type"] == "plan.item.claimed" and event["actorId"] == "smoke_agent"
                                and event["payload"]["workItem"]["id"] == item["id"]):
                            claimed = True
                        if (event["type"] == "agent.message.created" and event["actorId"] == "smoke_agent"
                                and event["payload"].get("workItemId") == item["id"]):
                            updated = True
                        if event["type"] == "agent.run.failed":
                            raise RuntimeError(f"local agent run failed: {event['payload'].get('error')}")
                    if claimed and updated:
                        print(f"Live Ollama agent self-claimed work and posted an update ({model})")
                        return 0
                    time.sleep(1)
                raise RuntimeError(
                    "local agent did not claim and report within 180 seconds "
                    f"(claimed={claimed}, updated={updated}, events={observed[-30:]})"
                )
            print(f"Packaged runtime and Ollama agent providers healthy on loopback port {port}")
            return 0
        finally:
            shutdown_runtime(base_url, process)


if __name__ == "__main__":
    raise SystemExit(main())
