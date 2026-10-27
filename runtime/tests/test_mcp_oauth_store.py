from __future__ import annotations

import asyncio
import multiprocessing
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import keyring

from tribe_runtime.oauth_store import OAuthKeyringStore
from tribe_runtime.oauth_lock import OAuthConnectionLease


def _try_oauth_lease_in_child(lock_directory: str, result_queue) -> None:
    async def attempt() -> None:
        lease = OAuthConnectionLease(Path(lock_directory), "project-a", "github", "https://mcp.example")
        try:
            async with lease.hold(timeout=0.25):
                result_queue.put("acquired")
        except TimeoutError:
            result_queue.put("timed_out")

    asyncio.run(attempt())


class OAuthKeyringStoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.values: dict[tuple[str, str], str] = {}
        self.patches = [
            patch("keyring.get_password", side_effect=self._get),
            patch("keyring.set_password", side_effect=self._set),
            patch("keyring.delete_password", side_effect=self._delete),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def _get(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def _set(self, service: str, account: str, value: str) -> None:
        self.values[(service, account)] = value

    def _delete(self, service: str, account: str) -> None:
        if (service, account) not in self.values:
            raise keyring.errors.PasswordDeleteError
        del self.values[(service, account)]

    async def test_records_survive_adapter_recreation_but_are_scoped_to_connection(self) -> None:
        first = OAuthKeyringStore("project-a", "github")
        await first.put("https://mcp.example/tokens", {"access_token": "token-a"}, collection="tokens")

        restarted = OAuthKeyringStore("project-a", "github")
        other_server = OAuthKeyringStore("project-a", "linear")
        other_project = OAuthKeyringStore("project-b", "github")
        other_workspace = OAuthKeyringStore("project-a", "github", workspace_id="other-workspace")

        self.assertEqual(
            await restarted.get("https://mcp.example/tokens", collection="tokens"),
            {"access_token": "token-a"},
        )
        self.assertIsNone(await other_server.get("https://mcp.example/tokens", collection="tokens"))
        self.assertIsNone(await other_project.get("https://mcp.example/tokens", collection="tokens"))
        self.assertIsNone(await other_workspace.get("https://mcp.example/tokens", collection="tokens"))
        self.assertTrue(all("token-a" not in account for _, account in self.values))

    async def test_ttl_expires_records_and_reports_remaining_lifetime(self) -> None:
        now = [100.0]
        store = OAuthKeyringStore("project-a", "github", clock=lambda: now[0])
        await store.put("token", {"access_token": "secret"}, collection="tokens", ttl=30)

        value, remaining = await store.ttl("token", collection="tokens")
        self.assertEqual(value, {"access_token": "secret"})
        self.assertEqual(remaining, 30)

        now[0] = 131
        self.assertIsNone(await store.get("token", collection="tokens"))

    async def test_bulk_operations_match_async_key_value_contract(self) -> None:
        store = OAuthKeyringStore("project-a", "github")
        await store.put_many(["a", "b"], [{"v": 1}, {"v": 2}], collection="client")

        self.assertEqual(await store.get_many(["a", "missing", "b"], collection="client"), [
            {"v": 1}, None, {"v": 2},
        ])
        self.assertEqual(await store.delete_many(["a", "missing", "b"], collection="client"), 2)
        with self.assertRaisesRegex(ValueError, "must_match"):
            await store.put_many(["one"], [], collection="client")

    async def test_unavailable_keychain_fails_closed_without_returning_credentials(self) -> None:
        store = OAuthKeyringStore("project-a", "github")
        with patch("keyring.get_password", side_effect=keyring.errors.KeyringError("backend locked")):
            with self.assertRaisesRegex(RuntimeError, "OS credential storage is unavailable") as raised:
                await store.get("token", collection="tokens")
        self.assertNotIn("backend locked", str(raised.exception))

    async def test_store_rejects_empty_connection_identity(self) -> None:
        with self.assertRaisesRegex(ValueError, "project_and_server_required"):
            OAuthKeyringStore("", "github")


class OAuthConnectionLeaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_connection_serializes_threads_and_releases_after_cancellation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lease = OAuthConnectionLease(Path(directory), "project-a", "github", "https://mcp.example")
            active = 0
            max_active = 0
            counts_guard = threading.Lock()

            async def use_connection() -> None:
                nonlocal active, max_active
                async with lease.hold(timeout=2):
                    with counts_guard:
                        active += 1
                        max_active = max(max_active, active)
                    await asyncio.sleep(0.03)
                    with counts_guard:
                        active -= 1

            await asyncio.gather(*(asyncio.to_thread(asyncio.run, use_connection()) for _ in range(4)))
            self.assertEqual(max_active, 1)

            async with lease.hold():
                waiting = asyncio.create_task(use_connection())
                await asyncio.sleep(0.03)
                waiting.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await waiting

            async with lease.hold(timeout=1):
                pass

    async def test_separate_process_cannot_hold_same_connection_lease(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lease = OAuthConnectionLease(Path(directory), "project-a", "github", "https://mcp.example")
            context = multiprocessing.get_context("spawn")
            result_queue = context.Queue()
            process = context.Process(target=_try_oauth_lease_in_child, args=(directory, result_queue))
            async with lease.hold():
                process.start()
                result = await asyncio.wait_for(asyncio.to_thread(result_queue.get), timeout=10)
            process.join(timeout=10)
            self.assertFalse(process.is_alive())
            self.assertEqual(process.exitcode, 0)
            self.assertEqual(result, "timed_out")


if __name__ == "__main__":
    unittest.main()
