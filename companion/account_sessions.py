"""Coordinate inbox sessions across connected Yahoo accounts."""

import imaplib
import signal

from errors import UserError
from inbox_session import InboxSession

ACCOUNT_CHECK_TIMEOUT_SECONDS = 25


def fetch_with_timeout(session):
    def timeout(_signum, _frame):
        raise UserError("Yahoo took too long to respond. Try checking again.")

    previous = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, ACCOUNT_CHECK_TIMEOUT_SECONDS)
    try:
        return session.recent_items()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class AccountSessions:
    def __init__(self):
        self.sessions = {}
        self.mail_type = "codes"

    def close(self):
        for session in self.sessions.values():
            session.close()
        self.sessions.clear()

    def remove(self, email):
        session = self.sessions.pop(email.lower(), None)
        if session:
            session.close()

    def fetch_recent_items(self, account_credentials, mail_type="codes"):
        if mail_type != self.mail_type:
            self.close()
            self.mail_type = mail_type
        active = {account["email"].lower() for account in account_credentials}
        for email in list(self.sessions):
            if email not in active:
                self.remove(email)
        items, warnings = [], []
        for account in account_credentials:
            email = account["email"]
            key = email.lower()
            session = self.sessions.get(key)
            if session and session.credentials != account:
                self.remove(email)
                session = None
            if not session:
                session = self.sessions[key] = InboxSession(account, mail_type)
            try:
                items.extend({**item, "accountEmail": email} for item in fetch_with_timeout(session))
            except (UserError, imaplib.IMAP4.error, OSError) as exc:
                self.remove(email)
                warnings.append(f"{email}: {exc or 'Yahoo rejected the connection.'}")
        if warnings and not items and len(warnings) == len(account_credentials):
            raise UserError("Could not check connected accounts: " + "; ".join(warnings))
        items.sort(key=lambda item: item["receivedAt"], reverse=True)
        return {mail_type: items, "warnings": warnings}

