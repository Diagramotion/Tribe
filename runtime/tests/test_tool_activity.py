import unittest

from tribe_runtime.tool_activity import browser_activity_labels, summarize_tool_arguments


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
        self.assertIsNone(browser_activity_labels("github_create_issue"))

    def test_non_browser_tool_summaries_keep_existing_file_path_and_command_behaviour(self):
        self.assertEqual(summarize_tool_arguments("write_file", {"path": "src/app.py"}), "src/app.py")
        self.assertEqual(summarize_tool_arguments("run_command", {"command": "echo token=abc"}),
                         "echo token=[redacted]")


if __name__ == "__main__":
    unittest.main()
