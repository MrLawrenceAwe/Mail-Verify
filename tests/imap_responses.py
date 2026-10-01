"""Build IMAP fetch responses without hiding scenario-specific connection behavior."""

import imaplib
import time


def metadata_response(uids, *, received_at=None, size=100):
    if received_at is None:
        received_at = time.time() - 60
    date = imaplib.Time2Internaldate(received_at).encode()
    return "OK", [
        b"1 (UID " + str(int(uid)).encode() + b" INTERNALDATE " + date
        + b" RFC822.SIZE " + str(size).encode() + b")"
        for uid in uids
    ]


def body_response(messages):
    return "OK", [
        (b"1 (UID " + str(int(uid)).encode() + b" BODY[] {"
         + str(len(body)).encode() + b"}", body)
        for uid, body in messages
    ]
