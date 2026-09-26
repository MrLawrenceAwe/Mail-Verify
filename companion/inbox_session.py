"""Connect to Yahoo IMAP and maintain a bounded inbox scan."""

import imaplib
import re
import ssl
import time

from code_extraction import extract_code_details
from errors import UserError

MAX_CODE_AGE_SECONDS = 600
MAX_FUTURE_SKEW_SECONDS = 120
FIRST_BATCH_SIZE = 5
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


class InboxSession:
    def __init__(self, credentials):
        self.credentials = credentials
        self.conn = None
        self.last_seen_uid = None
        self.message_count = 0
        self.codes_by_uid = {}
        self.pending_received_at_by_uid = {}

    def close(self):
        conn, self.conn = self.conn, None
        self.last_seen_uid = None
        self.message_count = 0
        self.codes_by_uid.clear()
        self.pending_received_at_by_uid.clear()
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
                return []
            first = max(1, self.message_count - MAX_MESSAGES + 1)
            status, metadata = self.conn.fetch(
                f"{first}:{self.message_count}", "(UID INTERNALDATE RFC822.SIZE)"
            )
            if status != "OK":
                raise UserError("Yahoo could not inspect recent messages.")
            uids = [
                int(match.group(1))
                for entry in metadata
                if isinstance(entry, bytes)
                if (match := re.search(rb"\bUID (\d+)\b", entry))
            ]
            self.last_seen_uid = max(uids, default=0)
            return metadata

        status, data = self.conn.uid(
            "search", None, "UID", f"{self.last_seen_uid + 1}:*"
        )
        if status != "OK":
            raise UserError("Yahoo could not search your inbox.")
        # UID ranges ending in * can return the previous last UID.
        all_uids = [uid for value in data[0].split() if (uid := int(value)) > self.last_seen_uid]
        uids = all_uids[-MAX_MESSAGES:]
        if all_uids:
            self.last_seen_uid = all_uids[-1]
        if not uids:
            return []
        status, metadata = self.conn.uid(
            "fetch", b",".join(str(uid).encode() for uid in uids), "(UID INTERNALDATE RFC822.SIZE)"
        )
        if status != "OK":
            raise UserError("Yahoo could not inspect recent messages.")
        return metadata

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
                eligible[int(uid.group(1))] = min(received, now)
        return eligible

    def _fetch_codes(self, candidates):
        new_code_count = 0
        # Return codes from the newest batch immediately. Older candidates stay
        # queued for the next poll; if no code is found, continue this check.
        for batch in (candidates[:FIRST_BATCH_SIZE], candidates[FIRST_BATCH_SIZE:]):
            if not batch:
                continue
            status, body = self.conn.uid(
                "fetch", b",".join(str(uid).encode() for uid in batch), "(UID BODY.PEEK[])"
            )
            if status != "OK":
                raise UserError("Yahoo could not read recent messages.")
            messages = {}
            for entry in body:
                if not isinstance(entry, tuple):
                    continue
                uid = re.search(rb"\bUID (\d+)\b", entry[0])
                if uid:
                    messages[int(uid.group(1))] = entry[1]
            for uid in batch:
                received = self.pending_received_at_by_uid[uid]
                if uid not in messages:
                    # An OK fetch can omit a body. Try this UID again on the next poll.
                    continue
                self.pending_received_at_by_uid.pop(uid, None)
                found = extract_code_details(messages[uid])
                if found:
                    found["receivedAt"] = int(received * 1000)
                    found["uid"] = uid
                    self.codes_by_uid[uid] = found
                    new_code_count += 1
                if new_code_count == MAX_RESULTS:
                    return
            if new_code_count:
                return

    def _prune_pending_messages(self, now):
        # Keep deferred work bounded, fresh, and behind newly arrived mail.
        cutoff = (
            sorted(
                (item["receivedAt"], uid)
                for uid, item in self.codes_by_uid.items()
            )[-MAX_RESULTS]
            if len(self.codes_by_uid) >= MAX_RESULTS else None
        )
        eligible = sorted(
            self.pending_received_at_by_uid.items(), key=lambda item: item[0], reverse=True
        )
        self.pending_received_at_by_uid = {
            uid: received
            for uid, received in eligible
            if 0 <= now - received <= MAX_CODE_AGE_SECONDS
            and (cutoff is None or (int(received * 1000), uid) > cutoff)
        }
        candidates = list(self.pending_received_at_by_uid)[:MAX_MESSAGES]
        self.pending_received_at_by_uid = {
            uid: self.pending_received_at_by_uid[uid] for uid in candidates
        }
        return candidates

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
            metadata = self._new_message_metadata()
            self.pending_received_at_by_uid.update(self._eligible_messages(metadata, now))
            candidates = self._prune_pending_messages(now)
            self._fetch_codes(candidates)
            return self._results()
        except Exception:
            self.close()
            raise

    def _results(self):
        return sorted(
            self.codes_by_uid.values(),
            key=lambda item: (item["receivedAt"], item["uid"]),
            reverse=True,
        )[:MAX_RESULTS]
