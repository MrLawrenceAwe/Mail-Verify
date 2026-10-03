"""Coordinate bounded background scans across connected Yahoo accounts."""

import imaplib
import time
from concurrent.futures import ThreadPoolExecutor, wait

from errors import UserError
from inbox_session import InboxSession, MAX_MESSAGE_AGE_SECONDS

ACCOUNT_CHECK_TIMEOUT_SECONDS = 25
SCAN_RESPONSE_WAIT_SECONDS = 0.25
MAX_CONCURRENT_ACCOUNTS = 4


def scan_with_deadline(session):
    session.deadline = time.monotonic() + ACCOUNT_CHECK_TIMEOUT_SECONDS
    try:
        result = session.scan_inbox()
        if time.monotonic() >= session.deadline:
            raise UserError("Yahoo took too long to respond. Try checking again.")
        return result
    except Exception:
        if time.monotonic() >= session.deadline:
            raise UserError("Yahoo took too long to respond. Try checking again.") from None
        raise
    finally:
        session.deadline = None
        if session.connection is not None:
            session.connection.deadline = None


class AccountScanManager:
    def __init__(self):
        self.sessions = {}
        self.pending_scans = {}
        self.cached_results_by_account = {}
        self.executor = None
        self.mail_type = "codes"

    def close(self):
        for email in list(self.sessions):
            self.discard_account_state(email)
        if self.executor:
            self.executor.shutdown(wait=False, cancel_futures=True)
            self.executor = None

    def discard_account_state(self, email):
        key = email.lower()
        session = self.sessions.pop(key, None)
        future = self.pending_scans.pop(key, None)
        self.cached_results_by_account.pop(key, None)
        if session:
            if future and not future.done() and not future.cancel():
                # The worker owns its connection until the scan finishes.
                future.add_done_callback(lambda _future: session.close())
            else:
                session.close()

    def poll_accounts(self, account_credentials, mail_type="codes", collect_only=False):
        if mail_type != self.mail_type:
            for email in list(self.sessions):
                self.discard_account_state(email)
            self.mail_type = mail_type
        now = time.time()
        self.cached_results_by_account = {key: [item for item in items
            if 0 <= now - item["receivedAt"] / 1000 <= MAX_MESSAGE_AGE_SECONDS]
            for key, items in self.cached_results_by_account.items()}
        active = {account["email"].lower() for account in account_credentials}
        for email in list(self.sessions):
            if email not in active:
                self.discard_account_state(email)
        if not self.executor:
            self.executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_ACCOUNTS)
        for account in account_credentials:
            key = account["email"].lower()
            session = self.sessions.get(key)
            if session and session.credentials != account:
                self.discard_account_state(key)
                session = None
            if not session:
                session = self.sessions[key] = InboxSession(account, mail_type)
            # Keep a completed scan until its response has been collected.
            if not collect_only and key not in self.pending_scans:
                self.pending_scans[key] = self.executor.submit(scan_with_deadline, session)
        if self.pending_scans:
            wait(self.pending_scans.values(), timeout=SCAN_RESPONSE_WAIT_SECONDS)
        warnings = []
        for account in account_credentials:
            email = account["email"]
            key = email.lower()
            future = self.pending_scans.get(key)
            if future is None or not future.done():
                continue
            self.pending_scans.pop(key)
            try:
                self.cached_results_by_account[key] = [dict(item, accountEmail=email) for item in future.result()]
            except (UserError, imaplib.IMAP4.error, OSError) as exc:
                self.discard_account_state(key)
                warnings.append(f"{email}: {exc or 'Yahoo rejected the connection.'}")
        if warnings and not self.cached_results_by_account and len(warnings) == len(account_credentials):
            raise UserError("Could not check connected accounts: " + "; ".join(warnings))
        items = [item for results in self.cached_results_by_account.values() for item in results]
        items.sort(key=lambda item: item["receivedAt"], reverse=True)
        return {mail_type: items, "warnings": warnings, "scanPending": bool(self.pending_scans)}
