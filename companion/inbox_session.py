"""Connect to Yahoo IMAP and maintain a bounded inbox scan."""

import imaplib
import re
import ssl
import time

from code_extraction import extract_code_details
from link_extraction import extract_confirmation_link_details, extract_password_reset_link_details
from errors import UserError

MAIL_EXTRACTORS = {
    "codes": extract_code_details,
    "confirmationLinks": extract_confirmation_link_details,
    "passwordResetLinks": extract_password_reset_link_details,
}

MAX_MESSAGE_AGE_SECONDS = 600
MAX_FUTURE_SKEW_SECONDS = 120
FIRST_BATCH_SIZE = 5
MAX_MESSAGES = 30
MAX_NEW_RESULTS_PER_SCAN = 5
RECENT_RESULT_LIMIT = 5
DISTINCT_SENDER_LIMIT = 5
MAX_MESSAGE_BYTES = 1_000_000


def message_uid(metadata):
    """Read the UID from an IMAP metadata line or body-fetch header."""
    match = re.search(rb"\bUID (\d+)\b", metadata)
    return int(match.group(1)) if match else None


def connect_imap(credentials):
    connection = imaplib.IMAP4_SSL(
        "imap.mail.yahoo.com", 993, ssl_context=ssl.create_default_context(), timeout=15
    )
    try:
        connection.login(credentials["email"], credentials["password"])
        return connection
    except Exception:
        try:
            connection.shutdown()
        except Exception:
            pass
        raise


class InboxSession:
    def __init__(self, credentials, mail_type="codes"):
        self.extract_item = MAIL_EXTRACTORS[mail_type]
        self.credentials = credentials
        self.connection = None
        self.last_seen_uid = None
        self.message_count = 0
        self.items_by_uid = {}
        self.pending_metadata_uids = set()
        self.pending_received_at_by_uid = {}

    def close(self):
        connection, self.connection = self.connection, None
        self.last_seen_uid = None
        self.message_count = 0
        self.items_by_uid.clear()
        self.pending_metadata_uids.clear()
        self.pending_received_at_by_uid.clear()
        if connection:
            try:
                connection.shutdown()
            except (OSError, imaplib.IMAP4.error):
                pass

    def _new_message_metadata(self):
        if self.last_seen_uid is None:
            # Sequence numbers bound the first scan to the newest messages.
            if not self.message_count:
                self.last_seen_uid = 0
                return []
            first = max(1, self.message_count - MAX_MESSAGES + 1)
            status, metadata = self.connection.fetch(
                f"{first}:{self.message_count}", "(UID INTERNALDATE RFC822.SIZE)"
            )
            if status != "OK":
                raise UserError("Yahoo could not inspect recent messages.")
            uids = {
                uid
                for entry in metadata
                if isinstance(entry, bytes)
                if (uid := message_uid(entry)) is not None
            }
            # A successful FETCH can still omit a message. Repeat the bounded
            # first scan on the next poll before advancing past its UID.
            if len(uids) == self.message_count - first + 1:
                self.last_seen_uid = max(uids)
            return metadata

        status, data = self.connection.uid(
            "search", None, "UID", f"{self.last_seen_uid + 1}:*"
        )
        if status != "OK":
            raise UserError("Yahoo could not search your inbox.")
        # UID ranges ending in * can return the previous last UID.
        all_uids = [uid for value in data[0].split() if (uid := int(value)) > self.last_seen_uid]
        self.pending_metadata_uids.update(all_uids[-MAX_MESSAGES:])
        # A successful UID FETCH may omit a message temporarily. Keep those
        # UIDs queued so advancing last_seen_uid cannot make them disappear.
        self.pending_metadata_uids = set(
            sorted(self.pending_metadata_uids, reverse=True)[:MAX_MESSAGES]
        )
        if all_uids:
            self.last_seen_uid = all_uids[-1]
        if not self.pending_metadata_uids:
            return []
        uids = sorted(self.pending_metadata_uids, reverse=True)
        status, metadata = self.connection.uid(
            "fetch", b",".join(str(uid).encode() for uid in uids), "(UID INTERNALDATE RFC822.SIZE)"
        )
        if status != "OK":
            raise UserError("Yahoo could not inspect recent messages.")
        returned_uids = {
            uid
            for entry in metadata
            if isinstance(entry, bytes)
            if (uid := message_uid(entry)) is not None
        }
        self.pending_metadata_uids.difference_update(returned_uids)
        return metadata

    def _eligible_messages(self, metadata, now):
        eligible = {}
        for entry in metadata:
            if not isinstance(entry, bytes):
                continue
            uid = message_uid(entry)
            date = imaplib.Internaldate2tuple(entry)
            size = re.search(rb"\bRFC822.SIZE (\d+)\b", entry)
            if uid is None or not date or not size or int(size.group(1)) > MAX_MESSAGE_BYTES:
                continue
            received = time.mktime(date)
            if -MAX_FUTURE_SKEW_SECONDS <= now - received <= MAX_MESSAGE_AGE_SECONDS:
                eligible[uid] = min(received, now)
        return eligible

    def _fetch_items(self, candidates):
        new_item_count = 0
        # Return results from the newest batch immediately. Older candidates stay
        # queued for the next poll; if no result is found, continue this check.
        for batch in (candidates[:FIRST_BATCH_SIZE], candidates[FIRST_BATCH_SIZE:]):
            if not batch:
                continue
            status, body = self.connection.uid(
                "fetch", b",".join(str(uid).encode() for uid in batch), "(UID BODY.PEEK[])"
            )
            if status != "OK":
                raise UserError("Yahoo could not read recent messages.")
            messages = {}
            for entry in body:
                if not isinstance(entry, tuple):
                    continue
                uid = message_uid(entry[0])
                if uid is not None:
                    messages[uid] = entry[1]
            for uid in batch:
                received = self.pending_received_at_by_uid[uid]
                if uid not in messages:
                    # An OK fetch can omit a body. Try this UID again on the next poll.
                    continue
                self.pending_received_at_by_uid.pop(uid, None)
                found = self.extract_item(messages[uid])
                if found:
                    found["receivedAt"] = int(received * 1000)
                    found["uid"] = uid
                    self.items_by_uid[uid] = found
                    new_item_count += 1
                if new_item_count == MAX_NEW_RESULTS_PER_SCAN:
                    return
            if new_item_count:
                return

    def _prune_pending_messages(self, now):
        # Keep deferred work bounded, fresh, and behind newly arrived mail.
        distinct_senders = self._newest_distinct_senders()
        cutoff = (
            (distinct_senders[-1]["receivedAt"], distinct_senders[-1]["uid"])
            if len(distinct_senders) == DISTINCT_SENDER_LIMIT else None
        )
        eligible = sorted(
            self.pending_received_at_by_uid.items(), key=lambda item: item[0], reverse=True
        )
        pending = [
            (uid, received)
            for uid, received in eligible
            if 0 <= now - received <= MAX_MESSAGE_AGE_SECONDS
            and (cutoff is None or (int(received * 1000), uid) > cutoff)
        ][:MAX_MESSAGES]
        self.pending_received_at_by_uid = dict(pending)
        return [uid for uid, _ in pending]

    def recent_items(self):
        try:
            if self.connection is None:
                self.connection = connect_imap(self.credentials)
            if self.last_seen_uid is None:
                # Refresh the count on retries: a message may have been deleted
                # between SELECT and the previous sequence-number FETCH.
                status, count = self.connection.select("INBOX", readonly=True)
                if status != "OK":
                    raise UserError("Yahoo could not open your inbox.")
                self.message_count = int(count[0])
            now = time.time()
            self.items_by_uid = {
                uid: item
                for uid, item in self.items_by_uid.items()
                if 0 <= now - item["receivedAt"] / 1000 <= MAX_MESSAGE_AGE_SECONDS
            }
            metadata = self._new_message_metadata()
            self.pending_received_at_by_uid.update(self._eligible_messages(metadata, now))
            candidates = self._prune_pending_messages(now)
            self._fetch_items(candidates)
            return self._results()
        except Exception:
            self.close()
            raise

    def _newest_items(self):
        return sorted(
            self.items_by_uid.values(),
            key=lambda item: (item["receivedAt"], item["uid"]),
            reverse=True,
        )

    def _results(self):
        newest = self._newest_items()
        newest_overall = newest[:RECENT_RESULT_LIMIT]
        newest_by_sender = self._newest_distinct_senders(newest)
        retained_uids = {item["uid"] for item in (*newest_overall, *newest_by_sender)}
        results = [item for item in newest if item["uid"] in retained_uids]
        self.items_by_uid = {item["uid"]: item for item in results}
        return results

    def _newest_distinct_senders(self, newest=None):
        if newest is None:
            newest = self._newest_items()
        senders = set()
        distinct = []
        for item in newest:
            sender = item.get("sender", "").strip().lower()
            key = sender if sender else item["uid"]
            if key in senders:
                continue
            senders.add(key)
            distinct.append(item)
            if len(distinct) == DISTINCT_SENDER_LIMIT:
                break
        return distinct
