"""Coordinate inbox sessions across connected Yahoo accounts."""

import imaplib
import signal

from errors import UserError
from mail_session import InboxSession

CHECK_TIMEOUT_SECONDS = 25


def check_with_timeout(session):
    def timeout(_signum, _frame):
        raise UserError("Yahoo took too long to respond. Try checking again.")

    previous = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, CHECK_TIMEOUT_SECONDS)
    try:
        return session.recent_codes()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class AccountSessions:
    def __init__(self):
        self.sessions = {}

    def close(self):
        for session in self.sessions.values():
            session.close()
        self.sessions.clear()

    def remove(self, email):
        session = self.sessions.pop(email.lower(), None)
        if session:
            session.close()

    def codes(self, accounts):
        active = {account["email"].lower() for account in accounts}
        for email in list(self.sessions):
            if email not in active:
                self.remove(email)
        codes, errors = [], []
        for account in accounts:
            email = account["email"]
            key = email.lower()
            session = self.sessions.get(key)
            if session and session.credentials != account:
                self.remove(email)
                session = None
            if not session:
                session = self.sessions[key] = InboxSession(account)
            try:
                codes.extend({**item, "accountEmail": email} for item in check_with_timeout(session))
            except (UserError, imaplib.IMAP4.error, OSError) as exc:
                self.remove(email)
                errors.append(f"{email}: {exc or 'Yahoo rejected the connection.'}")
        if errors and not codes and len(errors) == len(accounts):
            raise UserError("Could not check connected accounts: " + "; ".join(errors))
        codes.sort(key=lambda item: item["receivedAt"], reverse=True)
        return {"codes": codes, "warnings": errors}


