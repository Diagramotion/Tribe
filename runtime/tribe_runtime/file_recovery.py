"""Helpers for verifying repository writes after an interrupted agent run."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def expected_file_hash(path: Path, diff: str, *, truncated: bool) -> str | None:
    """Apply a complete unified text diff in memory and return the expected hash.

    Any malformed, truncated, binary, or conflicting diff stays unverifiable so
    recovery fails closed. The repository file itself is never modified here.
    """
    if truncated or not diff:
        return None
    try:
        if path.exists():
            if not path.is_file() or path.stat().st_size > 1_000_000:
                return None
            original = path.read_text(encoding="utf-8").splitlines(keepends=True)
        else:
            original = []
    except (OSError, UnicodeError):
        return None

    patch_lines = diff.splitlines(keepends=True)
    output: list[str] = []
    source_index = 0
    hunk_count = 0
    index = 0
    while index < len(patch_lines):
        match = _HUNK.match(patch_lines[index])
        if not match:
            index += 1
            continue
        hunk_count += 1
        old_start, old_count = int(match.group(1)), int(match.group(2) or 1)
        target_index = old_start if old_count == 0 else old_start - 1
        if target_index < source_index or target_index > len(original):
            return None
        output.extend(original[source_index:target_index])
        source_index = target_index
        index += 1
        old_consumed = 0
        new_consumed = 0
        previous_marker = None
        while index < len(patch_lines) and not patch_lines[index].startswith("@@ "):
            line = patch_lines[index]
            if line.startswith("\\ No newline at end of file"):
                if previous_marker in {" ", "+"}:
                    if not output:
                        return None
                    output[-1] = output[-1].removesuffix("\n").removesuffix("\r")
                index += 1
                continue
            if not line or line[0] not in " +-":
                if line.startswith(("--- ", "+++ ")):
                    break
                return None
            marker, content = line[0], line[1:]
            if marker in " -":
                if source_index >= len(original) or original[source_index] != content:
                    return None
                source_index += 1
                old_consumed += 1
            if marker in " +":
                output.append(content)
                new_consumed += 1
            previous_marker = marker
            index += 1
        if old_consumed != old_count:
            return None
        new_count = int(match.group(4) or 1)
        if new_consumed != new_count:
            return None
    if hunk_count == 0:
        return None
    output.extend(original[source_index:])
    return hashlib.sha256("".join(output).encode("utf-8")).hexdigest()
