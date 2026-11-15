import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tribe_runtime.harness_capabilities import (
    command_is_auto_review_candidate,
    command_is_reviewable,
    command_needs_approval,
    persistent_tool_approval_allowed,
)


class AutoReviewCommandPolicyTests(unittest.TestCase):
    def test_auto_review_accepts_read_only_inspection_with_stderr_suppression(self):
        command = (
            "ls -d runtime/.venv/lib/python*/site-packages/pydantic_ai_harness* 2>/dev/null "
            "|| true; find runtime/.venv/lib -path '*pydantic_ai_harness*' "
            "-maxdepth 6 -type f 2>/dev/null | head"
        )

        self.assertTrue(command_is_reviewable(command, Path.cwd()))
        self.assertTrue(command_is_auto_review_candidate(command, Path.cwd()))
        self.assertFalse(command_needs_approval(command, Path.cwd()))

    def test_auto_review_keeps_other_redirections_and_globbed_symlink_escapes_blocked(self):
        with TemporaryDirectory(prefix="tribe-auto-review-") as temporary:
            root = Path(temporary) / "repository"
            outside = Path(temporary) / "outside"
            root.mkdir()
            outside.mkdir()
            (outside / "secret.txt").write_text("outside", encoding="utf-8")
            (root / "external-secret.txt").symlink_to(outside / "secret.txt")

            command = "cat external-*.txt"
            self.assertFalse(command_is_reviewable(command, root))
            self.assertTrue(command_needs_approval(command, root))
            self.assertFalse(command_is_reviewable("cat README.md >/tmp/output", root))
            self.assertFalse(command_is_reviewable("cat README.md 2>/tmp/error", root))

    def test_auto_review_can_assess_bounded_local_node_probes(self):
        command = "node -e 'const start = performance.now(); console.log(start);'"

        self.assertTrue(command_is_auto_review_candidate(command))

    def test_auto_review_candidates_do_not_include_shell_chains_or_scripts(self):
        self.assertFalse(command_is_auto_review_candidate("node -e 'console.log(1)' && rm -rf ."))
        self.assertFalse(command_is_auto_review_candidate("bash -c 'node -e console.log(1)'"))
        self.assertFalse(command_is_auto_review_candidate("node -e 'console.log(1)\nconsole.log(2)'"))

    def test_read_only_pipeline_ignores_search_patterns_when_checking_paths(self):
        command = (
            "grep -nE 'self\\.path.*events|/api/events|append\\(' runtime/tribe_runtime/server.py "
            "| head -50; git diff -- runtime/tribe_runtime/workspace.py "
            "| sed -n '/run_foreground_process/,/diff --git/p' | head -220"
        )

        self.assertTrue(command_is_reviewable(command))
        self.assertFalse(command_needs_approval(command))
        self.assertTrue(persistent_tool_approval_allowed("run_command", {"command": command}))

    def test_auto_review_can_assess_read_only_git_chain_with_printf_separator(self):
        command = (
            "git status --short && printf '\\n--- diffstat ---\\n' && git diff --stat "
            "&& printf '\\n--- latest commit ---\\n' && git log -1 --oneline"
        )

        self.assertTrue(command_is_auto_review_candidate(command))
        self.assertTrue(command_is_reviewable(command))
        self.assertFalse(command_needs_approval(command))
        self.assertTrue(persistent_tool_approval_allowed("run_command", {"command": command}))

    def test_read_only_search_still_gates_external_file_operands(self):
        self.assertFalse(command_is_reviewable("grep -n secret /etc/passwd"))
        self.assertTrue(command_needs_approval("grep -n secret /etc/passwd"))
        self.assertFalse(persistent_tool_approval_allowed(
            "run_command", {"command": "grep -n secret /etc/passwd"},
        ))
        self.assertFalse(command_is_reviewable("find -L /etc -name passwd"))
        self.assertTrue(command_needs_approval("find -L /etc -name passwd"))

    def test_expression_options_remain_reviewable_and_sed_files_are_path_checked(self):
        for command in (
            "grep -e needle README.md",
            "rg -e needle README.md",
            "sed -e 's/a/b/' README.md",
        ):
            with self.subTest(command=command):
                self.assertTrue(command_is_reviewable(command))
                self.assertFalse(command_needs_approval(command))

        self.assertFalse(command_is_reviewable("sed -e 's/a/b/' /etc/passwd"))
        self.assertTrue(command_needs_approval("sed -e 's/a/b/' /etc/passwd"))

    def test_read_only_options_that_consume_paths_are_checked(self):
        for command in (
            "rg --files-from /etc/passwd",
            "rg --ignore-file=/etc/passwd needle README.md",
            "find . -newer /etc/passwd",
            "find . -files0-from /etc/passwd",
        ):
            with self.subTest(command=command):
                self.assertFalse(command_is_reviewable(command))
                self.assertTrue(command_needs_approval(command))
                self.assertFalse(persistent_tool_approval_allowed(
                    "run_command", {"command": command},
                ))

        self.assertTrue(command_is_reviewable("find . -newer README.md -type f"))

    def test_ripgrep_preprocessor_requires_exact_approval(self):
        for command in (
            "rg --pre touch --pre-glob='*.md' needle README.md",
            "rg --pre=touch --pre-glob='*.md' needle README.md",
        ):
            with self.subTest(command=command):
                self.assertFalse(command_is_reviewable(command))
                self.assertTrue(command_needs_approval(command))
                self.assertFalse(persistent_tool_approval_allowed(
                    "run_command", {"command": command},
                ))

    def test_find_output_and_sed_file_commands_require_exact_approval(self):
        for command in (
            "find . -fprint /tmp/results",
            "find . -fprint0 /tmp/results",
            "find . -fprintf /tmp/results %p",
            "sed -e 'r /etc/passwd' README.md",
            "sed -e 's/a/b/w /tmp/results' README.md",
            "sed -e 's/a/b/e' README.md",
        ):
            with self.subTest(command=command):
                self.assertFalse(command_is_reviewable(command))
                self.assertTrue(command_needs_approval(command))
                self.assertFalse(persistent_tool_approval_allowed(
                    "run_command", {"command": command},
                ))

    def test_sed_in_place_suffixes_require_exact_approval(self):
        for command in (
            "sed --in-place=.bak 's/a/b/' README.md",
            "sed -i.bak 's/a/b/' README.md",
            "sed -i=.bak 's/a/b/' README.md",
        ):
            with self.subTest(command=command):
                self.assertFalse(command_is_reviewable(command))
                self.assertTrue(command_needs_approval(command))
                self.assertFalse(persistent_tool_approval_allowed(
                    "run_command", {"command": command},
                ))


if __name__ == "__main__":
    unittest.main()
