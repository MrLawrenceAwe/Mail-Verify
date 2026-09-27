#!/usr/bin/env python3
"""Local Yahoo native messaging host. stdout is reserved for Chrome."""

import imaplib
import json
import fcntl
import os
import re
import struct
import sys
from contextlib import contextmanager
from pathlib import Path

from errors import UserError
from keychain import keychain
from inbox_session import connect_imap
from account_sessions import AccountSessions

MAX_FRAME_BYTES = 16_384
ACCOUNT_LOCK_PATH = Path.home() / "Library/Application Support/Yahoo Code Fill/accounts.lock"


@contextmanager
def account_lock():
    """Serialize Keychain read-modify-write operations across native hosts."""
    ACCOUNT_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(ACCOUNT_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def load_account_credentials():
    saved = keychain("get")
    if not saved:
        return []
    # The original single-account Keychain item is read in place so an update
    # does not strand the user's existing app password.
    return saved["accounts"] if "accounts" in saved else [saved]


def handle_request(request, sessions):
    if not isinstance(request, dict):
        raise UserError("Invalid request.")
    action = request.get("action")
    if action == "status":
        return {"accountEmails": [item["email"] for item in load_account_credentials()]}
    if action == "removeAccount":
        address = request.get("email", "")
        with account_lock():
            credentials = load_account_credentials()
            remaining = [item for item in credentials if item["email"].lower() != address.lower()]
            if len(remaining) == len(credentials):
                raise UserError("That Yahoo account is not connected.")
            if remaining:
                keychain("set", {"accounts": remaining})
            else:
                keychain("delete")
        sessions.remove(address)
        return {"accountEmails": [item["email"] for item in remaining]}
    if action == "saveAccount":
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
        with account_lock():
            account_credentials = load_account_credentials()
            account_credentials = [item for item in account_credentials if item["email"].lower() != address.lower()]
            account_credentials.append(credentials)
            keychain("set", {"accounts": account_credentials})
        sessions.remove(address)
        return {"accountEmails": [item["email"] for item in account_credentials]}
    if action == "codes":
        account_credentials = load_account_credentials()
        if not account_credentials:
            sessions.close()
            raise UserError("Connect Yahoo Mail first.")
        return sessions.fetch_recent_codes(account_credentials)
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
    sessions = AccountSessions()
    try:
        while True:
            try:
                request = read_message(sys.stdin.buffer)
                if request is None:
                    break
                response = {"ok": True, **handle_request(request, sessions)}
            except UserError as exc:
                response = {"ok": False, "error": str(exc)}
            except imaplib.IMAP4.error:
                response = {
                    "ok": False,
                    "error": "Yahoo rejected the connection. Check your email and app password, then reconnect.",
                }
            except OSError:
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
        sessions.close()


if __name__ == "__main__":
    main()
