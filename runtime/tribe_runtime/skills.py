"""Read-only discovery for Agent Skills-compatible Markdown skills."""

from __future__ import annotations

import hashlib
import os
import unicodedata
from dataclasses import dataclass
from pathlib import Path


_PROJECT_SKILL_HOSTS = {
    ".agents": "Agent Skills",
    ".claude": "Claude",
    ".codex": "Codex",
    ".github": "GitHub Copilot",
    ".opencode": "OpenCode",
    ".cursor": "Cursor",
    ".gemini": "Gemini CLI",
}
_SKILL_SCAN_EXCLUDES = {
    ".git", ".hg", ".svn", ".venv", "venv", "node_modules", "vendor",
    "build", "dist", "target", ".next", ".cache", "__pycache__",
}


@dataclass(frozen=True)
class Skill:
    id: str
    name: str
    description: str
    path: str
    source: str


class SkillCatalog:
    def __init__(self, repository: Path):
        home = Path.home()
        codex_home = Path(os.environ.get("CODEX_HOME", home / ".codex")).expanduser()
        claude_home = Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude")).expanduser()
        xdg_config_home = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")).expanduser()
        roots = [(Path(__file__).resolve().parent / "builtin_skills", "Tribe · Built-in")]
        roots.extend(
            (repository / directory / "skills", f"Project · {host}")
            for directory, host in _PROJECT_SKILL_HOSTS.items()
        )
        roots.extend((path, source) for path, source in self._nested_project_roots(repository))
        roots.extend([
            (home / ".agents" / "skills", "User · Agent Skills"),
            (claude_home / "skills", "User · Claude"),
            (codex_home / "skills", "User · Codex"),
            (home / ".copilot" / "skills", "User · GitHub Copilot"),
            (home / ".cursor" / "skills", "User · Cursor"),
            (home / ".gemini" / "skills", "User · Gemini CLI"),
            (xdg_config_home / "opencode" / "skills", "User · OpenCode"),
        ])
        for plugin_root, source in (
            (codex_home / "plugins" / "cache", "User · Codex plugin"),
            (claude_home / "plugins" / "cache", "User · Claude plugin"),
        ):
            roots.extend((path, source) for path in sorted(plugin_root.glob("*/*/*/skills")))
        extra = os.environ.get("AGENT_SKILLS_PATHS", "")
        roots.extend((Path(item).expanduser(), "Configured") for item in extra.split(os.pathsep) if item.strip())
        copilot_extra = os.environ.get("COPILOT_SKILLS_DIRS", "")
        roots.extend((Path(item).expanduser(), "Configured") for item in copilot_extra.split(",") if item.strip())
        resolved_roots = {}
        for path, source in roots:
            if path.is_dir():
                resolved_roots.setdefault(path.resolve(), source)
        self.roots = list(resolved_roots.items())
        self._skills = self._discover()

    @staticmethod
    def _nested_project_roots(repository: Path) -> list[tuple[Path, str]]:
        """Find skills in monorepo packages without walking dependency/build trees."""
        roots: list[tuple[Path, str]] = []
        repository = repository.resolve()
        visited = 0
        for current, directories, _ in os.walk(repository, followlinks=False):
            visited += 1
            if visited > 20_000:
                break
            current_path = Path(current)
            try:
                depth = len(current_path.relative_to(repository).parts)
            except ValueError:
                directories[:] = []
                continue
            if depth >= 12:
                directories[:] = []
            else:
                directories[:] = sorted(
                    directory for directory in directories
                    if directory not in _SKILL_SCAN_EXCLUDES
                    and (not directory.startswith(".") or directory in _PROJECT_SKILL_HOSTS)
                )
            host = _PROJECT_SKILL_HOSTS.get(current_path.name)
            skill_root = current_path / "skills"
            if host and skill_root.is_dir():
                scope = current_path.parent.relative_to(repository).as_posix()
                source = f"Project · {host}" if scope == "." else f"Project · {host} · {scope}"
                roots.append((skill_root, source))
        return roots

    @staticmethod
    def _frontmatter(content: str) -> dict[str, str]:
        if not content.startswith("---\n"):
            return {}
        parts = content.split("---", 2)
        if len(parts) < 3:
            return {}
        fields: dict[str, str] = {}
        lines = parts[1].splitlines()
        index = 0
        while index < len(lines):
            line = lines[index]
            key, separator, value = line.partition(":")
            field = key.strip()
            scalar = value.strip()
            if separator and field in {"name", "description"}:
                if field == "description" and scalar in {">", ">-", ">+", "|", "|-", "|+"}:
                    block: list[str] = []
                    index += 1
                    while index < len(lines):
                        continuation = lines[index]
                        if continuation.strip() and not continuation[0].isspace():
                            break
                        block.append(continuation.strip())
                        index += 1
                    separator_text = "\n" if scalar.startswith("|") else " "
                    fields[field] = separator_text.join(block).strip()
                    continue
                fields[field] = scalar.strip("\"'")
            index += 1
        return fields

    def _discover(self) -> dict[str, Skill]:
        found: dict[str, Skill] = {}
        seen_names: set[str] = set()
        for root, source in self.roots:
            files = sorted({*root.rglob("SKILL.md"), *root.glob("*.md")})
            for file in files:
                try:
                    resolved = file.resolve(strict=True)
                    if not resolved.is_relative_to(root) or resolved.stat().st_size > 250_000:
                        continue
                    fields = self._frontmatter(resolved.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError):
                    continue
                if resolved.name == "SKILL.md" and not (fields.get("name") and fields.get("description")):
                    continue
                if not fields.get("name"):
                    fields["name"] = resolved.parent.name
                if not fields.get("description"):
                    fields["description"] = "No description provided."
                name_key = fields["name"].strip().casefold()
                if name_key in seen_names:
                    continue
                seen_names.add(name_key)
                identifier = hashlib.sha256(str(resolved).encode()).hexdigest()[:20]
                found[identifier] = Skill(identifier, fields["name"], fields["description"], str(resolved), source)
        return found

    @property
    def native_skill_roots(self) -> list[Path]:
        """Roots containing portable directory skills usable by Pydantic AI Harness."""
        skill_paths = [Path(skill.path).resolve() for skill in self._skills.values()
                       if Path(skill.path).name == "SKILL.md"]
        return [root for root, _ in self.roots
                if any(path.is_relative_to(root) for path in skill_paths)]

    @property
    def native_skill_names(self) -> frozenset[str]:
        """Names Harness can load without weakening its Agent Skills validation."""
        names: set[str] = set()
        native_roots = self.native_skill_roots
        for skill in self._skills.values():
            skill_file = Path(skill.path)
            if skill_file.name != "SKILL.md":
                continue
            name = unicodedata.normalize("NFKC", skill.name)
            directory = unicodedata.normalize("NFKC", skill_file.parent.name)
            immediate_child = any(
                skill_file.parent.is_relative_to(root)
                and len(skill_file.parent.relative_to(root).parts) == 1
                for root in native_roots
            )
            if (
                not immediate_child
                or name != directory
                or not name
                or len(name) > 64
                or name != name.lower()
                or name.startswith("-")
                or name.endswith("-")
                or "--" in name
                or not all(character.isalnum() or character == "-" for character in name)
            ):
                continue
            names.add(name)
        return frozenset(names)

    def list(self, query: str = "") -> list[dict[str, str]]:
        normalized = query.casefold().strip()
        skills = self._skills.values()
        if normalized:
            skills = (skill for skill in skills if normalized in f"{skill.name} {skill.description} {skill.source}".casefold())
        return [skill.__dict__ for skill in sorted(skills, key=lambda item: (item.name.casefold(), item.source))]

    def find_builtin(self, name: str) -> Skill | None:
        normalized = name.casefold().strip()
        return next((skill for skill in self._skills.values()
                     if skill.source == "Tribe · Built-in" and skill.name.casefold() == normalized), None)

    def read(self, skill_id: str) -> str:
        skill = self._skills.get(skill_id)
        if not skill:
            raise KeyError("skill_not_found")
        return Path(skill.path).read_text(encoding="utf-8")

    def list_resources(self, skill_id: str) -> list[str]:
        skill = self._skills.get(skill_id)
        if not skill:
            raise KeyError("skill_not_found")
        skill_file = Path(skill.path)
        if skill_file.name != "SKILL.md":
            return []
        root = skill_file.parent.resolve()
        resources = []
        try:
            for file in root.rglob("*"):
                if not file.is_file() or file.name == "SKILL.md":
                    continue
                try:
                    resolved = file.resolve(strict=True)
                    if (not resolved.is_relative_to(root) or resolved.stat().st_size > 250_000
                            or any(part.startswith(".") for part in file.relative_to(root).parts)):
                        continue
                except OSError:
                    continue
                resources.append(file.relative_to(root).as_posix())
                if len(resources) >= 500:
                    break
        except OSError:
            return []
        return sorted(resources)

    def read_resource(self, skill_id: str, relative_path: str) -> str:
        skill = self._skills.get(skill_id)
        if not skill:
            raise KeyError("skill_not_found")
        skill_file = Path(skill.path)
        if skill_file.name != "SKILL.md":
            raise ValueError("resources_are_available_only_for_directory_skills")
        requested = Path(relative_path)
        if (requested.is_absolute() or not relative_path.strip() or ".." in requested.parts
                or any(part.startswith(".") for part in requested.parts)):
            raise ValueError("invalid_skill_resource_path")
        root = skill_file.parent.resolve()
        try:
            resolved = (root / requested).resolve(strict=True)
            if not resolved.is_relative_to(root) or not resolved.is_file():
                raise ValueError("skill_resource_outside_skill_directory")
            if resolved.stat().st_size > 100_000:
                raise ValueError("skill_resource_too_large")
            return resolved.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("skill_resource_is_not_utf8_text") from error
