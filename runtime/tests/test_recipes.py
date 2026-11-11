from pathlib import Path
import tempfile
import unittest

from tribe_runtime.recipes import WorkflowVersionConflict, get_recipe, list_recipe_versions, save_recipe


class WorkflowVersionTests(unittest.TestCase):
    def test_recipe_read_helpers_reject_path_segments(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertIsNone(get_recipe(root / "builtins", root / "users", "../outside"))
            self.assertEqual(list_recipe_versions(root / "builtins", root / "users", "../../outside"), [])

    def test_expected_version_is_checked_inside_the_workflow_save_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            builtins = root / "builtins"
            users = root / "users"
            save_recipe(users, "safe-edit", "First", "Summary", "Guide", builtins,
                        expected_version=0)
            with self.assertRaises(WorkflowVersionConflict) as conflict:
                save_recipe(users, "safe-edit", "Stale", "Summary", "Guide", builtins,
                            expected_version=0)
            self.assertEqual(conflict.exception.current_version, 1)

    def test_a_sequential_workflow_can_be_defined_by_its_stage_list(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            builtins = root / "builtins"
            saved = save_recipe(
                root / "users", "simple-flow", "Simple flow", "A workflow made from stages.",
                "", builtins, stages=[
                    {"id": "first", "title": "First", "transitions": [{"to": "last"}]},
                    {"id": "last", "title": "Last", "transitions": []},
                ], objective="Follow the stages.", initial_stage="first", terminal_stages=["last"],
            )
            self.assertEqual([stage["id"] for stage in saved.stages], ["first", "last"])

    def test_saves_immutable_graph_versions_and_lists_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            builtins = root / "builtins"
            users = root / "users"
            builtins.mkdir()
            stages = [
                {"id": "review", "title": "Review", "transitions": [
                    {"to": "fix", "when": "Findings"},
                ], "position": {"x": 280, "y": 120}},
                {"id": "fix", "title": "Fix", "transitions": [
                    {"to": "review", "when": "More work"},
                    {"to": "verify", "when": "Ready"},
                ]},
                {"id": "verify", "title": "Verify", "transitions": []},
            ]
            first = save_recipe(
                users, "review-loop", "Review loop", "Review and correct changes.",
                "Keep the process focused.", builtins, stages=stages,
                objective="Deliver a reviewed change.", initial_stage="review",
                terminal_stages=["verify"],
            )
            second = save_recipe(
                users, "review-loop", "Review loop", "Review and correct changes.",
                "Keep the process focused and adapt when needed.", builtins, stages=stages,
                objective="Deliver a reviewed change.", initial_stage="review",
                terminal_stages=["verify"],
            )

            self.assertEqual((first.version, second.version), (1, 2))
            self.assertEqual(list_recipe_versions(builtins, users, "review-loop"), [2, 1])
            saved_v1 = get_recipe(builtins, users, "review-loop", 1)
            saved_v2 = get_recipe(builtins, users, "review-loop", 2)
            self.assertEqual(saved_v1.instructions, "Keep the process focused.")
            self.assertEqual(saved_v2.stages[1]["transitions"][0]["to"], "review")
            self.assertEqual(saved_v2.stages[1]["transitions"][1]["to"], "verify")
            self.assertEqual(saved_v2.stages[0]["position"], {"x": 280.0, "y": 120.0})


if __name__ == "__main__":
    unittest.main()
