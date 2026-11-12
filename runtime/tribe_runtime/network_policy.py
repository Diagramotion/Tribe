"""Shared checks for the small set of hosts that are safe for cleartext HTTP."""

from __future__ import annotations

import ipaddress


def is_loopback_hostname(hostname: str | None) -> bool:
    if not isinstance(hostname, str) or not hostname:
        return False
    host = hostname.strip().lower().strip("[]").rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
