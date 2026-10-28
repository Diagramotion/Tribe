from __future__ import annotations

import ast
from concurrent.futures import ThreadPoolExecutor
import tempfile
import unittest
from pathlib import Path

from tribe_runtime.agents import AgentDefinition
from tribe_runtime.capabilities import (
    CAPABILITIES,
    TOOL_TO_CAPABILITIES,
    capabilities_for_grants,
    tools_for_capabilities,
)
from tribe_runtime.recipes import _parse, list_recipes, save_recipe


RUNTIME_ROOT = Path(__file__).resolve().parents[1]


class CapabilityContractTests(unittest.TestCase):
    def test_every_registered_tribe_tool_belongs_to_a_capability(self) -> None:
        tree = ast.parse((RUNTIME_ROOT / "tribe_runtime" / "agent_runtime.py").read_text())
        registered = set()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if any(
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Attribute)
                and decorator.func.attr == "tool"
                for decorator in node.decorator_list
            ):
                registered.add(node.name)
        self.assertEqual(registered - set(TOOL_TO_CAPABILITIES), set())
        self.assertEqual(TOOL_TO_CAPABILITIES["update_state"], ("task_coordination", "chat_lifecycle"))

    def test_shared_state_tool_is_exposed_once_and_legacy_grants_migrate(self) -> None:
        capabilities = capabilities_for_grants(("claim_work", "complete_mission"))
        self.assertEqual(capabilities, ("task_coordination", "chat_lifecycle"))
        tools = tools_for_capabilities(capabilities)
        self.assertEqual(tools.count("update_state"), 1)
        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build", "legacy.md",
            tool_permissions=("claim_work",),
        )
        self.assertEqual(definition.capabilities, ("task_coordination",))

    def test_user_facing_grants_are_named_bundles(self) -> None:
        grants = {capability.id for capability in CAPABILITIES}
        self.assertIn("artifacts", grants)
        self.assertIn("memory", grants)
        self.assertIn("workflows", grants)
        self.assertNotIn("finalize_plan", grants)
        self.assertNotIn("complete_discovery", grants)

    def test_stage_guidance_is_a_valid_workflow_without_global_instructions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-workflow-") as temporary:
            recipe = save_recipe(
                Path(temporary), "field-research", "Field research", "Guide a short research task.",
                "", Path(temporary), objective="Produce a sourced research summary.",
                rules=["Cite primary sources."],
                stages=[{
                    "id": "research", "title": "Research", "objective": "Find reliable sources.",
                    "guide": "Search official documentation first.", "rules": ["Record dates."],
                    "transitions": [],
                }],
            )
        self.assertEqual(recipe.stages[0]["objective"], "Find reliable sources.")
        self.assertEqual(recipe.stages[0]["rules"], ["Record dates."])

    def test_malformed_workflow_front_matter_returns_validation_error(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-workflow-invalid-") as temporary:
            root = Path(temporary)
            (root / "bad-id.md").write_text(
                '---\nid: "{}"\ntitle: Bad\ndescription: Bad workflow\nversion: 1\n---\n\nGuide.\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "id must be 2 to 64"):
                list_recipes(root, root / "user")

    def test_yaml_workflow_supports_structured_graph_and_stage_guidance(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-workflow-yaml-") as temporary:
            path = Path(temporary) / "research.md"
            path.write_text(
                "---\n"
                "id: research-map\n"
                "version: 1\n"
                "title: Research map\n"
                "description: Follow a flexible research process.\n"
                "objective: Produce a supported recommendation.\n"
                "tags: [research, product]\n"
                "initial_stage: frame\n"
                "terminal_stages: [deliver]\n"
                "stages:\n"
                "  - id: frame\n"
                "    title: Frame\n"
                "    objective: Set scope.\n"
                "    guidance: Agree the key question.\n"
                "    rules: [Keep the scope testable.]\n"
                "  - id: collect\n"
                "    title: Collect\n"
                "    guide: Gather useful evidence.\n"
                "  - id: deliver\n"
                "    title: Deliver\n"
                "    guide: Explain the recommendation.\n"
                "transitions:\n"
                "  - from: frame\n"
                "    to: collect\n"
                "  - from: collect\n"
                "    to: frame\n"
                "    label: Scope gap\n"
                "  - from: collect\n"
                "    to: deliver\n"
                "---\n\nUse evidence appropriate to the question.\n",
                encoding="utf-8",
            )
            workflow = _parse(path, "user")
        self.assertEqual(workflow.initial_stage, "frame")
        self.assertEqual(workflow.terminal_stages, ("deliver",))
        self.assertEqual(workflow.tags, ("research", "product"))
        self.assertEqual(workflow.stages[0]["guide"], "Agree the key question.")
        self.assertEqual(workflow.stages[1]["transitions"][0]["when"], "Scope gap")

    def test_workflow_yaml_rejects_duplicate_fields_and_graphs_without_stages(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-workflow-invalid-yaml-") as temporary:
            root = Path(temporary)
            duplicate = root / "duplicate.md"
            duplicate.write_text(
                "---\nid: duplicate-flow\nid: replaced\nversion: 1\n"
                "title: Duplicate\ndescription: Bad definition\n---\n\nGuide.\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate workflow front matter field"):
                _parse(duplicate, "user")
            with self.assertRaisesRegex(ValueError, "transitions_require_stages"):
                save_recipe(
                    root / "user", "graph-only", "Graph only", "Invalid graph.", "Guide.",
                    root / "builtin", transitions=[{"from": "a", "to": "b"}],
                )

    def test_concurrent_workflow_saves_assign_unique_versions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-workflow-concurrent-") as temporary:
            root = Path(temporary)

            def save(index: int) -> int:
                return save_recipe(
                    root / "user", "release-check", "Release check", "Prepare a release.",
                    f"Guidance revision {index}.", root / "builtin",
                ).version

            with ThreadPoolExecutor(max_workers=8) as executor:
                versions = list(executor.map(save, range(8)))
            self.assertEqual(sorted(versions), list(range(1, 9)))
            self.assertEqual(list_recipes(root / "builtin", root / "user")[0].version, 8)


if __name__ == "__main__":
    unittest.main()
