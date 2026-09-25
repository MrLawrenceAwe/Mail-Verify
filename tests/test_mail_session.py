"""Bounded and incremental IMAP scanning cases."""

from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import mail_session


class MailSessionTests(unittest.TestCase):
    def message(self, body, subject="Sign in", subtype="plain"):
        return f"From: Example <auth@example.com>\r\nSubject: {subject}\r\nContent-Type: text/{subtype}; charset=utf-8\r\n\r\n{body}".encode()

    def test_recent_codes_batches_fetches_and_keeps_newest_first(self):
        class FakeConnection:
            def __init__(self):
                self.fetches = []
                self.searches = []
                self.sequence_fetches = []
                self.closed = False
                self.count = 12

            def select(self, *_args, **_kwargs):
                return "OK", [str(self.count).encode()]

            def fetch(self, sequence, _parts):
                self.sequence_fetches.append(sequence)
                first, last = map(int, sequence.split(":"))
                date = mail_session.imaplib.Time2Internaldate(time.time() - 60).encode()
                return "OK", [
                    b"1 (UID "
                    + str(uid).encode()
                    + b" INTERNALDATE "
                    + date
                    + b" RFC822.SIZE 100)"
                    for uid in range(first, last + 1)
                ]

            def uid(self, command, *args):
                if command == "search":
                    self.searches.append(args)
                    ids = range(
                        min(int(args[2].split(":")[0]), self.count), self.count + 1
                    )
                    return "OK", [b" ".join(str(i).encode() for i in ids)]
                self.fetches.append(args)
                uids = args[0].split(b",")
                if "INTERNALDATE" in args[1]:
                    date = mail_session.imaplib.Time2Internaldate(time.time() - 60).encode()
                    return "OK", [
                        b"1 (UID "
                        + uid
                        + b" INTERNALDATE "
                        + date
                        + b" RFC822.SIZE 100)"
                        for uid in uids
                    ]
                return "OK", [
                    (b"1 (UID " + uid + b" BODY[] {80}", self_message(uid))
                    for uid in uids
                ]

            def shutdown(self):
                self.closed = True

        def self_message(uid):
            return self.message(
                "Your verification code is " + str(int(uid) + 100000) + "."
            )

        conn = FakeConnection()
        with patch.object(mail_session, "connect_imap", return_value=conn):
            session = mail_session.MailSession(
                {"email": "test@yahoo.com", "password": "unused"}
            )
            codes = session.recent_codes()
            self.assertEqual(session.recent_codes(), codes)
            self.assertEqual(
                len(conn.fetches), 1, "unchanged mail should not be fetched again"
            )
            conn.count = 13
            self.assertEqual(session.recent_codes()[0]["code"], "100013")
            self.assertEqual(conn.fetches[1][0], b"13")
            self.assertEqual(conn.fetches[2][0], b"13")
            session.close()
        self.assertEqual(
            [item["code"] for item in codes],
            ["100012", "100011", "100010", "100009", "100008"],
        )
        self.assertEqual(len(conn.fetches), 3)
        self.assertEqual(conn.sequence_fetches, ["1:12"])
        self.assertEqual(conn.fetches[0][0], b"12,11,10,9,8")
        self.assertEqual(conn.searches[0], (None, "UID", "13:*"))
        self.assertTrue(conn.closed)

    def test_initial_scan_is_bounded_to_newest_30_messages(self):
        class FakeConnection:
            def select(self, *_args, **_kwargs):
                return "OK", [b"10000"]

            def fetch(self, sequence, _parts):
                self.sequence = sequence
                date = mail_session.imaplib.Time2Internaldate(time.time() - 3600).encode()
                return "OK", [
                    b"1 (UID "
                    + str(uid).encode()
                    + b" INTERNALDATE "
                    + date
                    + b" RFC822.SIZE 100)"
                    for uid in range(9971, 10001)
                ]

            def uid(self, *_args):
                raise AssertionError(
                    "No UID search or body fetch is needed for old mail"
                )

            def shutdown(self):
                pass

        conn = FakeConnection()
        with patch.object(mail_session, "connect_imap", return_value=conn):
            session = mail_session.MailSession(
                {"email": "test@yahoo.com", "password": "unused"}
            )
            self.assertEqual(session.recent_codes(), [])
        self.assertEqual(conn.sequence, "9971:10000")
        self.assertEqual(session.last_seen_uid, 10000)

    def test_future_internaldate_does_not_permanently_skip_code(self):
        class FakeConnection:
            def __init__(self):
                self.body_fetches = 0

            def select(self, *_args, **_kwargs):
                return "OK", [b"1"]

            def fetch(self, *_args):
                future = mail_session.imaplib.Time2Internaldate(time.time() + 60).encode()
                return "OK", [
                    b"1 (UID 10 INTERNALDATE " + future + b" RFC822.SIZE 100)"
                ]

            def uid(self, command, *_args):
                if command == "search":
                    return "OK", [b""]
                self.body_fetches += 1
                return "OK", [(b"1 (UID 10 BODY[] {100}", self_message)]

            def shutdown(self):
                pass

        self_message = self.message("Your verification code is 482913.")
        conn = FakeConnection()
        with patch.object(mail_session, "connect_imap", return_value=conn):
            session = mail_session.MailSession(
                {"email": "test@yahoo.com", "password": "unused"}
            )
            first = session.recent_codes()
            self.assertEqual(first[0]["code"], "482913")
            self.assertLessEqual(first[0]["receivedAt"], int(time.time() * 1000))
            self.assertEqual(session.recent_codes(), first)
        self.assertEqual(conn.body_fetches, 1)



if __name__ == "__main__":
    unittest.main()
