#!/usr/bin/env python3
"""Local Yahoo native messaging host. stdout is reserved for Chrome."""

import imaplib
import json
import re
import struct
import sys

from errors import UserError
from keychain import keychain
from mail_session import connect_imap
from account_sessions import AccountSessions

MAX_FRAME_BYTES = 16_384


def stored_accounts():
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
        return {"accounts": [item["email"] for item in stored_accounts()]}
    if action == "removeAccount":
        address = request.get("email", "")
        accounts = stored_accounts()
        remaining = [item for item in accounts if item["email"].lower() != address.lower()]
        if len(remaining) == len(accounts):
            raise UserError("That Yahoo account is not connected.")
        if remaining:
            keychain("set", {"accounts": remaining})
        else:
            keychain("delete")
        sessions.remove(address)
        return {"accounts": [item["email"] for item in remaining]}
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
        accounts = stored_accounts()
        accounts = [item for item in accounts if item["email"].lower() != address.lower()]
        accounts.append(credentials)
        keychain("set", {"accounts": accounts})
        sessions.remove(address)
        return {"accounts": [item["email"] for item in accounts]}
    if action == "codes":
        accounts = stored_accounts()
        if not accounts:
            sessions.close()
            raise UserError("Connect Yahoo Mail first.")
        return sessions.codes(accounts)
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
