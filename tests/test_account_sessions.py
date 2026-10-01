"""Account session coordination and timeout cases."""

from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import account_sessions


class AccountSessionsTests(unittest.TestCase):
    def test_codes_are_labeled_and_sorted_across_accounts(self):
        accounts = [
            {"email": "one@yahoo.com", "password": "old-password"},
            {"email": "two@yahoo.com", "password": "new-password"},
        ]
        with patch.object(account_sessions, "check_with_timeout", side_effect=[
            [{"code": "111111", "receivedAt": 1000, "uid": 1}],
            [{"code": "222222", "receivedAt": 2000, "uid": 1}],
        ]):
            result = account_sessions.AccountSessions().fetch_recent_items(accounts)
        self.assertEqual(
            [item["accountEmail"] for item in result["codes"]],
            ["two@yahoo.com", "one@yahoo.com"],
        )

    def test_switching_to_links_discards_code_scan_state(self):
        accounts = [{"email": "one@yahoo.com", "password": "unused"}]
        sessions = account_sessions.AccountSessions()
        with patch.object(account_sessions, "check_with_timeout", return_value=[]):
            sessions.fetch_recent_items(accounts)
            old = sessions.sessions["one@yahoo.com"]
            with patch.object(old, "close") as close:
                self.assertEqual(sessions.fetch_recent_items(accounts, "links"), {"links": [], "warnings": []})
                close.assert_called_once()
            from link_extraction import extract_link_details
            self.assertIs(sessions.sessions["one@yahoo.com"].extract_details, extract_link_details)

    def test_reset_mode_discards_confirmation_scan_state(self):
        accounts = [{"email": "one@yahoo.com", "password": "unused"}]
        sessions = account_sessions.AccountSessions()
        with patch.object(account_sessions, "check_with_timeout", return_value=[]):
            sessions.fetch_recent_items(accounts, "links")
            old = sessions.sessions["one@yahoo.com"]
            with patch.object(old, "close") as close:
                self.assertEqual(sessions.fetch_recent_items(accounts, "resetLinks"), {"resetLinks": [], "warnings": []})
                close.assert_called_once()
            from link_extraction import extract_password_reset_details
            self.assertIs(sessions.sessions["one@yahoo.com"].extract_details, extract_password_reset_details)

    def test_whole_check_times_out(self):
        with patch.object(account_sessions, "CHECK_TIMEOUT_SECONDS", 0.01), patch.object(
            account_sessions.InboxSession, "recent_items", side_effect=lambda: time.sleep(0.2)
        ):
            with self.assertRaisesRegex(account_sessions.UserError, "too long"):
                account_sessions.check_with_timeout(account_sessions.InboxSession({}))


if __name__ == "__main__":
    unittest.main()
