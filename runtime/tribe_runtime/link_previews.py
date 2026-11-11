"""Fetch bounded metadata and validated favicons for public chat links."""

from __future__ import annotations

import http.client
import html
import base64
import ipaddress
import socket
import ssl
import threading
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

_MAX_RESPONSE_BYTES = 1_000_000
_CACHE_TTL_SECONDS = 1800
_CACHE_LIMIT = 256
_MAX_FAVICON_BYTES = 64_000
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


class _MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title_parts: list[str] = []
        self.icon_links: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key.lower(): value or "" for key, value in attrs}
        if tag.lower() == "meta":
            key = (attributes.get("property") or attributes.get("name") or "").lower()
            value = attributes.get("content", "").strip()
            if key and value and key not in self.meta:
                self.meta[key] = value
        elif tag.lower() == "link":
            rel = set(attributes.get("rel", "").lower().split())
            href = attributes.get("href", "").strip()
            if href and rel.intersection({"icon", "apple-touch-icon"}) and len(self.icon_links) < 4:
                self.icon_links.append(href)
        elif tag.lower() == "title":
            self.in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title and data.strip():
            self.title_parts.append(data.strip())


def _public_address(host: str, port: int) -> str:
    try:
        literal = ipaddress.ip_address(host)
        addresses = [literal]
    except ValueError:
        try:
            addresses = [ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]
        except (OSError, ValueError):
            raise ValueError("link_host_unavailable") from None
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("link_host_not_public")
    return str(addresses[0])


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, address: str, timeout: float) -> None:
        super().__init__(host, port, timeout=timeout)
        self.address = address

    def connect(self) -> None:
        self.sock = socket.create_connection((self.address, self.port), self.timeout)


class _PinnedHTTPSConnection(_PinnedHTTPConnection):
    def connect(self) -> None:
        raw = socket.create_connection((self.address, self.port), self.timeout)
        try:
            context = ssl.create_default_context()
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            self.sock = context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def _read_resource(
    url: str, *, accepted_types: set[str], accept: str, max_bytes: int,
) -> tuple[str, str, bytes, str] | None:
    current = url
    for _ in range(4):
        if len(current) > 2048:
            return None
        parsed = urlsplit(current)
        scheme = parsed.scheme.lower()
        host = (parsed.hostname or "").lower().rstrip(".")
        if scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
            raise ValueError("invalid_public_link")
        port = parsed.port or (443 if scheme == "https" else 80)
        if port != (443 if scheme == "https" else 80):
            raise ValueError("unsupported_link_port")
        address = _public_address(host, port)
        connection_type = _PinnedHTTPSConnection if scheme == "https" else _PinnedHTTPConnection
        connection = connection_type(host, port, address, timeout=3.5)
        path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        try:
            connection.request("GET", path, headers={
                "Host": f"[{host}]" if ":" in host else host,
                "User-Agent": "TribeLinkPreview/1.0",
                "Accept": accept,
                "Accept-Encoding": "identity",
                "Connection": "close",
            })
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                if not location:
                    return None
                current = urljoin(current, location)
                continue
            content_type = response.getheader("Content-Type", "").lower()
            media_type = content_type.partition(";")[0].strip()
            if response.status < 200 or response.status >= 300 or media_type not in accepted_types:
                return None
            data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                return None
            charset = "utf-8"
            for part in content_type.split(";")[1:]:
                name, _, value = part.strip().partition("=")
                if name == "charset" and value:
                    charset = value.strip("\"'")[:40]
            return media_type, charset, data, current
        except (OSError, http.client.HTTPException, ssl.SSLError):
            return None
        finally:
            connection.close()
    return None


def _read_page(url: str) -> tuple[str, bytes, str] | None:
    resource = _read_resource(
        url,
        accepted_types={"text/html", "application/xhtml+xml"},
        accept="text/html,application/xhtml+xml;q=0.9",
        max_bytes=_MAX_RESPONSE_BYTES,
    )
    if not resource:
        return None
    _, charset, data, final_url = resource
    return charset, data, final_url


def _read_favicon(url: str) -> str | None:
    media_types = {
        "image/png": "png",
        "image/jpeg": "jpeg",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/x-icon": "x-icon",
        "image/vnd.microsoft.icon": "x-icon",
    }
    resource = _read_resource(
        url,
        accepted_types=set(media_types),
        accept="image/png,image/webp,image/x-icon,image/vnd.microsoft.icon,image/gif,image/jpeg;q=0.8",
        max_bytes=_MAX_FAVICON_BYTES,
    )
    if not resource:
        return None
    media_type, _, data, _ = resource
    valid_signature = (
        media_type == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n")
        or media_type == "image/jpeg" and data.startswith(b"\xff\xd8\xff")
        or media_type == "image/webp" and len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"
        or media_type == "image/gif" and data.startswith((b"GIF87a", b"GIF89a"))
        or media_type in {"image/x-icon", "image/vnd.microsoft.icon"} and data.startswith(b"\x00\x00\x01\x00")
    )
    if not valid_signature:
        return None
    return f"data:image/{media_types[media_type]};base64,{base64.b64encode(data).decode('ascii')}"


def link_preview(raw_url: str) -> dict | None:
    if not isinstance(raw_url, str) or len(raw_url) > 2048:
        return None
    try:
        parsed = urlsplit(raw_url.strip())
        host = (parsed.hostname or "").lower().rstrip(".")
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
            return None
        port = parsed.port
        if port not in (None, 80, 443):
            return None
        clean_url = urlunsplit((scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))
    except ValueError:
        return None

    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(clean_url)
        if cached and cached[0] > now:
            return cached[1]

    page = _read_page(clean_url)
    if not page:
        return None
    charset, data, final_url = page
    try:
        source = data.decode(charset, errors="replace")
    except LookupError:
        source = data.decode("utf-8", errors="replace")
    parser = _MetadataParser()
    try:
        parser.feed(source)
    except Exception:
        pass
    metadata = parser.meta
    title = metadata.get("og:title") or metadata.get("twitter:title") or " ".join(parser.title_parts)
    description = metadata.get("og:description") or metadata.get("twitter:description") or metadata.get("description", "")
    preview = {
        "url": clean_url,
        "domain": host.removeprefix("www."),
        "title": html.unescape(title).strip()[:180],
        "description": html.unescape(description).strip()[:320],
    }
    if parser.icon_links:
        preview["faviconDataUrl"] = _read_favicon(urljoin(final_url, parser.icon_links[0]))
    else:
        parsed_final = urlsplit(final_url)
        host = parsed_final.hostname or ""
        root = urlunsplit((parsed_final.scheme, f"[{host}]" if ":" in host else host, "/favicon.ico", "", ""))
        preview["faviconDataUrl"] = _read_favicon(root)
    if not preview["title"] and not preview["description"]:
        return None
    with _cache_lock:
        if len(_cache) >= _CACHE_LIMIT:
            _cache.pop(next(iter(_cache)))
        _cache[clean_url] = (now + _CACHE_TTL_SECONDS, preview)
    return preview
