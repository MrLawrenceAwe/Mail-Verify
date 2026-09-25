"""Connect to Yahoo IMAP and maintain a bounded inbox scan."""

import imaplib
import re
import ssl
import time

from code_extraction import extract_code
from errors import UserError

MAX_CODE_AGE_SECONDS = 600
MAX_FUTURE_SKEW_SECONDS = 120
FETCH_BATCH_SIZE = 5
MAX_MESSAGES = 30
MAX_RESULTS = 5
MAX_MESSAGE_BYTES = 1_000_000


def connect_imap(credentials):
    conn = imaplib.IMAP4_SSL(
        "imap.mail.yahoo.com", 993, ssl_context=ssl.create_default_context(), timeout=15
    )
    try:
        conn.login(credentials["email"], credentials["password"])
        return conn
    except Exception:
        try:
            conn.shutdown()
        except Exception:
            pass
        raise


class MailSession:
    def __init__(self, credentials):
        self.credentials = credentials
        self.conn = None
        self.last_seen_uid = None
        self.message_count = 0
        self.codes_by_uid = {}

    def close(self):
        conn, self.conn = self.conn, None
        self.last_seen_uid = None
        self.message_count = 0
        self.codes_by_uid.clear()
        if conn:
            try:
                conn.shutdown()
            except (OSError, imaplib.IMAP4.error):
                pass

    def _new_message_metadata(self):
        if self.last_seen_uid is None:
            # Sequence numbers bound the first scan to the newest messages.
            if not self.message_count:
                self.last_seen_uid = 0
                return [], []
            first = max(1, self.message_count - MAX_MESSAGES + 1)
            status, metadata = self.conn.fetch(
                f"{first}:{self.message_count}", "(UID INTERNALDATE RFC822.SIZE)"
            )
            if status != "OK":
                raise UserError("Yahoo could not inspect recent messages.")
            uids = [
                match.group(1)
                for entry in metadata
                if isinstance(entry, bytes)
                if (match := re.search(rb"\bUID (\d+)\b", entry))
            ]
            self.last_seen_uid = max(map(int, uids), default=0)
            return uids, metadata

        status, data = self.conn.uid(
            "search", None, "UID", f"{self.last_seen_uid + 1}:*"
        )
        if status != "OK":
            raise UserError("Yahoo could not search your inbox.")
        # UID ranges ending in * can return the previous last UID.
        all_uids = [uid for uid in data[0].split() if int(uid) > self.last_seen_uid]
        uids = all_uids[-MAX_MESSAGES:]
        if all_uids:
            self.last_seen_uid = int(all_uids[-1])
        if not uids:
            return [], []
        status, metadata = self.conn.uid(
            "fetch", b",".join(uids), "(UID INTERNALDATE RFC822.SIZE)"
        )
        if status != "OK":
            raise UserError("Yahoo could not inspect recent messages.")
        return uids, metadata

    def _eligible_messages(self, metadata, now):
        eligible = {}
        for entry in metadata:
            if not isinstance(entry, bytes):
                continue
            uid = re.search(rb"\bUID (\d+)\b", entry)
            date = imaplib.Internaldate2tuple(entry)
            size = re.search(rb"\bRFC822.SIZE (\d+)\b", entry)
            if not uid or not date or not size or int(size.group(1)) > MAX_MESSAGE_BYTES:
                continue
            received = time.mktime(date)
            if -MAX_FUTURE_SKEW_SECONDS <= now - received <= MAX_CODE_AGE_SECONDS:
                eligible[uid.group(1)] = min(received, now)
        return eligible

    def _fetch_codes(self, candidates, eligible):
        new_code_count = 0
        # Check the newest few messages first. If none (or too few) have codes,
        # fetch the rest together instead of paying for up to five more round trips.
        for batch in (candidates[:FETCH_BATCH_SIZE], candidates[FETCH_BATCH_SIZE:]):
            if not batch:
                continue
            status, body = self.conn.uid(
                "fetch", b",".join(batch), "(UID BODY.PEEK[])"
            )
            if status != "OK":
                raise UserError("Yahoo could not read recent messages.")
            messages = {}
            for entry in body:
                if not isinstance(entry, tuple):
                    continue
                uid = re.search(rb"\bUID (\d+)\b", entry[0])
                if uid:
                    messages[uid.group(1)] = entry[1]
            for uid in batch:
                found = extract_code(messages[uid]) if uid in messages else None
                if found:
                    found["receivedAt"] = int(eligible[uid] * 1000)
                    self.codes_by_uid[int(uid)] = found
                    new_code_count += 1
                if new_code_count == MAX_RESULTS:
                    return

    def recent_codes(self):
        try:
            if self.conn is None:
                self.conn = connect_imap(self.credentials)
                status, count = self.conn.select("INBOX", readonly=True)
                if status != "OK":
                    raise UserError("Yahoo could not open your inbox.")
                self.message_count = int(count[0])
            now = time.time()
            self.codes_by_uid = {
                uid: item
                for uid, item in self.codes_by_uid.items()
                if 0 <= now - item["receivedAt"] / 1000 <= MAX_CODE_AGE_SECONDS
            }
            uids, metadata = self._new_message_metadata()
            if not uids:
                return self._results()
            eligible = self._eligible_messages(metadata, now)
            candidates = [uid for uid in reversed(uids) if uid in eligible]
            self._fetch_codes(candidates, eligible)
            return self._results()
        except Exception:
            self.close()
            raise

    def _results(self):
        return [
            item
            for _, item in sorted(self.codes_by_uid.items(), reverse=True)[:MAX_RESULTS]
        ]
