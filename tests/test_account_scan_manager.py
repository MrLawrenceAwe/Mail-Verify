"""Account session coordination and timeout cases."""

from pathlib import Path
import sys
import time
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import account_scan_manager


class AccountScanManagerTests(unittest.TestCase):
    def test_pending_scan_is_reported_until_completed_results_are_collected(self):
        release = threading.Event()
        sessions = account_scan_manager.AccountScanManager()
        accounts = [{"email": "test@yahoo.com", "password": "unused"}]
        def fetch(_session):
            release.wait(2)
            return [{"code": "123456", "receivedAt": int(time.time() * 1000), "uid": 1}]
        with patch.object(account_scan_manager, "scan_with_deadline", side_effect=fetch):
            try:
                response = sessions.poll_accounts(accounts)
                self.assertEqual(response["codes"], [])
                self.assertTrue(response["scanPending"])
                release.set()
                sessions.pending_scans[accounts[0]["email"]].result(timeout=2)
                response = sessions.poll_accounts(accounts, collect_only=True)
                self.assertFalse(response["scanPending"])
                self.assertEqual(len(response["codes"]), 1)
            finally:
                release.set()
                sessions.close()

    def test_collection_polls_do_not_restart_completed_accounts(self):
        release = threading.Event()
        sessions = account_scan_manager.AccountScanManager()
        accounts = [{"email": "slow@yahoo.com", "password": "unused"},
                    {"email": "healthy@yahoo.com", "password": "unused"}]
        calls = []
        def fetch(session):
            calls.append(session.credentials["email"])
            if session.credentials["email"].startswith("slow"):
                release.wait(2)
            return [{"code": "123456", "receivedAt": int(time.time() * 1000), "uid": 1}]
        with patch.object(account_scan_manager, "scan_with_deadline", side_effect=fetch):
            try:
                first = sessions.poll_accounts(accounts)
                self.assertTrue(first["scanPending"])
                self.assertEqual(len(first["codes"]), 1)
                second = sessions.poll_accounts(accounts, collect_only=True)
                self.assertTrue(second["scanPending"])
                self.assertEqual(calls.count("healthy@yahoo.com"), 1)
                release.set()
                sessions.pending_scans["slow@yahoo.com"].result(timeout=2)
                final = sessions.poll_accounts(accounts, collect_only=True)
                self.assertFalse(final["scanPending"])
                self.assertEqual(len(final["codes"]), 2)
                self.assertEqual(len(calls), 2)
                sessions.poll_accounts(accounts)
                self.assertEqual(len(calls), 4)
            finally:
                release.set()
                sessions.close()

    def test_collecting_without_pending_work_does_not_start_a_scan(self):
        sessions = account_scan_manager.AccountScanManager()
        accounts = [{"email": "test@yahoo.com", "password": "unused"}]
        with patch.object(account_scan_manager, "scan_with_deadline") as fetch:
            try:
                response = sessions.poll_accounts(accounts, collect_only=True)
                self.assertEqual(response, {"codes": [], "warnings": [], "scanPending": False})
                fetch.assert_not_called()
            finally:
                sessions.close()

    def test_codes_are_labeled_and_sorted_across_accounts(self):
        accounts = [
            {"email": "one@yahoo.com", "password": "old-password"},
            {"email": "two@yahoo.com", "password": "new-password"},
        ]
        with patch.object(account_scan_manager, "scan_with_deadline", side_effect=[
            [{"code": "111111", "receivedAt": 1000, "uid": 1}],
            [{"code": "222222", "receivedAt": 2000, "uid": 1}],
        ]):
            result = account_scan_manager.AccountScanManager().poll_accounts(accounts)
        self.assertEqual(
            [item["accountEmail"] for item in result["codes"]],
            ["two@yahoo.com", "one@yahoo.com"],
        )

    def test_switching_to_links_discards_code_scan_state(self):
        accounts = [{"email": "one@yahoo.com", "password": "unused"}]
        sessions = account_scan_manager.AccountScanManager()
        with patch.object(account_scan_manager, "scan_with_deadline", return_value=[]):
            sessions.poll_accounts(accounts)
            old = sessions.sessions["one@yahoo.com"]
            with patch.object(old, "close") as close:
                self.assertEqual(sessions.poll_accounts(accounts, "confirmationLinks"), {"confirmationLinks": [], "warnings": [], "scanPending": False})
                close.assert_called_once()
            from link_extraction import extract_confirmation_link_details
            self.assertIs(sessions.sessions["one@yahoo.com"].extract_item, extract_confirmation_link_details)

    def test_reset_mail_type_discards_confirmation_scan_state(self):
        accounts = [{"email": "one@yahoo.com", "password": "unused"}]
        sessions = account_scan_manager.AccountScanManager()
        with patch.object(account_scan_manager, "scan_with_deadline", return_value=[]):
            sessions.poll_accounts(accounts, "confirmationLinks")
            old = sessions.sessions["one@yahoo.com"]
            with patch.object(old, "close") as close:
                self.assertEqual(sessions.poll_accounts(accounts, "passwordResetLinks"), {"passwordResetLinks": [], "warnings": [], "scanPending": False})
                close.assert_called_once()
            from link_extraction import extract_password_reset_link_details
            self.assertIs(sessions.sessions["one@yahoo.com"].extract_item, extract_password_reset_link_details)

    def test_account_scan_times_out(self):
        with patch.object(account_scan_manager, "ACCOUNT_CHECK_TIMEOUT_SECONDS", 0.01), patch.object(
            account_scan_manager.InboxSession, "scan_inbox", side_effect=lambda: time.sleep(0.2)
        ):
            with self.assertRaisesRegex(account_scan_manager.UserError, "too long"):
                account_scan_manager.scan_with_deadline(account_scan_manager.InboxSession({}))

    def test_slow_account_does_not_delay_healthy_results_or_overlap_scans(self):
        release = threading.Event()
        started = threading.Event()
        calls = []
        accounts = [{"email": "slow@yahoo.com", "password": "unused"},
                    {"email": "healthy@yahoo.com", "password": "unused"}]
        def fetch(session):
            email = session.credentials["email"]
            calls.append(email)
            if email.startswith("slow"):
                started.set()
                release.wait(2)
            return [{"code": "123456", "receivedAt": int(time.time() * 1000), "uid": 1}]
        sessions = account_scan_manager.AccountScanManager()
        with patch.object(account_scan_manager, "scan_with_deadline", side_effect=fetch):
            try:
                first = sessions.poll_accounts(accounts)
                self.assertTrue(started.is_set())
                self.assertFalse(release.is_set())
                self.assertEqual([x["accountEmail"] for x in first["codes"]], ["healthy@yahoo.com"])
                second = sessions.poll_accounts(accounts)
                self.assertEqual(calls.count("slow@yahoo.com"), 1)
                self.assertEqual(len(second["codes"]), 1)
                release.set()
                sessions.pending_scans["slow@yahoo.com"].result(timeout=2)
                final = sessions.poll_accounts(accounts)
                self.assertEqual({x["accountEmail"] for x in final["codes"]},
                                 {"slow@yahoo.com", "healthy@yahoo.com"})
            finally:
                release.set()
                sessions.close()

    def test_removal_defers_close_until_worker_finishes_and_discards_results(self):
        release = threading.Event()
        sessions = account_scan_manager.AccountScanManager()
        account = {"email": "test@yahoo.com", "password": "unused"}
        with patch.object(account_scan_manager, "scan_with_deadline", side_effect=lambda _: release.wait(2)):
            try:
                sessions.poll_accounts([account])
                session = sessions.sessions[account["email"]]
                future = sessions.pending_scans[account["email"]]
                closed = threading.Event()
                with patch.object(session, "close", side_effect=closed.set):
                    sessions.remove(account["email"])
                    self.assertFalse(closed.is_set())
                    release.set()
                    self.assertTrue(closed.wait(2))
                self.assertNotIn(account["email"], sessions.sessions)
                self.assertFalse(sessions.cached_results_by_account)
                self.assertTrue(future.done())
            finally:
                release.set()
                sessions.close()

    def test_account_concurrency_is_bounded_and_type_change_discards_old_work(self):
        release = threading.Event()
        started = threading.Condition()
        calls = []
        sessions = account_scan_manager.AccountScanManager()
        accounts = [{"email": f"{index}@yahoo.com", "password": "unused"} for index in range(6)]
        def fetch(session):
            with started:
                calls.append(session)
                started.notify_all()
            release.wait(2)
            return [{"code": "123456", "receivedAt": int(time.time() * 1000), "uid": 1}]
        with patch.object(account_scan_manager, "scan_with_deadline", side_effect=fetch):
            try:
                self.assertEqual(sessions.poll_accounts(accounts)["codes"], [])
                with started:
                    self.assertTrue(started.wait_for(lambda: len(calls) == 4, timeout=2))
                old_executor = sessions.executor
                old_sessions = set(sessions.sessions.values())
                self.assertEqual(sessions.poll_accounts(accounts[:1], "confirmationLinks")["confirmationLinks"], [])
                self.assertIs(sessions.executor, old_executor)
                self.assertEqual(len(calls), 4)
                release.set()
                sessions.pending_scans[accounts[0]["email"]].result(timeout=2)
                result = sessions.poll_accounts(accounts[:1], "confirmationLinks")
                self.assertEqual(len(result["confirmationLinks"]), 1)
                self.assertFalse(old_sessions.intersection(sessions.sessions.values()))
            finally:
                release.set()
                sessions.close()


if __name__ == "__main__":
    unittest.main()
