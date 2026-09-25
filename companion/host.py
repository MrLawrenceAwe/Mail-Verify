#!/usr/bin/env python3
"""Local Yahoo native messaging host. stdout is reserved for Chrome."""

import imaplib
import json
import re
import signal
import socket
import struct
import sys

from errors import UserError
from keychain import keychain
from mail_session import MailSession, connect_imap

CHECK_TIMEOUT_SECONDS = 25
MAX_FRAME_BYTES = 16_384


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
        credentials = keychain("get")
        if credentials != session.credentials:
            session.close()
            session.credentials = credentials
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
