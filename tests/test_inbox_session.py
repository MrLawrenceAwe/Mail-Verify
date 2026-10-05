"""Bounded and incremental IMAP scanning cases."""

from pathlib import Path
import sys
import time
import socket
import unittest
from email_messages import make_raw_email
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import inbox_session
from imap_responses import body_response, metadata_response


class InboxSessionTests(unittest.TestCase):
    def test_mail_arriving_during_search_retains_its_arrival_time_after_resend(self):
        base = 1_790_000_000
        arrival = base + 1
        for mail_type, body in (
            ("codes", "Your security code is 654321."),
            ("confirmationLinks", "Confirm your account: https://example.test/confirm"),
            ("passwordResetLinks", "Reset your password: https://example.test/reset"),
        ):
            with self.subTest(mail_type=mail_type):
                # The scan starts in the resend's second. A search response
                # includes mail delivered in the next second, after the cutoff.
                now = [base + 0.8]

                class FakeConnection:
                    def uid(self, command, *args):
                        if command == "search":
                            now[0] = max(now[0], base + 1.2)
                            return "OK", [b"101"]
                        if "INTERNALDATE" in args[1]:
                            return metadata_response([101], received_at=arrival)
                        return body_response([(101, make_raw_email(body))])

                    def shutdown(self):
                        pass

                session = inbox_session.InboxSession({}, mail_type)
                session.connection = FakeConnection()
                session.discovery_cursor_uid = 100
                with patch.object(inbox_session.time, "time", side_effect=lambda: now[0]):
                    first = session.scan_inbox()
                    now[0] = base + 2
                    second = session.scan_inbox()
                self.assertEqual(len(first), 1)
                self.assertEqual(first[0]["receivedAt"], arrival * 1000)
                self.assertEqual(second, first)
                session.close()

    def test_partial_initial_metadata_does_not_requeue_processed_bodies(self):
        received_at = time.time() - 60

        class FakeConnection:
            def __init__(self):
                self.metadata_fetches = 0
                self.batches = []

            def select(self, *_args, **_kwargs):
                return "OK", [b"12"]

            def fetch(self, *_args):
                self.metadata_fetches += 1
                # Keep one metadata entry missing while older bodies are scanned.
                first = 2 if self.metadata_fetches < 4 else 1
                return metadata_response(range(first, 13), received_at=received_at)

            def uid(self, command, *args):
                if command == "search":
                    return "OK", [b""]
                uids = [int(uid) for uid in args[0].split(b",")]
                self.batches.append(uids)
                return body_response(
                    (uid, make_raw_email(
                        f"Your code is {100000 + uid}." if uid in (11, 7, 2, 1)
                        else "No code here.", sender=f"sender{uid}@example.test",
                    ))
                    for uid in uids
                    # Missing bodies must remain eligible for a later retry.
                    if not (uid == 12 and len(self.batches) == 1)
                )

            def shutdown(self):
                pass

        connection = FakeConnection()
        with patch.object(inbox_session, "connect_imap", return_value=connection):
            session = inbox_session.InboxSession({})
            self.assertEqual([item["uid"] for item in session.scan_inbox()], [11])
            self.assertEqual([item["uid"] for item in session.scan_inbox()], [11, 7])
            self.assertEqual([item["uid"] for item in session.scan_inbox()], [11, 7, 2])
            self.assertIsNone(session.discovery_cursor_uid)
            self.assertEqual([item["uid"] for item in session.scan_inbox()], [11, 7, 2, 1])
            self.assertEqual(session.discovery_cursor_uid, 12)
            session.scan_inbox()
            self.assertEqual(connection.batches, [
                [12, 11, 10, 9, 8], [12, 7, 6, 5, 4], [3, 2], [1],
            ])
            session.close()

    def test_initial_retry_window_advances_without_redownloading_processed_mail(self):
        received_at = time.time() - 60

        class FakeConnection:
            count = 40

            def __init__(self):
                self.downloaded_uids = []

            def select(self, *_args, **_kwargs):
                return "OK", [str(self.count).encode()]

            def fetch(self, sequence, _parts):
                first, last = map(int, sequence.split(":"))
                return metadata_response(range(first, last), received_at=received_at)

            def uid(self, command, *args):
                self.assert_body_request(command, args)
                uids = [int(uid) for uid in args[0].split(b",")]
                self.downloaded_uids.extend(uids)
                return body_response((uid, make_raw_email("No code here.")) for uid in uids)

            def assert_body_request(self, command, args):
                if command != "fetch" or args[1] != "(UID BODY.PEEK[])":
                    raise AssertionError("Initial discovery must retry sequence metadata")

            def shutdown(self):
                pass

        connection = FakeConnection()
        with patch.object(inbox_session, "connect_imap", return_value=connection):
            session = inbox_session.InboxSession({})
            for _ in range(4):
                self.assertEqual(session.scan_inbox(), [])
                self.assertLessEqual(len(session.initial_processed_body_uids),
                                     inbox_session.MAX_CANDIDATE_MESSAGES)
                connection.count += 1
            self.assertEqual(len(connection.downloaded_uids), 32)
            self.assertEqual(set(connection.downloaded_uids), set(range(11, 43)))
            session.close()
            self.assertEqual(session.initial_processed_body_uids, set())

    def test_scan_inbox_batches_fetches_and_keeps_newest_first(self):
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
            return make_raw_email(
                "Your verification code is " + str(int(uid) + 100000) + "."
            )

        connection = FakeConnection()
        with patch.object(inbox_session, "connect_imap", return_value=connection):
            session = inbox_session.InboxSession(
                {"email": "test@yahoo.com", "password": "unused"}
            )
            codes = session.scan_inbox()
            self.assertEqual(session.scan_inbox(), codes)
            self.assertEqual(
                connection.fetches[1][0], b"7,6,5,4,3",
                "the next poll should inspect older mail for a distinct sender",
            )
            connection.count = 13
            self.assertEqual(session.scan_inbox()[0]["code"], "100013")
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
            self.assertEqual([x["code"] for x in session.scan_inbox()], ["100012"])
            self.assertEqual(connection.batches, [[b"12", b"11", b"10", b"9", b"8"]])
            self.assertEqual(len(session.pending_body_timestamps_seconds), 7)
            connection.count = 13
            self.assertEqual([x["code"] for x in session.scan_inbox()], ["100013", "100012", "100006"])
            self.assertEqual(connection.batches[1], [b"13", b"7", b"6", b"5", b"4"])
            self.assertEqual([x["code"] for x in session.scan_inbox()], ["100013", "100012", "100006", "100001"])
            self.assertEqual(connection.batches[2], [b"3", b"2", b"1"])
            session.scan_inbox()
            self.assertEqual(len(connection.batches), 3)
            session.pending_body_timestamps_seconds[99] = time.time()
            session.close()
            self.assertEqual(session.pending_body_timestamps_seconds, {})

    def test_expired_deferred_mail_is_not_downloaded(self):
        class FakeConnection:
            def uid(self, command, *_args):
                if command != "search":
                    raise AssertionError("Expired mail must not be fetched")
                return "OK", [b""]

        session = inbox_session.InboxSession({})
        session.connection = FakeConnection()
        session.discovery_cursor_uid = 10
        session.pending_body_timestamps_seconds[9] = time.time() - 601
        self.assertEqual(session.scan_inbox(), [])
        self.assertEqual(session.pending_body_timestamps_seconds, {})

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
            self.assertEqual(session.scan_inbox(), [])
        self.assertEqual(connection.sequence, "9971:10000")
        self.assertEqual(session.discovery_cursor_uid, 10000)

    def test_initial_scan_without_codes_uses_bounded_body_batches(self):
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
            self.assertEqual(session.scan_inbox(), [])
        self.assertEqual([len(batch) for batch in connection.body_batches], [5] * 6)
        self.assertEqual(
            [int(uid) for batch in connection.body_batches for uid in batch],
            list(range(30, 0, -1)),
        )
        self.assertFalse(session.pending_body_timestamps_seconds)

    def test_result_in_later_batch_defers_unfetched_bodies_without_redownloading(self):
        class FakeConnection:
            def __init__(self):
                self.body_batches = []

            def uid(self, command, *args):
                if command == "search":
                    return "OK", [b""]
                uids = [int(uid) for uid in args[0].split(b",")]
                self.body_batches.append(uids)
                return body_response(
                    (uid, b"From: auth@example.com\r\n\r\nYour code is 123456."
                     if uid <= 25 else b"No code here.")
                    for uid in uids
                )

        session = inbox_session.InboxSession({})
        connection = session.connection = FakeConnection()
        session.discovery_cursor_uid = 30
        session.pending_body_timestamps_seconds = {
            uid: time.time() - 60 for uid in range(1, 31)
        }

        self.assertEqual([item["uid"] for item in session.scan_inbox()], [25, 24, 23, 22, 21])
        self.assertEqual(connection.body_batches, [[30, 29, 28, 27, 26], [25, 24, 23, 22, 21]])
        self.assertEqual(set(session.pending_body_timestamps_seconds), set(range(1, 21)))

        session.scan_inbox()
        self.assertEqual(connection.body_batches[-1], [20, 19, 18, 17, 16])
        downloaded = [uid for batch in connection.body_batches for uid in batch]
        self.assertEqual(len(downloaded), len(set(downloaded)))

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

        self_message = make_raw_email("Your verification code is 482913.")
        connection = FakeConnection()
        with patch.object(inbox_session, "connect_imap", return_value=connection):
            session = inbox_session.InboxSession(
                {"email": "test@yahoo.com", "password": "unused"}
            )
            first = session.scan_inbox()
            self.assertEqual(first[0]["code"], "482913")
            self.assertLessEqual(first[0]["receivedAt"], int(time.time() * 1000))
            self.assertEqual(session.scan_inbox(), first)
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

        self_message = make_raw_email("Your verification code is 482913.")
        session = inbox_session.InboxSession({})
        connection = session.connection = FakeConnection()
        session.discovery_cursor_uid = 10
        session.pending_body_timestamps_seconds[9] = time.time() - 60

        self.assertEqual(session.scan_inbox(), [])
        self.assertIn(9, session.pending_body_timestamps_seconds)
        self.assertEqual(session.scan_inbox()[0]["code"], "482913")
        self.assertEqual(connection.body_fetches, 2)
        self.assertNotIn(9, session.pending_body_timestamps_seconds)

    def test_missing_metadata_is_retried_after_discovery_cursor_uid_advances(self):
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

        self_message = lambda code: make_raw_email(f"Your verification code is {code}.")
        session = inbox_session.InboxSession({})
        session.connection = FakeConnection()
        session.discovery_cursor_uid = 4

        self.assertEqual([item["uid"] for item in session.scan_inbox()], [6])
        self.assertEqual(session.discovery_cursor_uid, 6)
        self.assertEqual(session.pending_metadata_uids, {5})
        self.assertEqual([item["uid"] for item in session.scan_inbox()], [6, 5])
        self.assertEqual(session.pending_metadata_uids, set())

    def test_older_uid_with_newer_arrival_time_can_enter_results(self):
        now = time.time()

        class FakeConnection:
            def uid(self, command, *_args):
                if command == "search":
                    return "OK", [b""]
                return body_response([(1, self_message)])

        self_message = make_raw_email("Your verification code is 482913.")
        session = inbox_session.InboxSession({})
        session.connection = FakeConnection()
        session.discovery_cursor_uid = 10
        session.pending_body_timestamps_seconds[1] = now - 10
        session.items_by_uid = {
            uid: {"uid": uid, "code": str(uid), "receivedAt": int((now - 60) * 1000)}
            for uid in range(2, 7)
        }

        results = session.scan_inbox()
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
        session.discovery_cursor_uid = 10
        session.items_by_uid = {
            uid: {
                "uid": uid,
                "code": str(100000 + uid),
                "sender": "same@example.com",
                "receivedAt": int((now - (11 - uid)) * 1000),
            }
            for uid in range(6, 11)
        }
        session.pending_body_timestamps_seconds[5] = now - 7

        results = session.scan_inbox()
        self.assertEqual([item["uid"] for item in results], [10, 9, 8, 7, 6, 5])
        self.assertEqual(results[-1]["sender"], "other@example.com")
        self.assertEqual(session.pending_body_timestamps_seconds, {})

    def test_blocked_imap_read_uses_remaining_scan_deadline(self):
        client, server = socket.socketpair()
        connection = inbox_session.DeadlineIMAPConnection.__new__(inbox_session.DeadlineIMAPConnection)
        connection.sock = client
        connection._deadline_timer = None
        connection._deadline = time.monotonic() + 0.02
        try:
            started = time.monotonic()
            with patch.object(inbox_session.imaplib.IMAP4_SSL, "readline",
                              lambda self: self.sock.recv(1)):
                with self.assertRaises(TimeoutError):
                    connection.readline()
            self.assertLess(time.monotonic() - started, 0.5)
            connection.deadline = time.monotonic() - 1
            with self.assertRaisesRegex(inbox_session.UserError, "too long"):
                connection.read(1)
        finally:
            connection.deadline = None
            client.close()
            server.close()

    def test_scan_watchdog_interrupts_a_read_independently_of_socket_timeout(self):
        client, server = socket.socketpair()
        connection = inbox_session.DeadlineIMAPConnection.__new__(inbox_session.DeadlineIMAPConnection)
        connection.sock = client
        connection._deadline_timer = None
        def blocked_read(self):
            self.sock.settimeout(2)
            return self.sock.recv(1)
        try:
            connection.deadline = time.monotonic() + 0.02
            with patch.object(inbox_session.imaplib.IMAP4_SSL, "readline", blocked_read):
                started = time.monotonic()
                self.assertEqual(connection.readline(), b"")
                self.assertLess(time.monotonic() - started, 0.5)
        finally:
            connection.deadline = None
            client.close()
            server.close()


if __name__ == "__main__":
    unittest.main()
