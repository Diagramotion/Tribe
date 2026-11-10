"""Validation for portable, user-owned design-system snapshots."""

from __future__ import annotations

import re
import io
import json
import zipfile
import base64
import binascii
from typing import Any
from urllib.parse import urlsplit

DESIGN_SYSTEM_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
TOKEN_COLORS = (
    "canvas", "surface", "raised", "text", "muted", "accent", "line",
    "focus", "success", "warning", "danger",
)
PALETTE_ROLES = ("brand", "neutral", "success", "warning", "danger")
PALETTE_STEPS = (50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950)
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_FONT_FAMILY = re.compile(r"^[A-Za-z0-9 ,_'\-]{1,120}$")
_PACKAGE_PATH = re.compile(r'^(?!/)(?!.*\\)(?!.*:)[^\x00-\x1f<>"|?*]{1,240}$')
_PACKAGE_TEXT_SUFFIXES = {".md", ".css", ".json", ".tokens", ".html", ".txt", ".svg", ".license", ".notice"}
_PACKAGE_BINARY_MIME_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
}
_PACKAGE_ARCHIVE_MAX_BYTES = 14_000_000
_PACKAGE_ARCHIVE_MAX_EXPANDED_BYTES = 24_000_000
_PACKAGE_ARCHIVE_MAX_FILES = 200


def _is_license_or_notice_file(path: str) -> bool:
    name = path.rsplit("/", 1)[-1].lower()
    return re.fullmatch(r"(?:licen[cs]e|notice|copying|copyright)(?:[-_.][a-z0-9.-]+)?", name) is not None


def _bounded_text(value: object, field: str, limit: int, *, required: bool = False) -> str:
    if not isinstance(value, str):
        raise ValueError(f"design_system_{field}_invalid")
    text = value.strip()
    if (required and not text) or len(text) > limit:
        raise ValueError(f"design_system_{field}_invalid")
    return text


def validate_design_system(value: object, *, require_id: bool = False) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("design_system_invalid")
    system_id = value.get("id", "")
    if require_id and (not isinstance(system_id, str) or not DESIGN_SYSTEM_ID.fullmatch(system_id)):
        raise ValueError("design_system_id_invalid")
    name = _bounded_text(value.get("name"), "name", 100, required=True)
    description = _bounded_text(value.get("description", ""), "description", 500)
    version = value.get("version", 1)
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError("design_system_version_invalid")
    raw_tokens = value.get("tokens")
    if not isinstance(raw_tokens, dict) or not set(TOKEN_COLORS) <= raw_tokens.keys():
        raise ValueError("design_system_tokens_invalid")
    tokens: dict[str, str] = {}
    for key in TOKEN_COLORS:
        token = raw_tokens.get(key)
        if not isinstance(token, str) or not _HEX_COLOR.fullmatch(token):
            raise ValueError(f"design_system_token_{key}_invalid")
        tokens[key] = token.lower()
    for key, low, high, default in (("radius", 0, 32, "8px"), ("spacing", 2, 32, "8px"), ("fontSize", 12, 20, "14px")):
        raw = raw_tokens.get(key, default)
        if not isinstance(raw, str) or not re.fullmatch(r"\d{1,2}px", raw):
            raise ValueError(f"design_system_token_{key}_invalid")
        number = int(raw[:-2])
        if not low <= number <= high:
            raise ValueError(f"design_system_token_{key}_invalid")
        tokens[key] = f"{number}px"
    font = raw_tokens.get("font", "Inter, system-ui, sans-serif")
    if not isinstance(font, str) or not _FONT_FAMILY.fullmatch(font.strip()):
        raise ValueError("design_system_token_font_invalid")
    tokens["font"] = font.strip()

    raw_palettes = value.get("palettes", {})
    if not isinstance(raw_palettes, dict) or set(raw_palettes) - set(PALETTE_ROLES):
        raise ValueError("design_system_palettes_invalid")
    palettes: dict[str, list[dict[str, Any]]] = {}
    for role, raw_scale in raw_palettes.items():
        if not isinstance(raw_scale, list) or len(raw_scale) != len(PALETTE_STEPS):
            raise ValueError(f"design_system_palette_{role}_invalid")
        scale: list[dict[str, Any]] = []
        for expected_step, shade in zip(PALETTE_STEPS, raw_scale, strict=True):
            if not isinstance(shade, dict) or shade.get("step") != expected_step:
                raise ValueError(f"design_system_palette_{role}_invalid")
            color = shade.get("color")
            if not isinstance(color, str) or not _HEX_COLOR.fullmatch(color):
                raise ValueError(f"design_system_palette_{role}_invalid")
            scale.append({"step": expected_step, "color": color.lower()})
        palettes[role] = scale

    raw_components = value.get("components", {})
    if not isinstance(raw_components, dict):
        raise ValueError("design_system_components_invalid")
    components = {
        key: _bounded_text(raw_components.get(key, ""), f"component_{key}", 800)
        for key in ("button", "card", "input")
    }
    guidance = _bounded_text(value.get("guidance", ""), "guidance", 8000)
    raw_references = value.get("references", [])
    if not isinstance(raw_references, list) or len(raw_references) > 20:
        raise ValueError("design_system_references_invalid")
    references = []
    for reference in raw_references:
        if not isinstance(reference, dict):
            raise ValueError("design_system_reference_invalid")
        url = _bounded_text(reference.get("url"), "reference_url", 2048, required=True)
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("design_system_reference_url_invalid")
        if parsed.username or parsed.password or not parsed.hostname:
            raise ValueError("design_system_reference_url_invalid")
        label = _bounded_text(reference.get("label", ""), "reference_label", 200)
        references.append({"url": url, "label": label})

    source = value.get("source", "user")
    if source not in {"user", "official", "starter", "curated"}:
        raise ValueError("design_system_source_invalid")
    result = {
        **({"id": system_id} if isinstance(system_id, str) and system_id else {}),
        "name": name,
        "description": description,
        "source": source,
        "version": version,
        "tokens": tokens,
        "palettes": palettes,
        "components": components,
        "guidance": guidance,
        "references": references,
    }
    # Preserve the portable package parts used by OpenDesign-style systems.
    # Keep this bounded: package files are guidance, preview fixtures, or
    # explicitly typed image/font assets, never executable application code.
    manifest = value.get("manifest", {})
    if manifest:
        if not isinstance(manifest, dict) or len(manifest) > 40:
            raise ValueError("design_system_manifest_invalid")
        result["manifest"] = manifest
    package_files = value.get("packageFiles", [])
    if not isinstance(package_files, list) or len(package_files) > 200:
        raise ValueError("design_system_package_files_invalid")
    checked_files = []
    total_chars = 0
    for item in package_files:
        if not isinstance(item, dict):
            raise ValueError("design_system_package_file_invalid")
        path = item.get("path")
        content = item.get("content")
        if (not isinstance(path, str) or not _PACKAGE_PATH.fullmatch(path)
                or any(not part or part in {".", ".."} or part.startswith(".") for part in path.split("/"))):
            raise ValueError("design_system_package_path_invalid")
        suffix = "." + path.rsplit(".", 1)[-1].lower() if "." in path else ""
        binary_mime = _PACKAGE_BINARY_MIME_TYPES.get(suffix)
        if (suffix not in _PACKAGE_TEXT_SUFFIXES and not binary_mime and not _is_license_or_notice_file(path)) or not isinstance(content, str):
            raise ValueError("design_system_package_file_invalid")
        if binary_mime:
            prefix = f"data:{binary_mime};base64,"
            encoded = content[len(prefix):] if content.startswith(prefix) else ""
            if not encoded or len(encoded) > 4_000_000:
                raise ValueError("design_system_package_asset_invalid")
            try:
                asset_bytes = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                raise ValueError("design_system_package_asset_invalid") from None
            if len(asset_bytes) > 3_000_000:
                raise ValueError("design_system_package_asset_invalid")
        elif len(content) > 1_000_000:
            raise ValueError("design_system_package_file_invalid")
        total_chars += len(content)
        if total_chars > 12_000_000:
            raise ValueError("design_system_package_too_large")
        checked_files.append({"path": path, "content": content})
    if checked_files:
        result["packageFiles"] = checked_files
    for key, limit in (("category", 80), ("license", 200), ("attribution", 1000), ("sourceUrl", 2048), ("packageVersion", 80), ("sourceLabel", 120)):
        if key in value:
            text = _bounded_text(value[key], key, limit)
            if key == "sourceUrl" and text:
                parsed = urlsplit(text)
                if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or not parsed.hostname:
                    raise ValueError("design_system_source_url_invalid")
            result[key] = text
    tags = value.get("tags", [])
    if not isinstance(tags, list) or len(tags) > 40 or any(not isinstance(tag, str) or len(tag) > 40 for tag in tags):
        raise ValueError("design_system_tags_invalid")
    if tags:
        result["tags"] = list(dict.fromkeys(tag.strip() for tag in tags if tag.strip()))
    return result


def export_design_system_package(value: object) -> bytes:
    """Build a portable OpenDesign-shaped package without executing its fixtures."""
    system = validate_design_system(value)
    files: dict[str, str | bytes] = {}
    for item in system.get("packageFiles", []):
        path = item["path"]
        content = item["content"]
        mime_type = _PACKAGE_BINARY_MIME_TYPES.get("." + path.rsplit(".", 1)[-1].lower())
        if mime_type:
            prefix = f"data:{mime_type};base64,"
            content = base64.b64decode(content[len(prefix):], validate=True)
        files[path] = content
    manifest = system.get("manifest")
    if not isinstance(manifest, dict):
        manifest = {
            "schemaVersion": "tribe-design-system/v1",
            "id": system.get("id", "tribe-system"),
            "name": system["name"],
            "category": system.get("category", "Custom"),
            "description": system["description"],
            "source": {"type": system.get("source", "user"), "origin": system.get("sourceUrl", "Tribe local design system")},
            "license": system.get("license", "Licence not declared"),
            "files": {"design": "DESIGN.md", "tokens": "tokens.css", "components": "components.html"},
            "preview": {"dir": "preview", "pages": []},
        }
    manifest_files = manifest.get("files") if isinstance(manifest.get("files"), dict) else {}
    declared_token_path = (
        manifest_files.get("designTokens") or manifest_files.get("design_tokens")
        or manifest.get("designTokens")
    )
    token_path = declared_token_path if isinstance(declared_token_path, str) and declared_token_path in files else None
    token_path = token_path or ("design-tokens.json" if "design-tokens.json" in files else None)
    token_candidates = [path for path in files if re.search(r"(?:^|/)design[-_.]?tokens?\.tokens(?:\.json)?$", path, re.I)
                        or re.search(r"(?:^|/)[^/]+\.tokens(?:\.json)?$", path, re.I)]
    if not token_path:
        token_path = next((path for path in token_candidates if re.search(r"(?:^|/)design[-_.]?tokens?\.tokens(?:\.json)?$", path, re.I)), None)
    if not token_path and len(token_candidates) == 1:
        token_path = token_candidates[0]
    if not token_path:
        token_path = "design-tokens.json"
        files[token_path] = json.dumps(system["tokens"], ensure_ascii=False, indent=2)
    if declared_token_path != token_path:
        manifest["files"] = {**manifest_files, "designTokens": token_path}
    files["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2)
    files.setdefault("DESIGN.md", system.get("guidance") or f"# {system['name']}\n\n{system['description']}\n")
    files.setdefault("USAGE.md", system.get("guidance") or f"Use the {system['name']} design tokens and component guidance.")
    manifest_source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
    source = (
        system.get("sourceUrl") or manifest.get("sourceUrl") or manifest_source.get("url")
        or manifest_source.get("repository") or manifest_source.get("origin")
        or manifest_source.get("name") or "Not declared"
    )
    license_name = system.get("license") or manifest.get("license") or "Licence not declared"
    attribution = system.get("attribution") or manifest.get("attribution") or ""
    evidence = ["# Source evidence", "", f"- Source: {source}", f"- Licence: {license_name}"]
    if isinstance(attribution, str) and attribution.strip():
        evidence.extend(["", attribution.strip()])
    files.setdefault("source/evidence.md", "\n".join(evidence) + "\n")
    files.setdefault("tokens.css", ":root {\n" + "\n".join(
        f"  --tribe-{re.sub(r'(?<!^)(?=[A-Z])', '-', key).lower()}: {token};"
        for key, token in system["tokens"].items()
    ) + "\n}\n")
    files.setdefault("components.html", (
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>"
        "body{margin:0;padding:24px;font:var(--tribe-font-size) var(--tribe-font);"
        "background:var(--tribe-canvas);color:var(--tribe-text)}"
        "main{display:grid;gap:16px;max-width:680px}section{display:flex;align-items:center;"
        "gap:12px;padding:16px;background:var(--tribe-surface);border:1px solid var(--tribe-line);"
        "border-radius:var(--tribe-radius)}button,input{padding:10px 12px;border:1px solid var(--tribe-line);"
        "border-radius:var(--tribe-radius);background:var(--tribe-raised);color:var(--tribe-text);font:inherit}"
        "button{background:var(--tribe-accent);border-color:var(--tribe-accent);cursor:pointer}"
        ".status{padding:6px 10px;border-radius:999px;background:var(--tribe-success)}"
        "</style></head><body><main><h1>Component preview</h1><section>"
        "<button>Primary action</button><input aria-label=\"Search examples\" placeholder=\"Search examples\">"
        "<span class=\"status\">Ready</span></section></main></body></html>"
    ))
    files["tribe-system.json"] = json.dumps(system, ensure_ascii=False, indent=2)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path, content in files.items():
            if not _PACKAGE_PATH.fullmatch(path) or any(not part or part in {".", ".."} or part.startswith(".") for part in path.split("/")):
                raise ValueError("design_system_package_path_invalid")
            archive.writestr(path, content)
    return output.getvalue()


def read_design_system_package_archive(value: bytes) -> list[dict[str, Any]]:
    """Read a bounded package ZIP into local text and data-URL entries."""
    if not isinstance(value, bytes) or not value:
        raise ValueError("design_system_archive_empty")
    if len(value) > _PACKAGE_ARCHIVE_MAX_BYTES:
        raise OverflowError("design_system_archive_too_large")
    try:
        archive = zipfile.ZipFile(io.BytesIO(value))
    except (zipfile.BadZipFile, OSError):
        raise ValueError("design_system_archive_invalid") from None

    entries = []
    seen: set[str] = set()
    expanded = 0
    with archive:
        infos = [item for item in archive.infolist() if not item.is_dir()]
        if len(infos) > _PACKAGE_ARCHIVE_MAX_FILES:
            raise ValueError("design_system_archive_too_many_files")
        for item in infos:
            path = item.filename
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("design_system_archive_symlink_unsupported")
            if (not isinstance(path, str) or not _PACKAGE_PATH.fullmatch(path)
                    or any(not part or part in {".", ".."} or part.startswith(".") for part in path.split("/"))):
                raise ValueError("design_system_package_path_invalid")
            suffix = "." + path.rsplit(".", 1)[-1].lower() if "." in path else ""
            mime_type = _PACKAGE_BINARY_MIME_TYPES.get(suffix)
            if (suffix not in _PACKAGE_TEXT_SUFFIXES and not mime_type
                    and not _is_license_or_notice_file(path)):
                continue
            if path in seen:
                raise ValueError("design_system_archive_duplicate_path")
            seen.add(path)
            per_file_limit = 12_000_000 if path.rsplit("/", 1)[-1] == "tribe-system.json" else 3_000_000 if mime_type else 1_000_000
            if item.file_size > per_file_limit:
                raise ValueError("design_system_package_file_invalid")
            expanded += item.file_size
            if expanded > _PACKAGE_ARCHIVE_MAX_EXPANDED_BYTES:
                raise ValueError("design_system_archive_too_large")
            try:
                content = archive.read(item)
            except (RuntimeError, zipfile.BadZipFile, OSError):
                raise ValueError("design_system_archive_invalid") from None
            if mime_type:
                encoded = base64.b64encode(content).decode("ascii")
                text = f"data:{mime_type};base64,{encoded}"
            else:
                try:
                    text = content.decode("utf-8")
                except UnicodeDecodeError:
                    raise ValueError("design_system_package_file_encoding_invalid") from None
            entries.append({"path": path, "size": item.file_size, "content": text})
    if not any(item["path"].rsplit("/", 1)[-1] == "manifest.json" for item in entries):
        raise ValueError("design_system_archive_manifest_missing")
    return entries
