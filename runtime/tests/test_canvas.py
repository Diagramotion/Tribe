from __future__ import annotations

import unittest

from tribe_runtime.canvas import comment_publications, document_publications, visible_message


class CanvasPublicationTests(unittest.TestCase):
    def test_parses_valid_document_and_hides_structured_block_from_channel_copy(self) -> None:
        text = 'Drafting the release plan.\n\n```canvas:v1\n{"title":"Release plan","kind":"markdown","body":"# Ship it"}\n```'
        documents = document_publications(text)

        self.assertEqual(documents[0]["title"], "Release plan")
        self.assertEqual(visible_message(text), "Drafting the release plan.")

    def test_existing_document_requires_both_identity_and_revision(self) -> None:
        valid = '{"artifact_id":"doc-1","base_revision":3,"title":"Plan","kind":"markdown","body":"Updated"}'
        ambiguous = '{"artifact_id":"doc-1","title":"Plan","kind":"markdown","body":"Updated"}'

        self.assertEqual(document_publications(f"```canvas:v1\n{valid}\n```"), [{
            "artifact_id": "doc-1", "base_revision": 3, "title": "Plan",
            "kind": "markdown", "language": "", "body": "Updated",
        }])
        self.assertEqual(document_publications(f"```canvas:v1\n{ambiguous}\n```"), [])

    def test_parses_revision_anchored_comments_and_replies(self) -> None:
        annotation = '{"artifact_id":"doc-1","base_revision":2,"quote":"line","body":"Check this","assignee":"@reviewer"}'
        reply = '{"artifact_id":"doc-1","thread_id":"thread-1","body":"Fixed"}'

        parsed = comment_publications(
            f"```canvas-comment:v1\n{annotation}\n```\n```canvas-comment:v1\n{reply}\n```"
        )

        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0]["assignee"], "reviewer")
        self.assertEqual(parsed[1]["thread_id"], "thread-1")

    def test_incomplete_or_oversized_publications_are_inert(self) -> None:
        incomplete = '```canvas:v1\n{"title":"Plan","kind":"markdown","body":"x"}'
        oversized = '{"title":"Plan","kind":"markdown","body":"' + ("x" * 270_000) + '"}'

        self.assertEqual(document_publications(incomplete), [])
        self.assertEqual(document_publications(f"```canvas:v1\n{oversized}\n```"), [])


if __name__ == "__main__":
    unittest.main()
