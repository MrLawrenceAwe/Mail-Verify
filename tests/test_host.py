"""Native messaging and request dispatch cases."""

import io
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import host
import account_sessions


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
                    account_sessions.AccountSessions(),
                )
            keychain.assert_not_called()

    def test_reused_session_notices_account_removal(self):
        credentials = {"email": "test@yahoo.com", "password": "test-password"}
        session = account_sessions.InboxSession(credentials)
        sessions = account_sessions.AccountSessions()
        sessions.sessions["test@yahoo.com"] = session
        with patch.object(host, "keychain", return_value=None), patch.object(session, "close") as close:
            with self.assertRaisesRegex(host.UserError, "Connect Yahoo Mail first"):
                host.handle_request({"action": "codes"}, sessions)
            # Account cleanup occurs when the next scan sees the changed list.
            sessions.fetch_recent_codes([])
            close.assert_called_once()

    def test_reused_session_keeps_connection_for_unchanged_account(self):
        credentials = {"email": "test@yahoo.com", "password": "test-password"}
        session = account_sessions.InboxSession(credentials)
        sessions = account_sessions.AccountSessions()
        sessions.sessions["test@yahoo.com"] = session
        with patch.object(host, "keychain", return_value={"accounts": [dict(credentials)]}), patch.object(session, "close") as close, patch.object(account_sessions, "check_with_timeout", return_value=[]) as check:
            self.assertEqual(host.handle_request({"action": "codes"}, sessions), {"codes": [], "warnings": []})
            close.assert_not_called()
            check.assert_called_once_with(session)

    def test_add_second_account_preserves_first(self):
        first = {"email": "one@yahoo.com", "password": "old-password"}
        second = {"email": "two@yahoo.com", "password": "new-password"}
        sessions = account_sessions.AccountSessions()
        with patch.object(host, "keychain", return_value=first) as keychain, patch.object(host, "connect_imap") as connect:
            connect.return_value.__enter__.return_value = None
            result = host.handle_request({"action": "saveAccount", **second}, sessions)
            self.assertEqual(result["accountEmails"], ["one@yahoo.com", "two@yahoo.com"])
            keychain.assert_any_call("set", {"accounts": [first, second]})

    def test_remove_only_selected_account(self):
        accounts = [{"email": "one@yahoo.com", "password": "password-one"}, {"email": "two@yahoo.com", "password": "password-two"}]
        with patch.object(host, "keychain", return_value={"accounts": accounts}) as keychain:
            result = host.handle_request({"action": "removeAccount", "email": "one@yahoo.com"}, account_sessions.AccountSessions())
            self.assertEqual(result, {"accountEmails": ["two@yahoo.com"]})
            keychain.assert_any_call("set", {"accounts": [accounts[1]]})

if __name__ == "__main__":
    unittest.main()
