"""Bounded and incremental IMAP scanning cases."""

from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import inbox_session
from imap_responses import body_response, metadata_response


class InboxSessionTests(unittest.TestCase):
    def message(self, body, subject="Sign in", subtype="plain"):
        return f"From: Example <auth@example.com>\r\nSubject: {subject}\r\nContent-Type: text/{subtype}; charset=utf-8\r\n\r\n{body}".encode()

    def test_recent_items_batches_fetches_and_keeps_newest_first(self):
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
                return metadata_response(range(first, last + 1))

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
                    return metadata_response(uids)
                return body_response((uid, self_message(uid)) for uid in uids)

            def shutdown(self):
                self.closed = True

        def self_message(uid):
            return self.message(
                "Your verification code is " + str(int(uid) + 100000) + "."
            )

        connection = FakeConnection()
        with patch.object(inbox_session, "connect_imap", return_value=connection):
            session = inbox_session.InboxSession(
                {"email": "test@yahoo.com", "password": "unused"}
            )
            codes = session.recent_items()
            self.assertEqual(session.recent_items(), codes)
            self.assertEqual(
                connection.fetches[1][0], b"7,6,5,4,3",
                "the next poll should inspect older mail for a distinct sender",
            )
            connection.count = 13
            self.assertEqual(session.recent_items()[0]["code"], "100013")
            self.assertEqual(connection.fetches[2][0], b"13")
            self.assertEqual(connection.fetches[3][0], b"13,2,1")
            session.close()
        self.assertEqual(
            [item["code"] for item in codes],
            ["100012", "100011", "100010", "100009", "100008"],
        )
        self.assertEqual([item["uid"] for item in codes], [12, 11, 10, 9, 8])
        self.assertEqual(len(connection.fetches), 4)
        self.assertEqual(connection.sequence_fetches, ["1:12"])
        self.assertEqual(connection.fetches[0][0], b"12,11,10,9,8")
        self.assertEqual(connection.searches[0], (None, "UID", "13:*"))
        self.assertTrue(connection.closed)

    def test_returns_first_code_and_defers_older_mail_behind_new_arrivals(self):
        class FakeConnection:
            count = 12

            def __init__(self):
                self.batches = []

            def select(self, *_args, **_kwargs):
                return "OK", [b"12"]

            def fetch(self, *_args):
                return metadata_response(range(1, 13))

            def uid(self, command, *args):
                if command == "search":
                    first = int(args[2].split(":")[0])
                    return "OK", [b" ".join(str(i).encode() for i in range(first, self.count + 1))]
                uids = args[0].split(b",")
                if "INTERNALDATE" in args[1]:
                    return metadata_response(uids)
                self.batches.append(uids)
                return body_response(
                    (uid, b"From: auth@example.com\r\n\r\nYour code is "
                     + str(100000 + int(uid)).encode()
                     if uid in (b"12", b"13", b"6", b"1") else b"No code here.")
                    for uid in uids
                )

            def shutdown(self):
                pass

        connection = FakeConnection()
        with patch.object(inbox_session, "connect_imap", return_value=connection):
            session = inbox_session.InboxSession({})
            self.assertEqual([x["code"] for x in session.recent_items()], ["100012"])
            self.assertEqual(connection.batches, [[b"12", b"11", b"10", b"9", b"8"]])
            self.assertEqual(len(session.pending_received_at_by_uid), 7)
            connection.count = 13
            self.assertEqual([x["code"] for x in session.recent_items()], ["100013", "100012", "100006"])
            self.assertEqual(connection.batches[1], [b"13", b"7", b"6", b"5", b"4"])
            self.assertEqual([x["code"] for x in session.recent_items()], ["100013", "100012", "100006", "100001"])
            self.assertEqual(connection.batches[2], [b"3", b"2", b"1"])
            session.recent_items()
            self.assertEqual(len(connection.batches), 3)
            session.pending_received_at_by_uid[99] = time.time()
            session.close()
            self.assertEqual(session.pending_received_at_by_uid, {})

    def test_expired_deferred_mail_is_not_downloaded(self):
        class FakeConnection:
            def uid(self, command, *_args):
                if command != "search":
                    raise AssertionError("Expired mail must not be fetched")
                return "OK", [b""]

        session = inbox_session.InboxSession({})
        session.connection = FakeConnection()
        session.last_seen_uid = 10
        session.pending_received_at_by_uid[9] = time.time() - 601
        self.assertEqual(session.recent_items(), [])
        self.assertEqual(session.pending_received_at_by_uid, {})

    def test_initial_scan_is_bounded_to_newest_30_messages(self):
        class FakeConnection:
            def select(self, *_args, **_kwargs):
                return "OK", [b"10000"]

            def fetch(self, sequence, _parts):
                self.sequence = sequence
                return metadata_response(range(9971, 10001), received_at=time.time() - 3600)

            def uid(self, *_args):
                raise AssertionError(
                    "No UID search or body fetch is needed for old mail"
                )

            def shutdown(self):
                pass

        connection = FakeConnection()
        with patch.object(inbox_session, "connect_imap", return_value=connection):
            session = inbox_session.InboxSession(
                {"email": "test@yahoo.com", "password": "unused"}
            )
            self.assertEqual(session.recent_items(), [])
        self.assertEqual(connection.sequence, "9971:10000")
        self.assertEqual(session.last_seen_uid, 10000)

    def test_initial_scan_without_codes_uses_two_body_fetches(self):
        class FakeConnection:
            def __init__(self):
                self.body_batches = []

            def select(self, *_args, **_kwargs):
                return "OK", [b"30"]

            def fetch(self, *_args):
                return metadata_response(range(1, 31))

            def uid(self, command, *args):
                self.assert_uid_command(command)
                uids = args[0].split(b",")
                self.body_batches.append(uids)
                return body_response(
                    (uid, b"From: auth@example.com\r\nSubject: Account\r\n\r\nNo code here.")
                    for uid in uids
                )

            def assert_uid_command(self, command):
                if command != "fetch":
                    raise AssertionError(command)

            def shutdown(self):
                pass

        connection = FakeConnection()
        with patch.object(inbox_session, "connect_imap", return_value=connection):
            session = inbox_session.InboxSession({"email": "test@yahoo.com", "password": "unused"})
            self.assertEqual(session.recent_items(), [])
        self.assertEqual([len(batch) for batch in connection.body_batches], [5, 25])

    def test_future_internaldate_does_not_permanently_skip_code(self):
        class FakeConnection:
            def __init__(self):
                self.body_fetches = 0

            def select(self, *_args, **_kwargs):
                return "OK", [b"1"]

            def fetch(self, *_args):
                return metadata_response([10], received_at=time.time() + 60)

            def uid(self, command, *_args):
                if command == "search":
                    return "OK", [b""]
                self.body_fetches += 1
                return body_response([(10, self_message)])

            def shutdown(self):
                pass

        self_message = self.message("Your verification code is 482913.")
        connection = FakeConnection()
        with patch.object(inbox_session, "connect_imap", return_value=connection):
            session = inbox_session.InboxSession(
                {"email": "test@yahoo.com", "password": "unused"}
            )
            first = session.recent_items()
            self.assertEqual(first[0]["code"], "482913")
            self.assertLessEqual(first[0]["receivedAt"], int(time.time() * 1000))
            self.assertEqual(session.recent_items(), first)
        self.assertEqual(connection.body_fetches, 1)

    def test_missing_body_is_retried_on_next_poll(self):
        class FakeConnection:
            body_fetches = 0

            def uid(self, command, *_args):
                if command == "search":
                    return "OK", [b""]
                self.body_fetches += 1
                if self.body_fetches == 1:
                    return "OK", [None]
                return body_response([(9, self_message)])

        self_message = self.message("Your verification code is 482913.")
        session = inbox_session.InboxSession({})
        connection = session.connection = FakeConnection()
        session.last_seen_uid = 10
        session.pending_received_at_by_uid[9] = time.time() - 60

        self.assertEqual(session.recent_items(), [])
        self.assertIn(9, session.pending_received_at_by_uid)
        self.assertEqual(session.recent_items()[0]["code"], "482913")
        self.assertEqual(connection.body_fetches, 2)
        self.assertNotIn(9, session.pending_received_at_by_uid)

    def test_missing_metadata_is_retried_after_last_seen_uid_advances(self):
        now = time.time()

        class FakeConnection:
            metadata_fetches = 0

            def uid(self, command, *args):
                if command == "search":
                    return "OK", [b"5 6" if self.metadata_fetches == 0 else b""]
                if "INTERNALDATE" in args[1]:
                    self.metadata_fetches += 1
                    uids = [6] if self.metadata_fetches == 1 else [5]
                    return metadata_response(uids, received_at=now - 30)
                uids = args[0].split(b",")
                return body_response(
                    (uid, self_message(str(100000 + int(uid)))) for uid in uids
                )

        self_message = lambda code: self.message(f"Your verification code is {code}.")
        session = inbox_session.InboxSession({})
        session.connection = FakeConnection()
        session.last_seen_uid = 4

        self.assertEqual([item["uid"] for item in session.recent_items()], [6])
        self.assertEqual(session.last_seen_uid, 6)
        self.assertEqual(session.pending_metadata_uids, {5})
        self.assertEqual([item["uid"] for item in session.recent_items()], [6, 5])
        self.assertEqual(session.pending_metadata_uids, set())

    def test_older_uid_with_newer_arrival_time_can_enter_results(self):
        now = time.time()

        class FakeConnection:
            def uid(self, command, *_args):
                if command == "search":
                    return "OK", [b""]
                return body_response([(1, self_message)])

        self_message = self.message("Your verification code is 482913.")
        session = inbox_session.InboxSession({})
        session.connection = FakeConnection()
        session.last_seen_uid = 10
        session.pending_received_at_by_uid[1] = now - 10
        session.items_by_uid = {
            uid: {"uid": uid, "code": str(uid), "receivedAt": int((now - 60) * 1000)}
            for uid in range(2, 7)
        }

        results = session.recent_items()
        self.assertEqual([item["uid"] for item in results], [1, 6, 5, 4, 3])

    def test_repeated_sender_does_not_hide_older_distinct_sender(self):
        now = time.time()
        message = b"From: other@example.com\r\n\r\nYour code is 482913."

        class FakeConnection:
            def uid(self, command, *_args):
                if command == "search":
                    return "OK", [b""]
                return body_response([(5, message)])

        session = inbox_session.InboxSession({})
        session.connection = FakeConnection()
        session.last_seen_uid = 10
        session.items_by_uid = {
            uid: {
                "uid": uid,
                "code": str(100000 + uid),
                "sender": "same@example.com",
                "receivedAt": int((now - (11 - uid)) * 1000),
            }
            for uid in range(6, 11)
        }
        session.pending_received_at_by_uid[5] = now - 7

        results = session.recent_items()
        self.assertEqual([item["uid"] for item in results], [10, 9, 8, 7, 6, 5])
        self.assertEqual(results[-1]["sender"], "other@example.com")
        self.assertEqual(session.pending_received_at_by_uid, {})


if __name__ == "__main__":
    unittest.main()
