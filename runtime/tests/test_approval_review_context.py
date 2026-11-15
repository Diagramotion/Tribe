from types import SimpleNamespace
import unittest

from pydantic_ai.messages import ToolReturnPart

from tribe_runtime.agent_runtime import _approval_review_tool_evidence


class ApprovalReviewContextTests(unittest.TestCase):
    def test_includes_redacted_tool_results_as_issue_evidence(self):
        messages = [SimpleNamespace(parts=[ToolReturnPart(
            tool_name="sonarqube_list_issues",
            content={
                "issues": [{"rule": "javascript:S8786", "file": "src/example.js"}],
                "api_token": "do-not-share",
            },
        )])]

        evidence = _approval_review_tool_evidence(messages)

        self.assertIn("sonarqube_list_issues", evidence)
        self.assertIn("javascript:S8786", evidence)
        self.assertIn("src/example.js", evidence)
        self.assertIn("[redacted]", evidence)
        self.assertNotIn("do-not-share", evidence)

    def test_omits_non_tool_messages_and_bounds_recent_evidence(self):
        messages = [SimpleNamespace(parts=[SimpleNamespace(
            part_kind="user-prompt", content="private reasoning is not tool evidence",
        )])]
        messages.extend(SimpleNamespace(parts=[ToolReturnPart(
            tool_name=f"tool_{index}", content="x" * 2_000,
        )]) for index in range(10))

        evidence = _approval_review_tool_evidence(messages, limit=1_200)

        self.assertLessEqual(len(evidence), 1_200)
        self.assertNotIn("private reasoning", evidence)
        self.assertIn("tool_9", evidence)


if __name__ == "__main__":
    unittest.main()
