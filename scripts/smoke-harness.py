"""Exercise a real Pydantic AI tool call against a disposable Git repository."""

from __future__ import annotations

import argparse
import asyncio
import subprocess
import tempfile
from pathlib import Path

from tribe_runtime.agent_runtime import PydanticAIProvider
from tribe_runtime.agents import AgentDefinition
from tribe_runtime.credentials import (
    get_api_key,
    prepare_provider_environment,
    provider_for_model,
)
from tribe_runtime.store import MissionStore


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Pydantic AI model id, e.g. openai:model")
    args = parser.parse_args()

    key = get_api_key(args.model)
    if not key:
        raise SystemExit("No provider key is configured for this model.")
    prepare_provider_environment(provider_for_model(args.model), key)

    with tempfile.TemporaryDirectory(prefix="tribe-harness-smoke-") as directory:
        root = Path(directory)
        repository = root / "repository"
        repository.mkdir()
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        subprocess.run(["git", "-C", str(repository), "config", "user.email", "tribe@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(repository), "config", "user.name", "Tribe smoke"], check=True)
        (repository / "README.md").write_text("Disposable Harness smoke repository.\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repository), "add", "README.md"], check=True)
        subprocess.run(["git", "-C", str(repository), "commit", "-qm", "initial"], check=True)

        store = MissionStore(root / "tribe.sqlite3")
        _, mission = store.create_project(
            str(repository), "Harness smoke", "Verify Pydantic AI Harness", "Create a file with a tool."
        )
        store.create_work_item(mission["id"], "Write the smoke artifact", "Use the Harness file tool.")
        trigger = store.append("message.created", "user", mission["id"], {
            "text": (
                "Use the Pydantic AI Harness workspace file tool to create exactly "
                "`tribe-harness-live-smoke.txt` with the contents `Harness tool call verified.` "
                "Then post a concise update. Make the tool call; do not merely describe it."
            ),
            "recipient": "builder",
        })
        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Implement the claimed repository task.", "builder.md"
        )
        asyncio.run(PydanticAIProvider(definition, args.model).run(store, mission["id"], trigger))

        file_events = [
            event for event in store.events_after(mission["id"], 0)
            if event["type"] == "repo.file.changed"
            and event["payload"].get("source") == "pydantic_ai_harness"
        ]
        expected = repository / "tribe-harness-live-smoke.txt"
        if (not expected.is_file() or expected.read_text(encoding="utf-8").strip()
                != "Harness tool call verified." or not file_events
                or not any(event["payload"].get("path") == expected.name for event in file_events)):
            raise SystemExit("The provider run completed without a recorded Harness file tool call.")
        print(f"Verified Pydantic AI Harness wrote {expected.name} using {args.model}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
