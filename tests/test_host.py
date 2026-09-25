"""Native messaging and request dispatch cases."""

import io
import json
from pathlib import Path
import struct
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import host


class HostTests(unittest.TestCase):
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

    def test_configure_does_not_store_failed_login(self):
        with patch.object(
            host, "connect_imap", side_effect=host.imaplib.IMAP4.error()
        ), patch.object(host, "keychain") as keychain:
            with self.assertRaises(host.imaplib.IMAP4.error):
                host.handle_request(
                    {
                        "action": "configure",
                        "email": "test@yahoo.com",
                        "password": "abcdefghijklmnop",
                    },
                    host.MailSession(None),
                )
            keychain.assert_not_called()

    def test_reused_session_notices_account_removal(self):
        credentials = {"email": "test@yahoo.com", "password": "test-password"}
        session = host.MailSession(credentials)
        sessions = host.AccountSessions()
        sessions.sessions["test@yahoo.com"] = session
        with patch.object(host, "keychain", return_value=None), patch.object(session, "close") as close:
            with self.assertRaisesRegex(host.UserError, "Connect Yahoo Mail first"):
                host.handle_request({"action": "codes"}, sessions)
            # Account cleanup occurs when the next scan sees the changed list.
            sessions.codes([])
            close.assert_called_once()

    def test_reused_session_keeps_connection_for_unchanged_account(self):
        credentials = {"email": "test@yahoo.com", "password": "test-password"}
        session = host.MailSession(credentials)
        sessions = host.AccountSessions()
        sessions.sessions["test@yahoo.com"] = session
        with patch.object(host, "keychain", return_value={"accounts": [dict(credentials)]}), patch.object(session, "close") as close, patch.object(host, "check_with_timeout", return_value=[]) as check:
            self.assertEqual(host.handle_request({"action": "codes"}, sessions), {"codes": [], "warnings": []})
            close.assert_not_called()
            check.assert_called_once_with(session)

    def test_add_second_account_preserves_first_and_labels_codes(self):
        first = {"email": "one@yahoo.com", "password": "old-password"}
        second = {"email": "two@yahoo.com", "password": "new-password"}
        sessions = host.AccountSessions()
        with patch.object(host, "keychain", return_value=first) as keychain, patch.object(host, "connect_imap") as connect:
            connect.return_value.__enter__.return_value = None
            result = host.handle_request({"action": "configure", **second}, sessions)
            self.assertEqual(result["accounts"], ["one@yahoo.com", "two@yahoo.com"])
            keychain.assert_any_call("set", {"accounts": [first, second]})
        with patch.object(host, "check_with_timeout", side_effect=[
            [{"code": "111111", "receivedAt": 1000, "uid": 1}],
            [{"code": "222222", "receivedAt": 2000, "uid": 1}],
        ]):
            result = sessions.codes([first, second])
        self.assertEqual([item["accountEmail"] for item in result["codes"]], ["two@yahoo.com", "one@yahoo.com"])

    def test_remove_only_selected_account(self):
        accounts = [{"email": "one@yahoo.com", "password": "password-one"}, {"email": "two@yahoo.com", "password": "password-two"}]
        with patch.object(host, "keychain", return_value={"accounts": accounts}) as keychain:
            result = host.handle_request({"action": "disconnect", "email": "one@yahoo.com"}, host.AccountSessions())
            self.assertEqual(result, {"accounts": ["two@yahoo.com"]})
            keychain.assert_any_call("set", {"accounts": [accounts[1]]})

    def test_whole_check_times_out(self):
        with patch.object(host, "CHECK_TIMEOUT_SECONDS", 0.01), patch.object(
            host.MailSession, "recent_codes", side_effect=lambda: time.sleep(0.2)
        ):
            with self.assertRaisesRegex(host.UserError, "too long"):
                host.check_with_timeout(host.MailSession({}))


if __name__ == "__main__":
    unittest.main()
