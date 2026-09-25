#!/usr/bin/env python3
"""Local Yahoo IMAP bridge. stdout is reserved for Chrome native messaging."""

import imaplib
import json
import re
import signal
import socket
import ssl
import struct
import sys
import time

from code_extraction import extract_code
from errors import UserError
from keychain import keychain

MAX_CODE_AGE_SECONDS = 600
MAX_FUTURE_SKEW_SECONDS = 120
CHECK_TIMEOUT_SECONDS = 25
FETCH_BATCH_SIZE = 5
MAX_MESSAGES = 30
MAX_RESULTS = 5
MAX_MESSAGE_BYTES = 1_000_000
MAX_FRAME_BYTES = 16_384


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
            if self.last_seen_uid is None:
                # Sequence numbers let the server return only the newest 30
                # messages instead of every UID received during the past day.
                if not self.message_count:
                    self.last_seen_uid = 0
                    return self._results()
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
            else:
                status, data = self.conn.uid(
                    "search", None, "UID", f"{self.last_seen_uid + 1}:*"
                )
                if status != "OK":
                    raise UserError("Yahoo could not search your inbox.")
                all_uids = data[0].split()
                # UID ranges ending in * can return the previous last UID when no new mail exists.
                all_uids = [uid for uid in all_uids if int(uid) > self.last_seen_uid]
                uids = all_uids[-MAX_MESSAGES:]
                if all_uids:
                    self.last_seen_uid = int(all_uids[-1])
                if uids:
                    status, metadata = self.conn.uid(
                        "fetch", b",".join(uids), "(UID INTERNALDATE RFC822.SIZE)"
                    )
                    if status != "OK":
                        raise UserError("Yahoo could not inspect recent messages.")
            if not uids:
                return self._results()
            eligible = {}
            for entry in metadata:
                if not isinstance(entry, bytes):
                    continue
                uid = re.search(rb"\bUID (\d+)\b", entry)
                date = imaplib.Internaldate2tuple(entry)
                size = re.search(rb"\bRFC822.SIZE (\d+)\b", entry)
                if (
                    not uid
                    or not date
                    or not size
                    or int(size.group(1)) > MAX_MESSAGE_BYTES
                ):
                    continue
                received = time.mktime(date)
                if -MAX_FUTURE_SKEW_SECONDS <= now - received <= MAX_CODE_AGE_SECONDS:
                    eligible[uid.group(1)] = min(received, now)
            candidates = [uid for uid in reversed(uids) if uid in eligible]
            new_code_count = 0
            for start in range(0, len(candidates), FETCH_BATCH_SIZE):
                batch = candidates[start : start + FETCH_BATCH_SIZE]
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
                        break
                if new_code_count == MAX_RESULTS:
                    break
            return self._results()
        except Exception:
            self.close()
            raise

    def _results(self):
        return [
            item
            for _, item in sorted(self.codes_by_uid.items(), reverse=True)[:MAX_RESULTS]
        ]


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


def handle_request(request, session):
    if not isinstance(request, dict):
        raise UserError("Invalid request.")
    action = request.get("action")
    if action == "status":
        credentials = keychain("get")
        return {"email": credentials["email"] if credentials else None}
    if action == "disconnect":
        keychain("delete")
        session.close()
        session.credentials = None
        return {"disconnected": True}
    if action == "configure":
        address = request.get("email", "").strip()
        password = request.get("password", "").replace(" ", "")
        if (
            not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", address)
            or not 8 <= len(password) <= 128
        ):
            raise UserError("Enter your Yahoo email address and a Yahoo app password.")
        credentials = {"email": address, "password": password}
        with connect_imap(credentials):
            pass
        keychain("set", credentials)
        session.close()
        session.credentials = credentials
        return {"email": address}
    if action == "codes":
        if session.credentials is None:
            session.credentials = keychain("get")
        if not session.credentials:
            raise UserError("Connect Yahoo Mail first.")
        return {"codes": check_with_timeout(session)}
    raise UserError("Unsupported request.")


def read_message(stream):
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError("Incomplete frame")
    length = struct.unpack("=I", header)[0]
    if not 0 < length <= MAX_FRAME_BYTES:
        raise ValueError("Invalid frame size")
    payload = stream.read(length)
    if len(payload) != length:
        raise ValueError("Incomplete payload")
    return json.loads(payload)


def main():
    session = MailSession(None)
    try:
        while True:
            try:
                request = read_message(sys.stdin.buffer)
                if request is None:
                    break
                response = {"ok": True, **handle_request(request, session)}
            except UserError as exc:
                response = {"ok": False, "error": str(exc)}
            except imaplib.IMAP4.error:
                response = {
                    "ok": False,
                    "error": "Yahoo rejected the connection. Check your email and app password, then reconnect.",
                }
            except (OSError, socket.timeout):
                response = {
                    "ok": False,
                    "error": "Could not reach Yahoo Mail or the local Keychain. Check your connection and try again.",
                }
            except Exception:
                response = {
                    "ok": False,
                    "error": "The local companion could not complete this request.",
                }
            payload = json.dumps(response).encode()
            sys.stdout.buffer.write(struct.pack("=I", len(payload)) + payload)
            sys.stdout.buffer.flush()
    finally:
        session.close()


if __name__ == "__main__":
    main()
