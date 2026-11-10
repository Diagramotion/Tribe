from __future__ import annotations

import json
import io
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from shutil import which
from urllib.request import Request, urlopen
from unittest.mock import Mock, patch

from tribe_runtime.commands import BackgroundCommandRunner, build_launch_argv, run_foreground_process
from tribe_runtime.store import MissionStore
from tribe_runtime.windows_job import WindowsProcessJob


class BackgroundCommandLaunchTests(unittest.TestCase):
    def test_foreground_command_stops_when_agent_run_is_cancelled(self) -> None:
        cancelled = threading.Event()
        timer = threading.Timer(0.25, cancelled.set)
        timer.start()
        started = time.monotonic()
        try:
            result = run_foreground_process(
                [sys.executable, "-c", "import time; print('started', flush=True); time.sleep(30)"],
                cwd=Path.cwd(), timeout=10, is_cancelled=cancelled.is_set,
            )
        finally:
            timer.cancel()

        self.assertTrue(result["cancelled"])
        self.assertFalse(result["timed_out"])
        self.assertEqual(result["exit_code"], 130)
        self.assertIn("started", result["stdout"])
        self.assertLess(time.monotonic() - started, 5)

    def test_foreground_command_terminates_after_its_timeout(self) -> None:
        started = time.monotonic()
        result = run_foreground_process(
            [sys.executable, "-c", "import time; print('started', flush=True); time.sleep(30)"],
            cwd=Path.cwd(), timeout=0.25,
        )

        self.assertFalse(result["cancelled"])
        self.assertTrue(result["timed_out"])
        self.assertEqual(result["exit_code"], 124)
        self.assertIn("started", result["stdout"])
        self.assertLess(time.monotonic() - started, 5)

    def test_foreground_cancellation_terminates_descendants(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-test-tree-") as directory:
            root = Path(directory)
            child_started = root / "child.pid"
            child_marker = root / "child-survived"
            child_code = (
                "import pathlib,time; time.sleep(1); "
                f"pathlib.Path({str(child_marker)!r}).write_text('survived')"
            )
            parent_code = (
                "import pathlib,subprocess,sys,time; time.sleep(.2); "
                f"child=subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
                f"pathlib.Path({str(child_started)!r}).write_text(str(child.pid)); "
                "time.sleep(30)"
            )
            result = run_foreground_process(
                [sys.executable, "-c", parent_code], cwd=root, timeout=10,
                is_cancelled=child_started.exists,
            )
            time.sleep(1.1)

            self.assertTrue(result["cancelled"])
            self.assertFalse(child_marker.exists())

    def test_windows_batch_launch_quotes_executable_and_arguments(self) -> None:
        executable = r"C:\Program Files\Node.js\npm.cmd"
        argv = ["npm", "run", "build"]

        launch = build_launch_argv(
            argv, executable, windows=True, comspec=r"C:\Windows\System32\cmd.exe"
        )

        self.assertEqual(launch[:4], [r"C:\Windows\System32\cmd.exe", "/d", "/s", "/c"])
        self.assertEqual(launch[4], subprocess.list2cmdline([executable, "run", "build"]))
        self.assertEqual(argv, ["npm", "run", "build"])

    def test_windows_batch_launch_rejects_shell_control_arguments(self) -> None:
        for argument in ("x&y", "x|y", "x>y", "x%PATH%", "x!PATH!", "x^y", "x(y", "x\ny"):
            with self.subTest(argument=argument):
                with self.assertRaisesRegex(ValueError, "shell control characters"):
                    build_launch_argv(["npm", argument], "npm.cmd", windows=True)

    def test_windows_native_executable_bypasses_command_shell(self) -> None:
        argv = ["git", "status", "--short"]
        self.assertIs(build_launch_argv(argv, r"C:\Program Files\Git\git.exe", windows=True), argv)

    def test_command_parser_rejects_shell_syntax(self) -> None:
        self.assertEqual(BackgroundCommandRunner.parse("pytest -q tests"), ["pytest", "-q", "tests"])
        self.assertEqual(BackgroundCommandRunner.parse("uv run pytest -q"), ["uv", "run", "pytest", "-q"])
        self.assertEqual(BackgroundCommandRunner.parse("bun run test"), ["bun", "run", "test"])
        self.assertEqual(BackgroundCommandRunner.parse("make check"), ["make", "check"])
        with self.assertRaisesRegex(ValueError, "allowed_executable"):
            BackgroundCommandRunner.parse("echo unsafe")

    def test_jupyter_is_an_allowed_command_and_prefers_project_environment(self) -> None:
        self.assertEqual(
            BackgroundCommandRunner.parse("jupyter nbconvert --to notebook"),
            ["jupyter", "nbconvert", "--to", "notebook"],
        )
        with tempfile.TemporaryDirectory(prefix="tribe-jupyter-env-") as directory:
            root = Path(directory)
            scripts = "Scripts" if os.name == "nt" else "bin"
            executable = "jupyter.exe" if os.name == "nt" else "jupyter"
            local = root / ".venv" / scripts / executable
            local.parent.mkdir(parents=True)
            local.write_bytes(b"test executable")
            if os.name != "nt":
                local.chmod(0o755)
            (root / "uv.lock").write_text("version = 1\n", encoding="utf-8")
            fallback = r"C:\\Python\\Scripts\\jupyter.exe" if os.name == "nt" else "/usr/bin/jupyter"
            with patch(
                "tribe_runtime.commands.shutil.which",
                side_effect=lambda name: name if name == str(local) else fallback,
            ):
                self.assertEqual(BackgroundCommandRunner._resolve_executable("jupyter", root), str(local))
            (root / "uv.lock").unlink()
            with patch("tribe_runtime.commands.shutil.which", return_value=fallback):
                self.assertIsNone(BackgroundCommandRunner._resolve_executable("jupyter", root))

    def test_jupyter_can_use_a_selected_locked_project_environment(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-jupyter-select-") as directory:
            root = Path(directory)
            script_dir = "Scripts" if os.name == "nt" else "bin"
            executable = "jupyter.exe" if os.name == "nt" else "jupyter"
            local = root / ".venv" / script_dir / executable
            alternate = root / "venv" / script_dir / executable
            for script in (local, alternate):
                script.parent.mkdir(parents=True, exist_ok=True)
                script.write_bytes(b"test executable")
                if os.name != "nt":
                    script.chmod(0o755)
            (root / "uv.lock").write_text("version = 1\n", encoding="utf-8")
            (root / "pyproject.toml").write_text("[project]\nname = 'sample'\nversion = '0.1.0'\n", encoding="utf-8")

            def find_executable(name: str) -> str | None:
                if name in {str(local), str(alternate)}:
                    return name
                return "/usr/local/bin/uv" if name == "uv" else None

            with patch("tribe_runtime.commands.shutil.which", side_effect=find_executable):
                self.assertEqual(BackgroundCommandRunner._resolve_executable("jupyter", root, "venv"), str(alternate))
                self.assertEqual(BackgroundCommandRunner._resolve_executable("jupyter", root, ".venv"), str(local))
                self.assertEqual(BackgroundCommandRunner.notebook_environments(root), [
                    {"id": ".venv", "label": ".venv", "locked": True, "lockfile": "uv.lock", "uvSetupAvailable": True, "pipenvSetupAvailable": False, "poetrySetupAvailable": False, "jupyterAvailable": True},
                    {"id": "venv", "label": "venv", "locked": True, "lockfile": "uv.lock", "uvSetupAvailable": True, "pipenvSetupAvailable": False, "poetrySetupAvailable": False, "jupyterAvailable": True},
                ])
                self.assertIsNone(BackgroundCommandRunner._resolve_executable("jupyter", root, "elsewhere"))

    def test_uv_notebook_setup_is_confined_to_the_project_venv(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-jupyter-setup-") as directory:
            root = Path(directory)
            (root / "pyproject.toml").write_text("[project]\nname='sample'\n", encoding="utf-8")
            (root / "uv.lock").write_text("version = 1\n", encoding="utf-8")
            store = Mock()
            store.mission.return_value = {"id": "mission-1", "project_id": "project-1", "status": "active"}
            store.project_repository.return_value = root
            store.project_command_tools.return_value = []
            store.create_background_run.return_value = {"id": "run-1"}
            process = Mock(pid=4321, stdout=io.StringIO(""), returncode=0)
            process.poll.return_value = 0
            runner = BackgroundCommandRunner(store)
            with patch.object(runner, "_create_process_job", return_value=None), \
                    patch("tribe_runtime.commands.shutil.which", return_value="/usr/local/bin/uv"), \
                    patch("tribe_runtime.commands.subprocess.Popen", return_value=process) as popen:
                runner.start("mission-1", ["uv", "add", "--dev", "jupyter"], notebook_setup_environment=".venv", notebook_setup_manager="uv")

            self.assertEqual(popen.call_args.kwargs["cwd"], root)
            self.assertEqual(popen.call_args.kwargs["env"]["UV_PROJECT_ENVIRONMENT"], str(root / ".venv"))
            with self.assertRaisesRegex(ValueError, "notebook_setup_environment_invalid"):
                runner.start("mission-1", ["uv", "add", "--dev", "jupyter"], notebook_setup_environment="venv", notebook_setup_manager="uv")

    def test_pipenv_environment_detects_project_local_setup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-pipenv-detect-") as directory:
            root = Path(directory)
            (root / "Pipfile").write_text("[packages]\n", encoding="utf-8")
            (root / "Pipfile.lock").write_text("{}\n", encoding="utf-8")
            with patch("tribe_runtime.commands.shutil.which", side_effect=lambda name: "/usr/bin/pipenv" if name == "pipenv" else None):
                environments = BackgroundCommandRunner.notebook_environments(root)
            self.assertTrue(environments[0]["pipenvSetupAvailable"])
            self.assertFalse(environments[1]["pipenvSetupAvailable"])

    def test_pipenv_notebook_setup_is_confined_to_the_project_venv(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-jupyter-pipenv-") as directory:
            root = Path(directory)
            (root / "Pipfile").write_text("[packages]\n", encoding="utf-8")
            (root / "Pipfile.lock").write_text("{}\n", encoding="utf-8")
            store = Mock()
            store.mission.return_value = {"id": "mission-1", "project_id": "project-1", "status": "active"}
            store.project_repository.return_value = root
            store.project_command_tools.return_value = []
            store.create_background_run.return_value = {"id": "run-1"}
            process = Mock(pid=4321, stdout=io.StringIO(""), returncode=0)
            process.poll.return_value = 0
            runner = BackgroundCommandRunner(store)
            with patch.object(runner, "_create_process_job", return_value=None), \
                    patch("tribe_runtime.commands.shutil.which", return_value="/usr/local/bin/pipenv"), \
                    patch("tribe_runtime.commands.subprocess.Popen", return_value=process) as popen:
                runner.start("mission-1", ["pipenv", "install", "--dev", "jupyter"],
                             notebook_setup_environment=".venv", notebook_setup_manager="pipenv")

            self.assertEqual(popen.call_args.kwargs["cwd"], root)
            self.assertEqual(popen.call_args.kwargs["env"]["PIPENV_VENV_IN_PROJECT"], "1")
            with self.assertRaisesRegex(ValueError, "notebook_setup_environment_invalid"):
                runner.start("mission-1", ["pipenv", "install", "--dev", "jupyter"],
                             notebook_setup_environment="venv", notebook_setup_manager="pipenv")

    def test_poetry_environment_detects_project_local_setup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-jupyter-poetry-detect-") as directory:
            root = Path(directory)
            (root / "pyproject.toml").write_text("[tool.poetry]\nname='sample'\n", encoding="utf-8")
            (root / "poetry.lock").write_text("package = []\n", encoding="utf-8")
            with patch("tribe_runtime.commands.shutil.which", side_effect=lambda name: "/usr/bin/poetry" if name == "poetry" else None):
                environments = BackgroundCommandRunner.notebook_environments(root)
            self.assertTrue(environments[0]["poetrySetupAvailable"])
            self.assertFalse(environments[1]["poetrySetupAvailable"])

    def test_poetry_notebook_setup_is_confined_to_the_project_venv(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-jupyter-poetry-setup-") as directory:
            root = Path(directory)
            (root / "pyproject.toml").write_text("[tool.poetry]\nname='sample'\n", encoding="utf-8")
            (root / "poetry.lock").write_text("package = []\n", encoding="utf-8")
            store = Mock()
            store.mission.return_value = {"id": "mission-1", "project_id": "project-1", "status": "active"}
            store.project_repository.return_value = root
            store.project_command_tools.return_value = []
            store.create_background_run.return_value = {"id": "run-1"}
            process = Mock(pid=4321, stdout=io.StringIO(""), returncode=0)
            process.poll.return_value = 0
            runner = BackgroundCommandRunner(store)
            with patch.object(runner, "_create_process_job", return_value=None), patch(
                "tribe_runtime.commands.shutil.which", return_value="/usr/local/bin/poetry"
            ), patch("tribe_runtime.commands.subprocess.Popen", return_value=process) as popen:
                runner.start("mission-1", ["poetry", "add", "--group", "dev", "jupyter"],
                             notebook_setup_environment=".venv", notebook_setup_manager="poetry")

            self.assertEqual(popen.call_args.kwargs["cwd"], root)
            self.assertEqual(popen.call_args.kwargs["env"]["POETRY_VIRTUALENVS_IN_PROJECT"], "1")
            with self.assertRaisesRegex(ValueError, "notebook_setup_environment_invalid"):
                runner.start("mission-1", ["poetry", "add", "--group", "dev", "jupyter"],
                             notebook_setup_environment="venv", notebook_setup_manager="poetry")

    def test_notebook_execution_ignores_pixi_and_conda_environments(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-jupyter-unsupported-envs-") as directory:
            root = Path(directory)
            (root / "pixi.toml").write_text("[workspace]\nname=sample\n", encoding="utf-8")
            (root / "pixi.lock").write_text("version: 6\n", encoding="utf-8")
            (root / "conda-lock.yml").write_text("version: 1\n", encoding="utf-8")

            environments = BackgroundCommandRunner.notebook_environments(root)

            self.assertEqual([item["id"] for item in environments], [".venv", "venv"])
            self.assertTrue(all(not item["locked"] for item in environments))
            self.assertIsNone(BackgroundCommandRunner._resolve_executable("jupyter", root, "pixi:default"))
            self.assertIsNone(BackgroundCommandRunner._resolve_executable("jupyter", root, "conda:project"))

    def test_notebook_setup_rejects_a_venv_symlink_outside_the_project(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-jupyter-symlink-") as directory:
            root = Path(directory)
            project = root / "repo"
            project.mkdir()
            external_environment = root / "external"
            external_environment.mkdir()
            (project / ".venv").symlink_to(external_environment, target_is_directory=True)
            (project / "Pipfile").write_text("[packages]\n", encoding="utf-8")
            (project / "Pipfile.lock").write_text("{}\n", encoding="utf-8")
            store = Mock()
            store.mission.return_value = {"id": "mission-1", "project_id": "project-1", "status": "active"}
            store.project_repository.return_value = project
            store.project_command_tools.return_value = []
            runner = BackgroundCommandRunner(store)
            with patch("tribe_runtime.commands.shutil.which", return_value="/usr/local/bin/pipenv"):
                with self.assertRaisesRegex(ValueError, "notebook_setup_environment_invalid"):
                    runner.start("mission-1", ["pipenv", "install", "--dev", "jupyter"],
                                 notebook_setup_environment=".venv", notebook_setup_manager="pipenv")

    def test_project_approved_executable_can_be_parsed(self) -> None:
        self.assertEqual(
            BackgroundCommandRunner.parse("terraform plan", ["terraform"]),
            ["terraform", "plan"],
        )

    def test_windows_stop_uses_a_graceful_process_group_signal_first(self) -> None:
        process = Mock(pid=1234)
        process.poll.return_value = None
        with patch("tribe_runtime.commands.os.name", "nt"), \
             patch("tribe_runtime.commands.signal.CTRL_BREAK_EVENT", 1, create=True), \
             patch("tribe_runtime.commands.subprocess.run") as run:
            BackgroundCommandRunner._terminate(process)

        process.send_signal.assert_called_once_with(1)
        run.assert_not_called()

    def test_windows_stop_falls_back_to_non_forced_tree_termination(self) -> None:
        process = Mock(pid=1234)
        process.poll.return_value = None
        process.send_signal.side_effect = OSError("no console attached")
        with patch("tribe_runtime.commands.os.name", "nt"), \
             patch("tribe_runtime.commands.signal.CTRL_BREAK_EVENT", 1, create=True), \
             patch("tribe_runtime.commands.subprocess.run") as run:
            BackgroundCommandRunner._terminate(process)

        self.assertEqual(run.call_args.args[0], ["taskkill", "/PID", "1234", "/T"])
        self.assertNotIn("/F", run.call_args.args[0])

    def test_windows_stop_still_terminates_descendants_after_root_exits(self) -> None:
        process = Mock(pid=1234)
        process.poll.return_value = 0
        job = Mock()
        job.terminate.return_value = True
        with patch("tribe_runtime.commands.os.name", "nt"), \
             patch("tribe_runtime.commands.subprocess.run") as run:
            BackgroundCommandRunner._terminate(process, job)

        job.terminate.assert_called_once_with()
        run.assert_not_called()

    def test_windows_force_stop_terminates_the_full_process_tree(self) -> None:
        process = Mock(pid=1234)
        with patch("tribe_runtime.commands.os.name", "nt"), \
             patch("tribe_runtime.commands.subprocess.run") as run:
            BackgroundCommandRunner._force_terminate(process)

        self.assertEqual(run.call_args.args[0], ["taskkill", "/PID", "1234", "/T", "/F"])

    def test_windows_force_stop_prefers_the_job_object(self) -> None:
        process = Mock(pid=1234)
        job = Mock()
        job.terminate.return_value = True
        with patch("tribe_runtime.commands.os.name", "nt"), \
             patch("tribe_runtime.commands.subprocess.run") as run:
            BackgroundCommandRunner._force_terminate(process, job)

        job.terminate.assert_called_once_with()
        run.assert_not_called()

    def test_windows_job_assignment_failure_keeps_legacy_supervision(self) -> None:
        process = Mock(pid=1234)
        with patch("tribe_runtime.commands.os.name", "nt"), \
             patch("tribe_runtime.commands.WindowsProcessJob", side_effect=RuntimeError("unsupported")):
            job = BackgroundCommandRunner._create_process_job(process)

        self.assertIsNone(job)


@unittest.skipUnless(os.name == "nt", "Windows Job Objects are Windows-only")
class WindowsJobObjectTests(unittest.TestCase):
    def test_job_termination_stops_the_root_and_its_descendants(self) -> None:
        child_code = "import time; time.sleep(60)"
        parent_code = (
            "import subprocess,sys,time; input(); "
            f"child=subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
            "print(child.pid, flush=True); time.sleep(60)"
        )
        process = subprocess.Popen(
            [sys.executable, "-c", parent_code],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True,
        )
        job = None
        child_handle = None
        kernel32 = None
        try:
            job = WindowsProcessJob(process.pid)
            assert process.stdin is not None
            process.stdin.write("start\n")
            process.stdin.flush()
            process.stdin.close()
            assert process.stdout is not None
            child_pid = int(process.stdout.readline().strip())
            job.terminate()
            process.wait(timeout=5)

            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel32.WaitForSingleObject.restype = wintypes.DWORD
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            child_handle = kernel32.OpenProcess(0x00100000, False, child_pid)
            if child_handle:
                self.assertEqual(kernel32.WaitForSingleObject(child_handle, 5000), 0)
            else:
                self.assertEqual(ctypes.get_last_error(), 87)
        finally:
            if job:
                job.close()
            if child_handle and kernel32:
                kernel32.CloseHandle(child_handle)
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


class BackgroundCommandShutdownTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="tribe-command-shutdown-")
        self.root = Path(self.temp.name)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.repository)], check=True)
        self.store = MissionStore(self.root / "data" / "tribe.sqlite3")
        _, self.mission = self.store.create_project(
            str(self.repository), "Shutdown test", "Long command", "Verify shutdown cleanup"
        )
        self.runner = BackgroundCommandRunner(self.store)

    def tearDown(self) -> None:
        self.runner.close()
        self.temp.cleanup()

    def test_close_terminates_and_persists_active_command(self) -> None:
        executable = "python" if which("python") else "python3"
        run = self.runner.start(
            self.mission["id"],
            [executable, "-c", "import time; print('started', flush=True); time.sleep(60)"],
        )
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            current = self.store.background_run(run["id"])
            if current and "started" in current["output"]:
                break
            time.sleep(0.05)

        self.runner.close()

        completed = self.store.background_run(run["id"])
        self.assertEqual(completed["status"], "cancelled")
        self.assertIsNotNone(completed["exit_code"])
        self.assertIn("started", completed["output"])

    def test_runner_launches_an_executable_approved_for_its_project(self) -> None:
        python_executable = which("python") or which("python3")
        self.assertIsNotNone(python_executable)
        tool_name = "tribe-test-python"
        self.store.set_project_command_tools(self.mission["project_id"], [tool_name])
        with patch(
            "tribe_runtime.commands.shutil.which",
            side_effect=lambda name: python_executable if name == tool_name else which(name),
        ):
            run = self.runner.start(self.mission["id"], [tool_name, "--version"])
        self.assertEqual(run["argv"], [tool_name, "--version"])
        deadline = time.monotonic() + 3
        saved = self.store.background_run(run["id"])
        while saved and saved["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.02)
            saved = self.store.background_run(run["id"])
        self.assertIsNotNone(saved)
        self.assertEqual(saved["status"], "completed")

    @unittest.skipIf(os.name == "nt", "The command ignores POSIX SIGTERM specifically")
    def test_stop_escalates_when_command_ignores_graceful_termination(self) -> None:
        executable = "python" if which("python") else "python3"
        code = (
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "print('ready', flush=True); time.sleep(60)"
        )
        run = self.runner.start(self.mission["id"], [executable, "-c", code])
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            current = self.store.background_run(run["id"])
            if current and "ready" in current["output"]:
                break
            time.sleep(0.05)
        else:
            self.fail("background process did not report it was ready")

        with patch("tribe_runtime.commands.STOP_GRACE_SECONDS", 0.2):
            self.runner.stop(run["id"])
        deadline = time.monotonic() + 5
        current = self.store.background_run(run["id"])
        while current and current["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
            current = self.store.background_run(run["id"])

        self.assertIsNotNone(current)
        self.assertEqual(current["status"], "cancelled")
        self.assertIsNotNone(current["exit_code"])

    @unittest.skipIf(os.name == "nt", "This reproduces POSIX process-group inheritance")
    def test_stop_escalates_after_parent_exits_with_child_holding_output_open(self) -> None:
        executable = "python" if which("python") else "python3"
        child_code = (
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "print('child-ready', flush=True); time.sleep(60)"
        )
        parent_code = (
            "import signal,subprocess,sys,time; "
            f"child=subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
            "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); "
            "print(f'child-pid:{child.pid}', flush=True); time.sleep(60)"
        )
        run = self.runner.start(self.mission["id"], [executable, "-c", parent_code])
        child_pid = None
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                current = self.store.background_run(run["id"])
                output = current["output"] if current else ""
                if "child-ready" in output and "child-pid:" in output:
                    child_pid = int(next(
                        line.split(":", 1)[1] for line in output.splitlines()
                        if line.startswith("child-pid:")
                    ))
                    break
                time.sleep(0.05)
            self.assertIsNotNone(child_pid, "child process did not start")

            with patch("tribe_runtime.commands.STOP_GRACE_SECONDS", 0.2):
                self.runner.stop(run["id"])
            deadline = time.monotonic() + 5
            current = self.store.background_run(run["id"])
            while current and current["status"] == "running" and time.monotonic() < deadline:
                time.sleep(0.05)
                current = self.store.background_run(run["id"])

            self.assertIsNotNone(current)
            self.assertEqual(current["status"], "cancelled")
        finally:
            if child_pid is not None:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


class RuntimeShutdownTests(unittest.TestCase):
    def test_shutdown_endpoint_stops_background_command_before_runtime_exit(self) -> None:
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="tribe-runtime-shutdown-") as temporary:
            data_dir = Path(temporary) / "data"
            repository = Path(temporary) / "repository"
            data_dir.mkdir()
            repository.mkdir()
            subprocess.run(["git", "init", "--quiet", str(repository)], check=True)
            store = MissionStore(data_dir / "tribe.sqlite3")
            _, mission = store.create_project(
                str(repository), "Runtime shutdown", "Stop a command", "Stop commands on app exit"
            )
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            environment = {
                **os.environ,
                "TRIBE_DATA_DIR": str(data_dir),
                "TRIBE_PORT": str(port),
                "TRIBE_AGENT_DIR": str(root / "agents"),
                "PYTHONPATH": os.pathsep.join((str(root / "runtime"), os.environ.get("PYTHONPATH", ""))),
            }
            process = subprocess.Popen(
                [sys.executable, "-m", "tribe_runtime.server"], cwd=root,
                env=environment, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            base_url = f"http://127.0.0.1:{port}"
            try:
                deadline = time.monotonic() + 15
                while True:
                    if process.poll() is not None:
                        self.fail(f"runtime exited before becoming healthy: {process.returncode}")
                    try:
                        with urlopen(f"{base_url}/api/health", timeout=1) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        if time.monotonic() >= deadline:
                            self.fail("runtime did not become healthy")
                        time.sleep(0.05)

                command_body = json.dumps({
                    "missionId": mission["id"],
                    "command": f"{ 'python' if which('python') else 'python3' } -m http.server 0",
                }).encode()
                command_request = Request(
                    f"{base_url}/api/commands", data=command_body,
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urlopen(command_request, timeout=5) as response:
                    run = json.loads(response.read())["run"]
                self.assertEqual(run["status"], "running")

                shutdown_request = Request(
                    f"{base_url}/api/shutdown", data=b"",
                    headers={"Content-Type": "application/json", "Origin": "tauri://localhost"},
                    method="POST",
                )
                with urlopen(shutdown_request, timeout=5) as response:
                    self.assertEqual(response.status, 202)
                process.wait(timeout=15)
                self.assertEqual(store.background_run(run["id"])["status"], "cancelled")
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
