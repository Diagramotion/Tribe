"""User-launched repository commands with a durable mission history."""

from __future__ import annotations

import os
import queue
import shlex
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import tomllib
import uuid
from collections.abc import Callable
from pathlib import Path

from .store import MissionStore
from .windows_job import WindowsProcessJob

ALLOWED_EXECUTABLES = frozenset({
    # JavaScript and TypeScript
    "bun", "corepack", "deno", "node", "npm", "npx", "pnpm", "yarn",
    # Python
    "conda-lock", "jupyter", "mypy", "nox", "pip", "pip3", "pipenv", "pipx", "pixi", "poetry", "pytest", "python", "python3", "ruff", "tox", "uv",
    # Compiled languages and build tools
    "cargo", "cmake", "ctest", "dotnet", "go", "gradle", "java", "javac", "make", "mvn", "swift", "xcodebuild",
    # Ruby and PHP
    "bundle", "composer", "gem", "php", "ruby",
    # Version control and container builds
    "git", "docker", "podman",
})
WINDOWS_SCRIPT_CONTROL_CHARS = frozenset("&|<>^%!()\r\n")
STOP_GRACE_SECONDS = 3.0


def build_launch_argv(argv: list[str], executable: str, *, windows: bool | None = None,
                      comspec: str | None = None) -> list[str]:
    """Prepare an allowlisted command for direct or Windows script execution."""
    windows = os.name == "nt" if windows is None else windows
    if not windows or Path(executable).suffix.lower() not in {".cmd", ".bat"}:
        return argv
    if any(any(char in argument for char in WINDOWS_SCRIPT_CONTROL_CHARS) for argument in argv[1:]):
        raise ValueError("Windows script arguments cannot contain shell control characters")
    return [
        comspec or os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c",
        subprocess.list2cmdline([executable, *argv[1:]]),
    ]


def run_foreground_process(
    argv: list[str], *, cwd: Path, timeout: float,
    env: dict[str, str] | None = None, is_cancelled: Callable[[], bool] | None = None,
) -> dict[str, object]:
    """Run a bounded foreground command and stop its process tree on timeout or cancellation."""
    executable = shutil.which(argv[0])
    if not executable:
        return {"exit_code": 127, "stdout": "", "stderr": f"executable not found: {argv[0]}",
                "timed_out": False, "cancelled": False}
    launch_argv = build_launch_argv([executable, *argv[1:]], executable)
    timed_out = False
    cancelled = False
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        try:
            process = subprocess.Popen(
                launch_argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=stdout_file,
                stderr=stderr_file, shell=False, env=env, start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            )
        except OSError as error:
            return {"exit_code": 127, "stdout": "", "stderr": str(error),
                    "timed_out": False, "cancelled": False}
        job = BackgroundCommandRunner._create_process_job(process)
        try:
            deadline = time.monotonic() + max(0.01, timeout)
            while process.poll() is None:
                if is_cancelled and is_cancelled():
                    cancelled = True
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    process.wait(timeout=min(remaining, 0.1))
                except subprocess.TimeoutExpired:
                    pass
        finally:
            try:
                if process.poll() is None or cancelled or timed_out:
                    BackgroundCommandRunner._terminate(process, job)
                    try:
                        process.wait(timeout=STOP_GRACE_SECONDS)
                    except subprocess.TimeoutExpired:
                        pass
                    # Also kill descendants when the direct process has already exited.
                    BackgroundCommandRunner._force_terminate(process, job)
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
                elif os.name != "nt":
                    # Foreground test commands must not leave daemonised children in their process group.
                    BackgroundCommandRunner._terminate(process)
                    time.sleep(0.1)
                    BackgroundCommandRunner._force_terminate(process)
            finally:
                if job:
                    job.close()
        if cancelled:
            exit_code = 130
        elif timed_out:
            exit_code = 124
        else:
            exit_code = process.returncode if process.returncode is not None else 127
        def tail(file) -> str:
            file.seek(0, os.SEEK_END)
            size = file.tell()
            file.seek(max(0, size - 20_000))
            return file.read().decode("utf-8", errors="replace")

        stderr = tail(stderr_file)
        if timed_out and not stderr:
            stderr = "test command timed out"
        if cancelled and not stderr:
            stderr = "test command cancelled"
        return {"exit_code": exit_code, "stdout": tail(stdout_file), "stderr": stderr,
                "timed_out": timed_out, "cancelled": cancelled}


class BackgroundCommandRunner:
    """Run explicit user commands without a shell, scoped to a project's Git root."""

    def __init__(self, store: MissionStore):
        self.store = store
        self._processes: dict[str, subprocess.Popen] = {}
        self._jobs: dict[str, WindowsProcessJob] = {}
        self._collectors: dict[str, threading.Thread] = {}
        self._stop_requested: set[str] = set()
        self._force_deadlines: dict[str, float] = {}
        self._lock = threading.RLock()
        self._closed = False
        self.store.recover_background_runs()

    @staticmethod
    def parse(command_line: str, additional_executables: tuple[str, ...] | list[str] = ()) -> list[str]:
        if not command_line or len(command_line) > 4000:
            raise ValueError("command_must_be_1_to_4000_characters")
        try:
            argv = shlex.split(command_line, posix=os.name != "nt")
        except ValueError as error:
            raise ValueError("command_has_invalid_quoting") from error
        allowed = ALLOWED_EXECUTABLES.union(additional_executables)
        if not argv or argv[0] not in allowed or len(argv) > 32:
            raise ValueError("command_must_use_an_allowed_executable_and_at_most_31_arguments")
        if any(not arg or len(arg) > 1000 or "\x00" in arg for arg in argv):
            raise ValueError("command_argument_is_invalid")
        return argv

    def start(self, mission_id: str, argv: list[str], *, jupyter_environment: str = "",
              notebook_setup_environment: str = "", notebook_setup_manager: str = "") -> dict:
        with self._lock:
            if self._closed:
                raise RuntimeError("command_runner_closed")
        mission = self.store.mission(mission_id)
        if not mission:
            raise ValueError("mission_not_found")
        if mission["status"] == "completed":
            raise ValueError("mission_completed")
        allowed = ALLOWED_EXECUTABLES.union(
            self.store.project_command_tools(mission["project_id"])
        )
        if not argv or argv[0] not in allowed or len(argv) > 32:
            raise ValueError("command_must_use_a_project_approved_executable_and_at_most_31_arguments")
        root = self.store.project_repository(mission_id)
        if jupyter_environment and (argv[0] != "jupyter" or jupyter_environment not in {".venv", "venv"}):
            raise ValueError("jupyter_environment_invalid")
        if notebook_setup_environment or notebook_setup_manager:
            expected_commands = {
                "uv": ["uv", "add", "--dev", "jupyter"],
                "pipenv": ["pipenv", "install", "--dev", "jupyter"],
                "poetry": ["poetry", "add", "--group", "dev", "jupyter"],
            }
            valid_setup_environment = (
                notebook_setup_environment == ".venv"
                and notebook_setup_manager in {"uv", "pipenv", "poetry"}
            )
            if not valid_setup_environment or argv != expected_commands.get(notebook_setup_manager):
                raise ValueError("notebook_setup_environment_invalid")
            project_root = Path(root)
            local_environment = project_root / ".venv"
            if local_environment.is_symlink():
                try:
                    resolved_venv = local_environment.resolve(strict=True)
                except OSError as error:
                    raise ValueError("notebook_setup_environment_invalid") from error
                if not resolved_venv.is_relative_to(project_root.resolve()) or not resolved_venv.is_dir():
                    raise ValueError("notebook_setup_environment_invalid")
            elif local_environment.exists() and not local_environment.is_dir():
                raise ValueError("notebook_setup_environment_invalid")
            project_manifests = {
                "uv": (project_root / "pyproject.toml").is_file() and (project_root / "uv.lock").is_file(),
                "pipenv": (project_root / "Pipfile").is_file() and (project_root / "Pipfile.lock").is_file(),
                "poetry": (project_root / "pyproject.toml").is_file() and (project_root / "poetry.lock").is_file(),
            }
            if not project_manifests.get(notebook_setup_manager) or not shutil.which(notebook_setup_manager):
                raise ValueError("notebook_setup_manager_unavailable")
        executable = self._resolve_executable(argv[0], root, jupyter_environment or None)
        if not executable:
            raise ValueError(f"executable_not_found:{argv[0]}")
        launch_argv = build_launch_argv([executable, *argv[1:]], executable)
        process_environment = None
        if notebook_setup_environment:
            process_environment = os.environ.copy()
            if notebook_setup_manager == "uv":
                process_environment["UV_PROJECT_ENVIRONMENT"] = str(root / notebook_setup_environment)
            elif notebook_setup_manager == "pipenv":
                process_environment["PIPENV_VENV_IN_PROJECT"] = "1"
            elif notebook_setup_manager == "poetry":
                process_environment["POETRY_VIRTUALENVS_IN_PROJECT"] = "1"
        try:
            process = subprocess.Popen(
                launch_argv, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                bufsize=1, shell=False, env=process_environment, start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            )
        except OSError as error:
            raise ValueError(f"command_could_not_start:{error.strerror or 'process launch failed'}") from error
        job = self._create_process_job(process)
        try:
            run = self.store.create_background_run(mission_id, argv, str(root), process.pid)
        except Exception:
            self._terminate(process, job)
            try:
                process.wait(timeout=STOP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                self._force_terminate(process, job)
                process.wait(timeout=2)
            if job:
                job.close()
            raise
        with self._lock:
            if self._closed:
                self._terminate(process, job)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self._force_terminate(process, job)
                    process.wait(timeout=2)
                if job:
                    job.close()
                self.store.finish_background_run(run["id"], "cancelled", process.returncode)
                raise RuntimeError("command_runner_closed")
            self._processes[run["id"]] = process
            if job:
                self._jobs[run["id"]] = job
            collector = threading.Thread(
                target=self._collect, args=(run["id"], process, job), daemon=True,
                name=f"tribe-command-{uuid.uuid4().hex[:8]}",
            )
            self._collectors[run["id"]] = collector
            collector.start()
        return run

    @staticmethod
    def _resolve_executable(name: str, root: Path, jupyter_environment: str | None = None) -> str | None:
        """Resolve Jupyter only from a locked, project-local Python environment."""
        if name == "jupyter":
            python_lockfiles = ("uv.lock", "poetry.lock", "Pipfile.lock")
            if not any((root / lockfile).is_file() for lockfile in python_lockfiles):
                return None
            names = [jupyter_environment] if jupyter_environment else [".venv", "venv"]
            project_root = root.resolve()
            for environment in names:
                if environment not in {".venv", "venv"}:
                    continue
                base = root / environment
                executable = "jupyter.exe" if os.name == "nt" else "jupyter"
                scripts = [base / ("Scripts" if os.name == "nt" else "bin") / executable]
                for candidate in scripts:
                    located = shutil.which(str(candidate))
                    if not located:
                        continue
                    try:
                        resolved = Path(located).resolve(strict=True)
                    except OSError:
                        continue
                    if resolved.is_relative_to(project_root) and resolved.is_file():
                        return str(candidate)
            return None
        return shutil.which(name)

    @staticmethod
    def notebook_environments(root: Path) -> list[dict[str, object]]:
        """Describe recognised local notebook environments without exposing filesystem paths."""
        python_lockfiles = ("uv.lock", "poetry.lock", "Pipfile.lock")
        lockfile = next((name for name in python_lockfiles if (root / name).is_file()), "")
        locked = bool(lockfile)
        if os.name == "nt":
            scripts = {".venv": root / ".venv" / "Scripts" / "jupyter.exe",
                       "venv": root / "venv" / "Scripts" / "jupyter.exe"}
        else:
            scripts = {".venv": root / ".venv" / "bin" / "jupyter",
                       "venv": root / "venv" / "bin" / "jupyter"}
        environments = [{
            "id": name,
            "label": name,
            "locked": locked,
            "lockfile": lockfile or None,
            "uvSetupAvailable": bool(
                lockfile == "uv.lock" and (root / "pyproject.toml").is_file() and shutil.which("uv")
            ),
            "pipenvSetupAvailable": bool(
                name == ".venv" and lockfile == "Pipfile.lock" and (root / "Pipfile").is_file()
                and shutil.which("pipenv")
            ),
            "poetrySetupAvailable": bool(
                name == ".venv" and lockfile == "poetry.lock" and (root / "pyproject.toml").is_file()
                and shutil.which("poetry")
            ),
            "jupyterAvailable": bool(locked and shutil.which(str(script))),
        } for name, script in scripts.items()]
        return environments

    def list(self, mission_id: str) -> list[dict]:
        return self.store.background_runs(mission_id)

    def stop(self, run_id: str) -> dict | None:
        with self._lock:
            process = self._processes.get(run_id)
            if process:
                self._stop_requested.add(run_id)
                self._force_deadlines[run_id] = time.monotonic() + STOP_GRACE_SECONDS
                self._terminate(process, self._jobs.get(run_id))
        return self.store.background_run(run_id)

    def _collect(
        self, run_id: str, process: subprocess.Popen, job: WindowsProcessJob | None
    ) -> None:
        chunks: queue.Queue[str | None] = queue.Queue()

        def read_output() -> None:
            try:
                assert process.stdout is not None
                with process.stdout:
                    for line in process.stdout:
                        chunks.put(line)
            finally:
                chunks.put(None)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()
        pending: list[str] = []
        pending_length = 0
        closed = False
        descendants_stopped = False
        while not closed or process.poll() is None:
            if job and process.poll() is not None and not closed and not descendants_stopped:
                # A command's process tree is scoped to its run. Do not leave
                # detached children alive after the root command exits.
                self._force_terminate(process, job)
                descendants_stopped = True
            with self._lock:
                force_deadline = self._force_deadlines.get(run_id)
            command_tree_active = process.poll() is None or not closed
            if (force_deadline is not None and time.monotonic() >= force_deadline
                    and command_tree_active):
                self._force_terminate(process, job)
                with self._lock:
                    self._force_deadlines.pop(run_id, None)
            try:
                line = chunks.get(timeout=0.5)
                if line is None:
                    closed = True
                else:
                    pending.append(line)
                    pending_length += len(line)
            except queue.Empty:
                if pending:
                    self.store.update_background_output(run_id, "".join(pending))
                    pending, pending_length = [], 0
            if pending_length >= 4096 or (pending and closed):
                self.store.update_background_output(run_id, "".join(pending))
                pending, pending_length = [], 0
        if pending:
            self.store.update_background_output(run_id, "".join(pending))
        exit_code = process.wait()
        with self._lock:
            cancelled = run_id in self._stop_requested
            self._stop_requested.discard(run_id)
            self._force_deadlines.pop(run_id, None)
        status = "cancelled" if cancelled else "completed" if exit_code == 0 else "failed"
        self.store.finish_background_run(run_id, status, exit_code)
        if job:
            job.close()
        with self._lock:
            self._processes.pop(run_id, None)
            self._jobs.pop(run_id, None)
            self._collectors.pop(run_id, None)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            active = list(self._processes.items())
            jobs = dict(self._jobs)
            collectors = list(self._collectors.values())
            self._stop_requested.update(run_id for run_id, _ in active)
            self._force_deadlines.update({
                run_id: time.monotonic() + STOP_GRACE_SECONDS for run_id, _ in active
            })
        for run_id, process in active:
            if process.poll() is None:
                self._terminate(process, jobs.get(run_id))
        deadline = time.monotonic() + STOP_GRACE_SECONDS
        for run_id, process in active:
            remaining = max(0.0, deadline - time.monotonic())
            if process.poll() is None:
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    pass
            with self._lock:
                collector = self._collectors.get(run_id)
            if process.poll() is None or (collector and collector.is_alive()):
                self._force_terminate(process, jobs.get(run_id))
            if process.poll() is None:
                process.wait(timeout=2)
        for collector in collectors:
            if collector is not threading.current_thread():
                collector.join(timeout=5)
        for job in jobs.values():
            job.close()
        for run_id, process in active:
            self.store.finish_background_run(run_id, "cancelled", process.returncode)

    @staticmethod
    def _create_process_job(process: subprocess.Popen) -> WindowsProcessJob | None:
        if os.name != "nt":
            return None
        try:
            return WindowsProcessJob(process.pid)
        except Exception:
            # Keep the command under runner supervision when native assignment is
            # unavailable, including hosts that reject nested Job Objects.
            return None

    @staticmethod
    def _terminate(process: subprocess.Popen, job: WindowsProcessJob | None = None) -> None:
        if os.name == "nt":
            if process.poll() is None:
                try:
                    process.send_signal(getattr(signal, "CTRL_BREAK_EVENT"))
                    return
                except (OSError, ValueError):
                    pass
            if job and job.terminate():
                return
            try:
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T"],
                               capture_output=True, check=False, timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass  # The collector escalates to a forced process-tree stop.
        else:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    @staticmethod
    def _force_terminate(process: subprocess.Popen, job: WindowsProcessJob | None = None) -> None:
        if os.name == "nt":
            if job and job.terminate():
                return
            try:
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, check=False, timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

