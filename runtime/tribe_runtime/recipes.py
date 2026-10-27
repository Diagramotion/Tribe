"""Versioned Markdown workflow recipes for mission planning."""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

RECIPE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")


@dataclass(frozen=True)
class WorkflowRecipe:
    id: str
    title: str
    description: str
    version: int
    instructions: str
    source: str

    def snapshot(self) -> dict[str, str | int]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "version": self.version,
            "instructions": self.instructions,
        }


def _parse(path: Path, source: str) -> WorkflowRecipe:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise ValueError(f"{path}: workflow must start with YAML front matter")
    _, frontmatter, body = text.split("---\n", 2)
    fields: dict[str, str] = {}
    for line in frontmatter.splitlines():
        if not line.strip():
            continue
        key, separator, value = line.partition(":")
        if not separator or not key.strip() or key.strip() in fields:
            raise ValueError(f"{path}: malformed or duplicate front matter field")
        raw_value = value.strip()
        if raw_value.startswith('"'):
            try:
                raw_value = json.loads(raw_value)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}: invalid quoted front matter value") from error
        fields[key.strip()] = raw_value
    recipe_id = fields.get("id", "")
    title = fields.get("title", "")
    description = fields.get("description", "")
    version_text = fields.get("version", "")
    instructions = body.strip()
    if not RECIPE_ID.fullmatch(recipe_id):
        raise ValueError(f"{path}: id must be 2 to 64 lowercase letters, digits, '_' or '-'")
    if not title or len(title) > 120 or not description or len(description) > 500:
        raise ValueError(f"{path}: title and description are required and must be concise")
    if not version_text.isdigit() or int(version_text) < 1:
        raise ValueError(f"{path}: version must be a positive integer")
    if not instructions or len(instructions) > 20_000:
        raise ValueError(f"{path}: workflow instructions must be 1 to 20000 characters")
    return WorkflowRecipe(recipe_id, title, description, int(version_text), instructions, source)


def list_recipes(builtin_dir: Path, user_dir: Path) -> list[WorkflowRecipe]:
    recipes: dict[str, WorkflowRecipe] = {}
    for directory, source in ((builtin_dir, "builtin"), (user_dir, "user")):
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            recipe = _parse(path, source)
            recipes[recipe.id] = recipe
    return sorted(recipes.values(), key=lambda recipe: (recipe.source != "builtin", recipe.title.casefold()))


def get_recipe(builtin_dir: Path, user_dir: Path, recipe_id: str) -> WorkflowRecipe | None:
    return next((recipe for recipe in list_recipes(builtin_dir, user_dir) if recipe.id == recipe_id), None)


def save_recipe(user_dir: Path, recipe_id: str, title: str, description: str,
                instructions: str, builtin_dir: Path) -> WorkflowRecipe:
    if not RECIPE_ID.fullmatch(recipe_id):
        raise ValueError("recipe_id_must_be_2_to_64_lowercase_letters_digits_underscore_or_hyphen")
    title, description, instructions = title.strip(), description.strip(), instructions.strip()
    if not title or len(title) > 120 or not description or len(description) > 500:
        raise ValueError("recipe_title_and_description_are_required_and_must_be_concise")
    if not instructions or len(instructions) > 20_000:
        raise ValueError("recipe_instructions_must_be_1_to_20000_characters")
    current = get_recipe(builtin_dir, user_dir, recipe_id)
    version = (current.version + 1) if current else 1
    content = (
        "---\n"
        f"id: {recipe_id}\n"
        f"title: {json.dumps(title, ensure_ascii=False)}\n"
        f"description: {json.dumps(description, ensure_ascii=False)}\n"
        f"version: {version}\n"
        "---\n\n"
        f"{instructions}\n"
    )
    user_dir.mkdir(parents=True, exist_ok=True)
    path = user_dir / f"{recipe_id}.md"
    descriptor, temporary_path = tempfile.mkstemp(prefix=f".{recipe_id}-", suffix=".md", dir=user_dir)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary_path, path)
    except Exception:
        Path(temporary_path).unlink(missing_ok=True)
        raise
    return _parse(path, "user")
