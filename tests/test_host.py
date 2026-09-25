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
        with patch.object(host, "keychain", return_value=None), patch.object(session, "close") as close:
            with self.assertRaisesRegex(host.UserError, "Connect Yahoo Mail first"):
                host.handle_request({"action": "codes"}, session)
            close.assert_called_once()
            self.assertIsNone(session.credentials)

    def test_reused_session_keeps_connection_for_unchanged_account(self):
        credentials = {"email": "test@yahoo.com", "password": "test-password"}
        session = host.MailSession(credentials)
        with patch.object(host, "keychain", return_value=dict(credentials)), patch.object(session, "close") as close, patch.object(host, "check_with_timeout", return_value=[]) as check:
            self.assertEqual(host.handle_request({"action": "codes"}, session), {"codes": []})
            close.assert_not_called()
            check.assert_called_once_with(session)

    def test_whole_check_times_out(self):
        with patch.object(host, "CHECK_TIMEOUT_SECONDS", 0.01), patch.object(
            host.MailSession, "recent_codes", side_effect=lambda: time.sleep(0.2)
        ):
            with self.assertRaisesRegex(host.UserError, "too long"):
                host.check_with_timeout(host.MailSession({}))


if __name__ == "__main__":
    unittest.main()
