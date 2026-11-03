"""Coordinate bounded background scans across connected Yahoo accounts."""

import imaplib
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import Optional

from errors import UserError, inbox_error_message
from inbox_session import InboxSession, is_fresh_result

SCAN_TIMEOUT_SECONDS = 25
SCAN_RESPONSE_WAIT_SECONDS = 0.25
MAX_CONCURRENT_SCANS_PER_HOST = 4


def scan_with_deadline(session):
    session.deadline = time.monotonic() + SCAN_TIMEOUT_SECONDS
    try:
        try:
            result = session.scan_inbox()
        except Exception:
            if time.monotonic() < session.deadline:
                raise
        else:
            if time.monotonic() < session.deadline:
                return result
        raise UserError("Yahoo took too long to respond. Try checking again.")
    finally:
        session.deadline = None
        if session.connection is not None:
            session.connection.deadline = None


@dataclass
class AccountScanState:
    session: InboxSession
    pending_scan: Optional[Future] = None
    cached_results: list = field(default_factory=list)
    warning: Optional[str] = None


class AccountScanManager:
    def __init__(self):
        self.accounts = {}
        self.executor = None
        self.mail_type = "codes"

    def close(self):
        for email in list(self.accounts):
            self.discard_account_state(email)
        if self.executor:
            self.executor.shutdown(wait=False, cancel_futures=True)
            self.executor = None

    def discard_account_state(self, email):
        state = self.accounts.pop(email.lower(), None)
        if state:
            future = state.pending_scan
            if future and not future.done() and not future.cancel():
                # The worker owns its connection until the scan finishes.
                future.add_done_callback(lambda _future: state.session.close())
            else:
                state.session.close()

    def poll_accounts(self, account_credentials, mail_type="codes", collect_only=False):
        if mail_type != self.mail_type:
            for email in list(self.accounts):
                self.discard_account_state(email)
            self.mail_type = mail_type
        now = time.time()
        accounts_by_key = [(account["email"].lower(), account) for account in account_credentials]
        active = {key for key, _ in accounts_by_key}
        for email in list(self.accounts):
            if email not in active:
                self.discard_account_state(email)
        if not self.executor:
            self.executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_SCANS_PER_HOST)
        account_states = []
        for key, account in accounts_by_key:
            state = self.accounts.get(key)
            if state and state.session.credentials != account:
                self.discard_account_state(key)
                state = None
            if not state:
                state = self.accounts[key] = AccountScanState(InboxSession(account, mail_type))
            state.cached_results = [
                item for item in state.cached_results if is_fresh_result(item, now)
            ]
            account_states.append((account["email"], state))
            # Keep a completed scan until its response has been collected.
            if not collect_only and state.pending_scan is None:
                state.pending_scan = self.executor.submit(scan_with_deadline, state.session)
        pending = [state.pending_scan for state in self.accounts.values()
                   if state.pending_scan is not None]
        if pending:
            wait(pending, timeout=SCAN_RESPONSE_WAIT_SECONDS)
        for email, state in account_states:
            future = state.pending_scan
            if future is None or not future.done():
                continue
            state.pending_scan = None
            try:
                state.cached_results = [dict(item, accountEmail=email) for item in future.result()]
                state.warning = None
            except (UserError, imaplib.IMAP4.error, OSError) as exc:
                # Keep the closed session's credentials so removal or credential
                # changes still invalidate this failure before the next scan.
                state.session.close()
                state.cached_results = []
                state.warning = f"{email}: {inbox_error_message(exc)}"
        warnings = [state.warning for _, state in account_states if state.warning is not None]
        if warnings and len(warnings) == len(account_credentials):
            raise UserError("Could not check connected accounts: " + "; ".join(warnings))
        items = [item for state in self.accounts.values() for item in state.cached_results]
        items.sort(key=lambda item: item["receivedAt"], reverse=True)
        return {mail_type: items, "warnings": warnings,
                "scanPending": any(state.pending_scan is not None for state in self.accounts.values())}
