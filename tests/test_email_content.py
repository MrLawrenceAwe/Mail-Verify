"""Visible HTML semantics and malformed-email performance regressions."""

from pathlib import Path
import subprocess
import sys
import textwrap
import unittest

COMPANION_DIR = Path(__file__).resolve().parents[1] / "companion"
sys.path.insert(0, str(COMPANION_DIR))
from email_content import VisibleEmailHTMLParser


class RecordingParser(VisibleEmailHTMLParser):
    def __init__(self):
        super().__init__()
        self.events = []

    def visible_start(self, tag, attrs):
        self.events.append(("start", tag))

    def visible_end(self, tag):
        self.events.append(("end", tag))

    def visible_data(self, data):
        self.events.append(("text", data))


class VisibleEmailHTMLTests(unittest.TestCase):
    def test_unmatched_end_tags_do_not_expose_hidden_content(self):
        parser = RecordingParser()
        parser.feed('<div hidden><span>secret</unknown>still secret</div>visible')
        self.assertEqual(parser.events, [("text", "visible")])

    def test_closing_ancestor_discards_nested_tags_and_restores_visibility(self):
        parser = RecordingParser()
        parser.feed('<div><span hidden><b>secret</div>visible</span></b>')
        self.assertEqual(parser.events, [
            ("start", "div"), ("end", "div"), ("text", "visible"),
        ])

    def test_repeated_tag_closes_innermost_match_across_feed_calls(self):
        parser = RecordingParser()
        parser.feed('<div><div hidden><span>secret</div>visible')
        parser.feed('</span></div><div>next</div>')
        self.assertEqual(parser.events, [
            ("start", "div"), ("text", "visible"), ("end", "div"),
            ("start", "div"), ("text", "next"), ("end", "div"),
        ])

    def test_void_and_self_closing_tags_do_not_leave_hidden_ancestors(self):
        parser = RecordingParser()
        parser.feed('<br hidden><span hidden/>visible')
        self.assertEqual(parser.events, [("text", "visible")])

    def test_large_malformed_email_extracts_codes_and_both_link_types_promptly(self):
        # Run outside the test process so a quadratic regression is terminated
        # instead of consuming a worker indefinitely. The old parser takes
        # over 26 seconds for just the first extraction; allow 10 for all three.
        source = textwrap.dedent('''
            import sys
            sys.path.insert(0, sys.argv[1])
            from code_extraction import extract_code_details
            from link_extraction import (
                extract_confirmation_link_details,
                extract_password_reset_link_details,
            )
            from inbox_session import MAX_MESSAGE_BYTES
            prefix = b"<span>" * 60000 + b"</div>" * 60000
            cases = (
                (extract_code_details, b"Your security code is 123456", "code", "123456"),
                (extract_confirmation_link_details,
                 b'<a href="https://example.com/verify">Verify your email</a>',
                 "url", "https://example.com/verify"),
                (extract_password_reset_link_details,
                 b'<a href="https://example.com/reset">Reset your password</a>',
                 "url", "https://example.com/reset"),
            )
            for extract, body, key, expected in cases:
                raw = b"Subject: Account email\\nContent-Type: text/html\\n\\n" + prefix + body
                assert len(raw) < MAX_MESSAGE_BYTES
                assert extract(raw)[key] == expected
        ''')
        result = subprocess.run(
            [sys.executable, "-c", source, str(COMPANION_DIR)],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
