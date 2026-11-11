"""Versioned Markdown workflow recipes for mission planning."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import uuid
from copy import deepcopy
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

RECIPE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
_EXPECTED_VERSION_UNSET = object()
_RECIPE_LOCKS_GUARD = threading.Lock()
_RECIPE_LOCKS: dict[Path, threading.RLock] = {}


def _contained_path(root: Path, *parts: str) -> Path:
    """Resolve a workflow path and reject symlinks or names escaping its root."""
    resolved_root = root.resolve()
    candidate = resolved_root.joinpath(*parts).resolve()
    if not candidate.is_relative_to(resolved_root):
        raise ValueError("workflow_path_invalid")
    return candidate


def _iter_recipe_files(directory: Path):
    if not directory.is_dir():
        return
    for candidate in sorted(directory.glob("*.md")):
        yield _contained_path(directory, candidate.name)


def _iter_history_files(user_dir: Path):
    history_root = user_dir / ".versions"
    if not history_root.is_dir():
        return
    for directory in sorted(history_root.iterdir()):
        if not directory.is_dir():
            continue
        history = _contained_path(history_root, directory.name)
        for candidate in sorted(history.glob("v*.md")):
            yield _contained_path(history, candidate.name)


def _find_recipe_path(directory: Path, recipe_id: str, source: str) -> Path | None:
    for path in _iter_recipe_files(directory):
        if _parse(path, source).id == recipe_id:
            return path
    return None


def _find_history_directory(user_dir: Path, recipe_id: str) -> Path | None:
    history_root = user_dir / ".versions"
    if not history_root.is_dir():
        return None
    for directory in sorted(history_root.iterdir()):
        if not directory.is_dir():
            continue
        history = _contained_path(history_root, directory.name)
        for candidate in sorted(history.glob("v*.md")):
            path = _contained_path(history, candidate.name)
            try:
                if _parse(path, "user").id == recipe_id:
                    return history
            except (OSError, ValueError):
                continue
    return None


class WorkflowVersionConflict(ValueError):
    def __init__(self, current_version: int | None):
        super().__init__("workflow_version_conflict")
        self.current_version = current_version


def _load_frontmatter(source: str, path: Path) -> dict[str, object]:
    import yaml

    class UniqueKeyLoader(yaml.SafeLoader):
        pass

    def construct_mapping(loader, node, deep=False):
        mapping = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if not isinstance(key, str):
                raise ValueError("workflow front matter keys must be strings")
            if key in mapping:
                raise ValueError(f"duplicate workflow front matter field: {key}")
            mapping[key] = loader.construct_object(value_node, deep=deep)
        return mapping

    UniqueKeyLoader.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping,
    )
    try:
        value = yaml.load(source, Loader=UniqueKeyLoader)
    except Exception as error:
        raise ValueError(f"{path}: invalid workflow YAML front matter: {error}") from error
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError(f"{path}: workflow front matter must be a mapping")
    return value


@contextmanager
def _recipe_lock(user_dir: Path):
    user_dir.mkdir(parents=True, exist_ok=True)
    lock_directory = user_dir / ".locks"
    lock_directory.mkdir(parents=True, exist_ok=True)
    lock_path = _contained_path(user_dir, ".locks", "workflows.lock")
    with _RECIPE_LOCKS_GUARD:
        thread_lock = _RECIPE_LOCKS.setdefault(lock_path, threading.RLock())
    with thread_lock:
        with lock_path.open("a+b") as lock_file:
            lock_file.seek(0, os.SEEK_END)
            if lock_file.tell() == 0:
                lock_file.write(b"\0")
                lock_file.flush()
            if os.name == "nt":
                import msvcrt
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == "nt":
                    import msvcrt
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


@dataclass(frozen=True)
class WorkflowRecipe:
    id: str
    title: str
    description: str
    version: int
    instructions: str
    source: str
    stages: tuple[dict[str, object], ...] = ()
    objective: str = ""
    rules: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    initial_stage: str | None = None
    terminal_stages: tuple[str, ...] = ()

    def snapshot(self) -> dict[str, object]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "objective": self.objective or self.description,
            "version": self.version,
            "instructions": self.instructions,
            "rules": list(self.rules),
            "tags": list(self.tags),
            "initial_stage": self.initial_stage,
            "terminal_stages": list(self.terminal_stages),
            "stages": deepcopy(list(self.stages)),
        }


def _normalise_rules(value: object, field: str = "workflow rules") -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or len(value) > 30:
        raise ValueError(f"{field} must be a list of at most 30 concise rules")
    rules = []
    for rule in value:
        if not isinstance(rule, str) or not rule.strip() or len(rule.strip()) > 1000:
            raise ValueError(f"{field} entries must be 1 to 1000 characters")
        rules.append(rule.strip())
    return tuple(rules)


def _normalise_stages(value: object, path: Path | None = None,
                      graph_transitions: object = None) -> tuple[dict[str, object], ...]:
    if value is None:
        if graph_transitions not in (None, []):
            raise ValueError("workflow_transitions_require_stages")
        return ()
    if not isinstance(value, list) or len(value) > 20:
        location = f"{path}: " if path else ""
        raise ValueError(f"{location}workflow stages must be a list of at most 20 stages")
    stages: list[dict[str, object]] = []
    identifiers: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("workflow_stage_invalid")
        if not isinstance(item.get("id"), str) or not isinstance(item.get("title"), str):
            raise ValueError("workflow_stage_invalid")
        stage_id = item["id"].strip()
        title = item["title"].strip()
        if not RECIPE_ID.fullmatch(stage_id) or not title or len(title) > 80:
            raise ValueError("workflow_stage_invalid")
        if stage_id in identifiers:
            raise ValueError("workflow_stage_id_must_be_unique")
        identifiers.add(stage_id)
        objective_value = item.get("objective", "")
        guide_value = item.get("guide", item.get("guidance", ""))
        if not isinstance(objective_value, str) or not isinstance(guide_value, str):
            raise ValueError("workflow_stage_guidance_invalid")
        objective = objective_value.strip()
        guide = guide_value.strip()
        if len(objective) > 2000 or len(guide) > 8000:
            raise ValueError("workflow_stage_guidance_too_long")
        rules = _normalise_rules(item.get("rules", []), "stage rules")
        position_value = item.get("position")
        position = None
        if position_value is not None:
            if (not isinstance(position_value, dict)
                    or isinstance(position_value.get("x"), bool)
                    or not isinstance(position_value.get("x"), (int, float))
                    or isinstance(position_value.get("y"), bool)
                    or not isinstance(position_value.get("y"), (int, float))):
                raise ValueError("workflow_stage_position_invalid")
            x, y = float(position_value["x"]), float(position_value["y"])
            if not (-100_000 <= x <= 100_000 and -100_000 <= y <= 100_000):
                raise ValueError("workflow_stage_position_invalid")
            position = {"x": x, "y": y}
        transitions = item.get("transitions", [])
        if not isinstance(transitions, list) or len(transitions) > 20:
            raise ValueError("workflow_stage_transitions_invalid")
        normalised_transitions = []
        for transition in transitions:
            if isinstance(transition, str):
                target, when = transition.strip(), ""
            elif isinstance(transition, dict):
                target_value = transition.get("to", "")
                when_value = transition.get("when", "")
                if not isinstance(target_value, str) or not isinstance(when_value, str):
                    raise ValueError("workflow_stage_transitions_invalid")
                target = target_value.strip()
                when = when_value.strip()
            else:
                raise ValueError("workflow_stage_transitions_invalid")
            if not RECIPE_ID.fullmatch(target) or len(when) > 500:
                raise ValueError("workflow_stage_transitions_invalid")
            normalised_transitions.append({"to": target, "when": when})
        normalised_stage = {"id": stage_id, "title": title, "objective": objective,
                            "guide": guide, "rules": list(rules),
                            "transitions": normalised_transitions}
        if position is not None:
            normalised_stage["position"] = position
        stages.append(normalised_stage)
    if graph_transitions is not None:
        if not stages and graph_transitions:
            raise ValueError("workflow_transitions_require_stages")
        if not isinstance(graph_transitions, list) or len(graph_transitions) > 400:
            raise ValueError("workflow_transitions_invalid")
        stage_map = {str(stage["id"]): stage for stage in stages}
        for transition in graph_transitions:
            if not isinstance(transition, dict):
                raise ValueError("workflow_transitions_invalid")
            source_value = transition.get("from", "")
            target_value = transition.get("to", "")
            when_value = transition.get("when", transition.get("label", ""))
            if not all(isinstance(value, str) for value in (source_value, target_value, when_value)):
                raise ValueError("workflow_transitions_invalid")
            source, target, when = source_value.strip(), target_value.strip(), when_value.strip()
            if (source not in stage_map or not RECIPE_ID.fullmatch(target)
                    or target not in stage_map or len(when) > 500):
                raise ValueError("workflow_transition_target_missing")
            stage_map[source]["transitions"].append({"to": target, "when": when})
    if any(len(stage["transitions"]) > 20 for stage in stages):
        raise ValueError("workflow_stage_transitions_invalid")
    identifiers = {str(stage["id"]) for stage in stages}
    if any(edge["to"] not in identifiers for stage in stages
           for edge in stage["transitions"]):
        raise ValueError("workflow_transition_target_missing")
    return tuple(stages)


def _parse(path: Path, source: str) -> WorkflowRecipe:
    try:
        with path.open("rb") as source_file:
            file_bytes = source_file.read(32_001)
        if len(file_bytes) > 32_000:
            raise ValueError(f"{path}: workflow definition is larger than 32000 bytes")
        text = file_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"{path}: workflow definition must be UTF-8") from error
    frontmatter_match = re.match(
        r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)(.*)\Z", text, re.DOTALL,
    )
    if frontmatter_match is None:
        raise ValueError(f"{path}: workflow must have a closed YAML front matter block")
    frontmatter, body = frontmatter_match.groups()
    fields = _load_frontmatter(frontmatter, path)
    recipe_id = fields.get("id", "")
    title = fields.get("title", "")
    description = fields.get("description", "")
    version_text = fields.get("version", "")
    if not isinstance(recipe_id, str):
        raise ValueError(f"{path}: id must be a string")
    if not isinstance(title, str) or not isinstance(description, str):
        raise ValueError(f"{path}: title and description must be strings")
    if not isinstance(version_text, (str, int)) or isinstance(version_text, bool):
        raise ValueError(f"{path}: version must be a positive integer")
    version_text = str(version_text)
    instructions_value = fields.get("instructions", "")
    if not isinstance(instructions_value, str):
        raise ValueError(f"{path}: workflow instructions must be a string")
    instructions = "\n\n".join(part.strip() for part in (instructions_value, body) if part.strip())
    if not RECIPE_ID.fullmatch(recipe_id):
        raise ValueError(f"{path}: id must be 2 to 64 lowercase letters, digits, '_' or '-'")
    if not title or len(title) > 120 or not description or len(description) > 500:
        raise ValueError(f"{path}: title and description are required and must be concise")
    if not version_text.isdigit() or int(version_text) < 1:
        raise ValueError(f"{path}: version must be a positive integer")
    if len(instructions) > 20_000:
        raise ValueError(f"{path}: workflow guide must be no longer than 20000 characters")
    stages = _normalise_stages(fields.get("stages"), path, fields.get("transitions"))
    objective_value = fields.get("objective") or description
    if not isinstance(objective_value, str):
        raise ValueError(f"{path}: workflow objective must be a string")
    objective = objective_value.strip()
    if not objective or len(objective) > 2000:
        raise ValueError(f"{path}: workflow objective must be 1 to 2000 characters")
    rules = _normalise_rules(fields.get("rules"), f"{path}: workflow rules")
    tags_value = fields.get("tags", [])
    if (not isinstance(tags_value, list) or len(tags_value) > 30
            or any(not isinstance(tag, str) or not tag.strip() or len(tag.strip()) > 64
                   for tag in tags_value)):
        raise ValueError(f"{path}: workflow tags must be a list of up to 30 short strings")
    stage_ids = {str(stage["id"]) for stage in stages}
    initial_stage = fields.get("initial_stage")
    if initial_stage is not None and (
        not isinstance(initial_stage, str) or len(initial_stage) > 64 or initial_stage not in stage_ids
    ):
        raise ValueError(f"{path}: initial_stage must name a workflow stage")
    if initial_stage is None and stages:
        initial_stage = str(stages[0]["id"])
    terminal_value = fields.get("terminal_stages")
    if terminal_value is None:
        terminal_stages = tuple(
            str(stage["id"]) for stage in stages if not stage["transitions"]
        )
    elif (not isinstance(terminal_value, list) or len(terminal_value) > 20 or any(
        not isinstance(stage_id, str) or stage_id not in stage_ids for stage_id in terminal_value
    )):
        raise ValueError(f"{path}: terminal_stages must name workflow stages")
    else:
        terminal_stages = tuple(dict.fromkeys(terminal_value))
    if not instructions and not any(stage.get("guide") for stage in stages) and not stages:
        raise ValueError(f"{path}: workflow needs at least one stage or some overall guidance")
    return WorkflowRecipe(recipe_id, title, description, int(version_text), instructions,
                          source, stages, objective, rules, tuple(tag.strip() for tag in tags_value),
                          initial_stage, terminal_stages)


def list_recipes(builtin_dir: Path, user_dir: Path) -> list[WorkflowRecipe]:
    recipes: dict[str, WorkflowRecipe] = {}
    for directory, source in ((builtin_dir, "builtin"), (user_dir, "user")):
        if not directory.is_dir():
            continue
        for path in _iter_recipe_files(directory):
            recipe = _parse(path, source)
            recipes[recipe.id] = recipe
    return sorted(recipes.values(), key=lambda recipe: (recipe.source != "builtin", recipe.title.casefold()))


def get_recipe(builtin_dir: Path, user_dir: Path, recipe_id: str,
               version: int | None = None) -> WorkflowRecipe | None:
    if not isinstance(recipe_id, str) or not RECIPE_ID.fullmatch(recipe_id):
        return None
    if version is not None and (
        isinstance(version, bool) or not isinstance(version, int) or version < 1
    ):
        return None
    for path in _iter_recipe_files(user_dir):
        recipe = _parse(path, "user")
        if recipe.id == recipe_id and (version is None or recipe.version == version):
            return recipe
    if version is not None:
        for path in _iter_history_files(user_dir):
            recipe = _parse(path, "user")
            if recipe.id == recipe_id and recipe.version == version:
                return recipe
    for path in _iter_recipe_files(builtin_dir):
        recipe = _parse(path, "builtin")
        if recipe.id == recipe_id and (version is None or recipe.version == version):
            return recipe
    return None


def list_recipe_versions(builtin_dir: Path, user_dir: Path, recipe_id: str) -> list[int]:
    """Return every immutable version available for one workflow."""
    if not isinstance(recipe_id, str) or not RECIPE_ID.fullmatch(recipe_id):
        return []
    versions: set[int] = set()
    for path in _iter_history_files(user_dir):
        recipe = _parse(path, "user")
        if recipe.id == recipe_id:
            versions.add(recipe.version)
    for directory, source in ((user_dir, "user"), (builtin_dir, "builtin")):
        path = _find_recipe_path(directory, recipe_id, source)
        if path is not None:
            versions.add(_parse(path, source).version)
    return sorted(versions, reverse=True)


def save_recipe(user_dir: Path, recipe_id: str, title: str, description: str,
                instructions: str, builtin_dir: Path,
                stages: object = None, objective: str | None = None,
                rules: object = None, tags: object = None,
                initial_stage: str | None = None,
                terminal_stages: object = None, transitions: object = None,
                expected_version: object = _EXPECTED_VERSION_UNSET) -> WorkflowRecipe:
    if not isinstance(recipe_id, str) or not RECIPE_ID.fullmatch(recipe_id):
        raise ValueError("recipe_id_must_be_2_to_64_lowercase_letters_digits_underscore_or_hyphen")
    with _recipe_lock(user_dir):
        return _save_recipe_unlocked(
            user_dir, recipe_id, title, description, instructions, builtin_dir,
            stages, objective, rules, tags, initial_stage, terminal_stages, transitions,
            expected_version,
        )


def _save_recipe_unlocked(user_dir: Path, recipe_id: str, title: str, description: str,
                          instructions: str, builtin_dir: Path,
                          stages: object = None, objective: str | None = None,
                          rules: object = None, tags: object = None,
                          initial_stage: str | None = None,
                          terminal_stages: object = None, transitions: object = None,
                          expected_version: object = _EXPECTED_VERSION_UNSET) -> WorkflowRecipe:
    if not RECIPE_ID.fullmatch(recipe_id):
        raise ValueError("recipe_id_must_be_2_to_64_lowercase_letters_digits_underscore_or_hyphen")
    if not all(isinstance(value, str) for value in (title, description, instructions)):
        raise ValueError("workflow_title_description_and_instructions_must_be_strings")
    title, description, instructions = title.strip(), description.strip(), instructions.strip()
    if not title or len(title) > 120 or not description or len(description) > 500:
        raise ValueError("recipe_title_and_description_are_required_and_must_be_concise")
    if len(instructions) > 20_000:
        raise ValueError("workflow_guide_must_be_no_longer_than_20000_characters")
    current = get_recipe(builtin_dir, user_dir, recipe_id)
    if expected_version is not _EXPECTED_VERSION_UNSET:
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise ValueError("workflow_expected_version_must_be_a_non_negative_integer")
        current_version = current.version if current else 0
        if expected_version != current_version:
            raise WorkflowVersionConflict(current.version if current else None)
    historical_versions = [
        recipe.version for candidate in _iter_history_files(user_dir)
        if (recipe := _parse(candidate, "user")).id == recipe_id
    ]
    saved_stages = _normalise_stages(
        stages if stages is not None else list(current.stages) if current else [],
        graph_transitions=transitions,
    )
    saved_objective_value = (objective if objective is not None else
                             current.objective if current else description)
    if not isinstance(saved_objective_value, str):
        raise ValueError("workflow_objective_must_be_a_string")
    saved_objective = saved_objective_value.strip()
    if not saved_objective or len(saved_objective) > 2000:
        raise ValueError("workflow_objective_must_be_1_to_2000_characters")
    saved_rules = _normalise_rules(rules if rules is not None else list(current.rules) if current else [])
    saved_tags = tags if tags is not None else list(current.tags) if current else []
    if (not isinstance(saved_tags, list) or len(saved_tags) > 30
            or any(not isinstance(tag, str) or not tag.strip() or len(tag.strip()) > 64
                   for tag in saved_tags)):
        raise ValueError("workflow_tags_must_be_a_list_of_up_to_30_short_strings")
    stage_ids = {str(stage["id"]) for stage in saved_stages}
    inherited_initial = current.initial_stage if current and current.initial_stage in stage_ids else None
    saved_initial = initial_stage if initial_stage is not None else (
        inherited_initial or (str(saved_stages[0]["id"]) if saved_stages else None)
    )
    if saved_initial is not None and (
        not isinstance(saved_initial, str) or len(saved_initial) > 64 or saved_initial not in stage_ids
    ):
        raise ValueError("workflow_initial_stage_not_found")
    inherited_terminal = list(current.terminal_stages) if current else []
    if any(stage_id not in stage_ids for stage_id in inherited_terminal):
        inherited_terminal = []
    saved_terminal = terminal_stages if terminal_stages is not None else (
        inherited_terminal if inherited_terminal else None
    )
    if saved_terminal is None:
        saved_terminal = [str(stage["id"]) for stage in saved_stages if not stage["transitions"]]
    if (not isinstance(saved_terminal, list) or len(saved_terminal) > 20
            or any(not isinstance(stage_id, str) or stage_id not in stage_ids for stage_id in saved_terminal)):
        raise ValueError("workflow_terminal_stage_not_found")
    if not instructions and not any(stage.get("guide") for stage in saved_stages) and not saved_stages:
        raise ValueError("workflow_requires_stage_or_overall_guidance")
    version = max([current.version if current else 0, *historical_versions]) + 1
    content = (
        "---\n"
        f"id: {recipe_id}\n"
        f"title: {json.dumps(title, ensure_ascii=False)}\n"
        f"description: {json.dumps(description, ensure_ascii=False)}\n"
        f"objective: {json.dumps(saved_objective, ensure_ascii=False)}\n"
        f"version: {version}\n"
        f"rules: {json.dumps(list(saved_rules), ensure_ascii=False)}\n"
        f"tags: {json.dumps([tag.strip() for tag in saved_tags], ensure_ascii=False)}\n"
        f"initial_stage: {json.dumps(saved_initial, ensure_ascii=False)}\n"
        f"terminal_stages: {json.dumps(list(dict.fromkeys(saved_terminal)), ensure_ascii=False)}\n"
        f"stages: {json.dumps(list(saved_stages), ensure_ascii=False)}\n"
        "---\n\n"
        f"{instructions}\n"
    )
    user_dir.mkdir(parents=True, exist_ok=True)
    path = _find_recipe_path(user_dir, recipe_id, "user")
    if path is None:
        path = _contained_path(user_dir, f"{uuid.uuid4().hex}.md")
    history = _find_history_directory(user_dir, recipe_id)
    if history is None:
        history = _contained_path(user_dir / ".versions", uuid.uuid4().hex)
    descriptor, temporary_path = tempfile.mkstemp(prefix=".workflow-", suffix=".md", dir=user_dir)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        recipe = _parse(Path(temporary_path), "user")
        history.mkdir(parents=True, exist_ok=True)
        version_path = _contained_path(history, f"v{version}.md")
        if version_path.exists():
            if version_path.read_text(encoding="utf-8") != content:
                raise ValueError("workflow_version_is_immutable")
        else:
            version_descriptor, version_temporary = tempfile.mkstemp(
                prefix=".workflow-version-", suffix=".md", dir=history,
            )
            try:
                with os.fdopen(version_descriptor, "w", encoding="utf-8") as target:
                    target.write(content)
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(version_temporary, version_path)
            except Exception:
                Path(version_temporary).unlink(missing_ok=True)
                raise
        # Commit the active pointer only after the immutable version is durable. If a
        # crash happens between these replacements, the next save advances past the
        # orphaned history version instead of trying to reuse or overwrite it.
        os.replace(temporary_path, path)
    except Exception:
        Path(temporary_path).unlink(missing_ok=True)
        raise
    return recipe
