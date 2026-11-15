import unittest

from tribe_runtime.tool_activity import (
    background_test_run_evidence,
    browser_activity_labels,
    local_repository_test_argv,
    repository_test_command_argv,
    repository_test_run_evidence,
    summarize_tool_arguments,
)


class ToolActivityTests(unittest.TestCase):
    def test_navigation_summary_keeps_host_but_drops_credentials_path_query_and_fragment(self):
        summary = summarize_tool_arguments("playwright_browser_navigate", {
            "url": "https://person:secret@example.com/private/record?token=hidden#note",
        })

        self.assertEqual(summary, "example.com")
        self.assertNotIn("person", summary)
        self.assertNotIn("secret", summary)
        self.assertNotIn("private", summary)
        self.assertNotIn("token", summary)

    def test_browser_text_entry_is_summarised_without_persisting_entered_text(self):
        summary = summarize_tool_arguments("playwright_browser_type", {
            "text": "private@example.com and password=hunter2",
        })

        self.assertEqual(summary, "")

    def test_browser_actions_have_human_readable_phase_labels(self):
        self.assertEqual(browser_activity_labels("playwright_browser_navigate"), {
            "working": "opening a page",
            "finished": "opened a page",
        })
        self.assertEqual(browser_activity_labels("browser_resize"), {
            "working": "resizing the browser",
            "finished": "resized the browser",
        })
        self.assertEqual(browser_activity_labels("browser_select"), {
            "working": "choosing a page option",
            "finished": "chose a page option",
        })
        self.assertEqual(browser_activity_labels("browser_upload"), {
            "working": "asking to select files for a page",
            "finished": "selected files for a page",
        })
        self.assertEqual(browser_activity_labels("browser_site_storage"), {
            "working": "checking site storage",
            "finished": "checked site storage",
        })
        self.assertIsNone(browser_activity_labels("github_create_issue"))

    def test_non_browser_tool_summaries_keep_existing_file_path_and_command_behaviour(self):
        self.assertEqual(summarize_tool_arguments("write_file", {"path": "src/app.py"}), "src/app.py")
        self.assertEqual(summarize_tool_arguments("run_command", {"command": "echo token=abc"}),
                         "echo token=[redacted]")

    def test_repository_test_evidence_retains_argv_while_activity_summaries_redact_secrets(self):
        command = "pytest --api-token=private-value -q tests"
        evidence = repository_test_run_evidence(
            command, "2 passed in 0.03s\n[exit code: 0]",
        )
        summary = summarize_tool_arguments("run_command", {"command": command})

        self.assertEqual(evidence["exitCode"], 0)
        self.assertIn("private-value", " ".join(evidence["argv"]))
        self.assertNotIn("private-value", summary)
        self.assertIn("[redacted]", summary)

    def test_repository_test_evidence_preserves_conventional_timeout_and_interrupt_statuses(self):
        timed_out = repository_test_run_evidence("pytest -q tests", "[exit code: 124]")
        interrupted = repository_test_run_evidence("pytest -q tests", "[exit code: 130]")
        signal_interrupted = repository_test_run_evidence("pytest -q tests", "[exit code: -15]")
        node_interrupted = repository_test_run_evidence(
            "node --test test/example.test.js",
            "TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 1\n[exit code: 130]",
        )
        node_signal_interrupted = repository_test_run_evidence(
            "node --test test/example.test.js",
            "TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 1\n[exit code: -15]",
        )

        self.assertTrue(timed_out["timedOut"])
        self.assertFalse(timed_out["cancelled"])
        self.assertTrue(interrupted["cancelled"])
        self.assertFalse(interrupted["timedOut"])
        self.assertTrue(signal_interrupted["cancelled"])
        self.assertTrue(node_interrupted["cancelled"])
        self.assertTrue(node_signal_interrupted["cancelled"])

    def test_repository_test_evidence_excludes_shell_chains_escape_paths_and_incomplete_runs(self):
        self.assertIsNone(repository_test_command_argv("pytest -q && curl https://example.com"))
        self.assertIsNone(repository_test_command_argv("pytest ../outside/test.py"))
        self.assertIsNone(repository_test_command_argv("pytest /tmp/test.py"))
        self.assertIsNone(repository_test_command_argv("pytest --version"))
        self.assertIsNone(repository_test_command_argv("python -m pytest --version"))
        self.assertIsNone(repository_test_command_argv("uv run --project runtime pytest --collect-only"))
        self.assertIsNone(repository_test_run_evidence(
            "pytest --version", "pytest 8.0.0\\n[exit code: 0]",
        ))
        self.assertIsNone(repository_test_run_evidence(
            "npm test", "[Command timed out]\\n[exit code: 124]",
        ))
        self.assertIsNone(repository_test_run_evidence("npm test", "2 passed in 0.03s"))

    def test_pytest_setup_plan_and_setup_only_do_not_count_as_test_runs(self):
        commands = (
            ("pytest --setup-plan", ["pytest", "--setup-plan"]),
            ("pytest --setup-only", ["pytest", "--setup-only"]),
            ("python -m pytest --setup-plan", ["python", "-m", "pytest", "--setup-plan"]),
            ("uv run --project runtime pytest --setup-only",
             ["uv", "run", "--project", "runtime", "pytest", "--setup-only"]),
        )
        for command, argv in commands:
            with self.subTest(command=command):
                self.assertIsNone(repository_test_command_argv(command))
                self.assertIsNone(repository_test_run_evidence(
                    command, "0 passed, 0 failed\n[exit code: 0]",
                ))
                self.assertIsNone(local_repository_test_argv(argv))
                self.assertIsNone(background_test_run_evidence(
                    argv, "0 passed, 0 failed", 0,
                ))


if __name__ == "__main__":
    unittest.main()
