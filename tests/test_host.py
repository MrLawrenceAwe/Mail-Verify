"""Native messaging and request dispatch cases."""

import io
import json
import copy
from pathlib import Path
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import host
import account_scan_manager


class HostTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        lock_patch = patch.object(host, "ACCOUNT_LOCK_PATH", Path(temporary.name) / "accounts.lock")
        lock_patch.start()
        self.addCleanup(lock_patch.stop)

    def test_collection_request_does_not_start_new_mail_scans(self):
        credentials = {"email": "test@yahoo.com", "password": "unused"}
        sessions = account_scan_manager.AccountScanManager()
        with patch.object(host, "keychain", return_value={"accounts": [credentials]}), patch.object(account_scan_manager, "scan_with_deadline") as fetch:
            try:
                response = host.handle_request({"action": "codes", "collectOnly": True}, sessions)
                self.assertEqual(response, {"codes": [], "warnings": [], "scanPending": False})
                fetch.assert_not_called()
            finally:
                sessions.close()

    def test_reset_links_dispatches_to_reset_extractor(self):
        credentials = {"email": "test@yahoo.com", "password": "unused"}
        sessions = account_scan_manager.AccountScanManager()
        item = {"url": "https://example.com/reset", "receivedAt": 1000, "uid": 1}
        with patch.object(host, "keychain", return_value={"accounts": [credentials]}), patch.object(account_scan_manager, "scan_with_deadline", return_value=[item]):
            result = host.handle_request({"action": "passwordResetLinks"}, sessions)
        self.assertEqual(result, {"passwordResetLinks": [{**item, "accountEmail": credentials["email"]}], "warnings": [], "scanPending": False})
        from link_extraction import extract_password_reset_link_details
        self.assertIs(sessions.sessions[credentials["email"]].extract_item, extract_password_reset_link_details)

    def test_non_string_actions_are_rejected_as_unsupported(self):
        for action in (None, [], {}):
            with self.subTest(action=action), self.assertRaisesRegex(host.UserError, "Unsupported request"):
                host.handle_request({"action": action}, account_scan_manager.AccountScanManager())

    def test_frame(self):
        p = json.dumps({"action": "status"}).encode()
        self.assertEqual(
            host.read_message(io.BytesIO(struct.pack("=I", len(p)) + p)),
            {"action": "status"},
        )

    def test_large_frame_rejected(self):
        with self.assertRaises(ValueError):
            host.read_message(io.BytesIO(struct.pack("=I", 20000)))

    def test_truncated_frame_rejected(self):
        with self.assertRaises(ValueError):
            host.read_message(io.BytesIO(struct.pack("=I", 10) + b"{}"))

    def test_save_account_does_not_store_failed_login(self):
        with patch.object(
            host, "connect_imap", side_effect=host.imaplib.IMAP4.error()
        ), patch.object(host, "keychain") as keychain:
            with self.assertRaises(host.imaplib.IMAP4.error):
                host.handle_request(
                    {
                        "action": "saveAccount",
                        "email": "test@yahoo.com",
                        "password": "abcdefghijklmnop",
                    },
                    account_scan_manager.AccountScanManager(),
                )
            keychain.assert_not_called()

    def test_reused_session_notices_account_removal(self):
        credentials = {"email": "test@yahoo.com", "password": "test-password"}
        session = account_scan_manager.InboxSession(credentials)
        sessions = account_scan_manager.AccountScanManager()
        sessions.sessions["test@yahoo.com"] = session
        with patch.object(host, "keychain", return_value=None), patch.object(session, "close") as close:
            with self.assertRaisesRegex(host.UserError, "Connect Yahoo Mail first"):
                host.handle_request({"action": "codes"}, sessions)
            # Account cleanup occurs when the next scan sees the changed list.
            sessions.poll_accounts([])
            close.assert_called_once()

    def test_reused_session_keeps_connection_for_unchanged_account(self):
        credentials = {"email": "test@yahoo.com", "password": "test-password"}
        session = account_scan_manager.InboxSession(credentials)
        sessions = account_scan_manager.AccountScanManager()
        sessions.sessions["test@yahoo.com"] = session
        with patch.object(host, "keychain", return_value={"accounts": [dict(credentials)]}), patch.object(session, "close") as close, patch.object(account_scan_manager, "scan_with_deadline", return_value=[]) as check:
            self.assertEqual(host.handle_request({"action": "codes"}, sessions), {"codes": [], "warnings": [], "scanPending": False})
            close.assert_not_called()
            check.assert_called_once_with(session)

    def test_add_second_account_preserves_first(self):
        first = {"email": "one@yahoo.com", "password": "old-password"}
        second = {"email": "two@yahoo.com", "password": "new-password"}
        sessions = account_scan_manager.AccountScanManager()
        with patch.object(host, "keychain", return_value=first) as keychain, patch.object(host, "connect_imap") as connect:
            connect.return_value.__enter__.return_value = None
            result = host.handle_request({"action": "saveAccount", **second}, sessions)
            self.assertEqual(result["accountEmails"], ["one@yahoo.com", "two@yahoo.com"])
            keychain.assert_any_call("set", {"accounts": [first, second]})

    def test_remove_only_selected_account(self):
        accounts = [{"email": "one@yahoo.com", "password": "password-one"}, {"email": "two@yahoo.com", "password": "password-two"}]
        with patch.object(host, "keychain", return_value={"accounts": accounts}) as keychain:
            result = host.handle_request({"action": "removeAccount", "email": "one@yahoo.com"}, account_scan_manager.AccountScanManager())
            self.assertEqual(result, {"accountEmails": ["two@yahoo.com"]})
            keychain.assert_any_call("set", {"accounts": [accounts[1]]})

    def test_overlapping_add_and_remove_preserve_the_final_account_list(self):
        first = {"email": "one@yahoo.com", "password": "old-password"}
        second = {"email": "two@yahoo.com", "password": "new-password"}
        saved = {"accounts": [first]}
        first_read = threading.Event()
        release_first_read = threading.Event()
        second_started = threading.Event()
        second_read = threading.Event()
        results = []

        def keychain(action, value=None):
            nonlocal saved
            if action == "get":
                if not first_read.is_set():
                    snapshot = copy.deepcopy(saved)
                    first_read.set()
                    self.assertTrue(release_first_read.wait(2))
                    return snapshot
                second_read.set()
                return copy.deepcopy(saved)
            if action == "set":
                saved = copy.deepcopy(value)
            elif action == "delete":
                saved = None

        def add():
            results.append(host.handle_request({"action": "saveAccount", **second}, account_scan_manager.AccountScanManager()))

        def remove():
            second_started.set()
            results.append(host.handle_request({"action": "removeAccount", "email": first["email"]}, account_scan_manager.AccountScanManager()))

        with patch.object(host, "keychain", side_effect=keychain), patch.object(host, "connect_imap") as connect:
            connect.return_value.__enter__.return_value = None
            add_thread = threading.Thread(target=add)
            remove_thread = threading.Thread(target=remove)
            add_thread.start()
            try:
                self.assertTrue(first_read.wait(2))
                remove_thread.start()
                self.assertTrue(second_started.wait(2))
                self.assertFalse(second_read.wait(0.1), "the second request must wait for the first write")
            finally:
                release_first_read.set()
                add_thread.join(2)
                if remove_thread.ident is not None:
                    remove_thread.join(2)

        self.assertFalse(add_thread.is_alive() or remove_thread.is_alive())
        self.assertEqual(saved, {"accounts": [second]})
        self.assertEqual(len(results), 2)

if __name__ == "__main__":
    unittest.main()
