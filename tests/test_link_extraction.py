"""Confirmation link extraction and URL rejection cases."""
from email.message import EmailMessage
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
from link_extraction import extract_link_details

class LinkExtractionTests(unittest.TestCase):
    def message(self, body, subtype="html", subject="Confirm your account"):
        msg = EmailMessage()
        msg["From"] = "Service <hello@example.com>"
        msg["Subject"] = subject
        msg.set_content(body, subtype=subtype)
        return msg.as_bytes()

    def test_button_and_footer(self):
        result = extract_link_details(self.message('<a href="https://example.com/confirm?a=1&amp;b=2"><b>Verify your email</b></a><a href="https://example.com/unsubscribe">Unsubscribe</a>'))
        self.assertEqual(result["url"], "https://example.com/confirm?a=1&b=2")
        self.assertEqual(result["sender"], "hello@example.com")

    def test_plain_text(self):
        result = extract_link_details(self.message('Confirm your account:\nhttps://example.com/activate?token=abc', 'plain'))
        self.assertEqual(result["url"], 'https://example.com/activate?token=abc')

    def test_plain_text_confirmation_does_not_label_a_later_unrelated_url(self):
        body = (
            "Confirm your account by using the button in your dashboard. "
            "For help, read https://example.com/help"
        )
        self.assertIsNone(extract_link_details(self.message(body, "plain")))

    def test_html_and_plain_are_alternative_renderings(self):
        msg = EmailMessage()
        msg["From"] = "Service <hello@example.com>"
        msg["Subject"] = "Verify your email"
        msg.set_content("Confirm your email:\nhttps://example.com/verify?token=real")
        msg.add_alternative('<a href="https://track.example.net/click?id=real">Confirm your email</a>', subtype="html")
        self.assertEqual(extract_link_details(msg.as_bytes())["url"], "https://track.example.net/click?id=real")

    def test_plain_link_is_used_when_html_has_no_visible_confirmation(self):
        msg = EmailMessage()
        msg["From"] = "Service <hello@example.com>"
        msg["Subject"] = "Verify your email"
        msg.set_content("Confirm your email:\nhttps://example.com/verify?token=real")
        msg.add_alternative('<a href="https://example.com/hidden" style="display:none">Confirm your email</a>', subtype="html")
        self.assertEqual(extract_link_details(msg.as_bytes())["url"], "https://example.com/verify?token=real")

    def test_hidden_html_links_do_not_appear_or_conflict(self):
        hidden = [
            '<a hidden href="https://example.com/old">Confirm your email</a>',
            '<div aria-hidden="true"><a href="https://example.com/old">Confirm your email</a></div>',
            '<div style="visibility:hidden"><a href="https://example.com/old">Confirm your email</a></div>',
            '<div style="display:none"><a href="https://example.com/old">Confirm your email</a></div>',
        ]
        visible = '<a href="https://example.com/new"><b>Confirm</b> your email</a>'
        for element in hidden:
            with self.subTest(element=element):
                self.assertIsNone(extract_link_details(self.message(element)))
                self.assertEqual(extract_link_details(self.message(element + visible))["url"], "https://example.com/new")

    def test_reject_ambiguous_unsafe_and_unrelated(self):
        for body in [
            '<a href="https://example.com/a">Confirm account</a><a href="https://example.com/b">Verify email</a>',
            '<a href="javascript:alert(1)">Verify email</a>',
            '<a href="http://example.com">Verify email</a>',
            '<a href="https://user@example.com">Verify email</a>',
            '<a href="https://example.com:444">Verify email</a>',
            '<a href="https://%zz/verify">Verify email</a>',
            '<a href="https://example.com%2F.evil.com/verify">Verify email</a>',
            '<a href="https://example.com">Reset password</a>',
            '<a href="https://example.com">Visit website</a>',
        ]:
            with self.subTest(body=body):
                self.assertIsNone(extract_link_details(self.message(body)))

    def test_duplicate_link_and_password_subject(self):
        body = '<a href="https://example.com/a">Confirm account</a>' * 2
        self.assertIsNotNone(extract_link_details(self.message(body)))
        for subject in ("Reset your password", "Password reset request"):
            with self.subTest(subject=subject):
                self.assertIsNone(extract_link_details(self.message(body, subject=subject)))

    def test_onboarding_subject_can_mention_setting_a_password(self):
        body = '<a href="https://example.com/a">Verify your email</a>'
        result = extract_link_details(
            self.message(body, subject="Verify your email and set your password")
        )
        self.assertEqual(result["url"], "https://example.com/a")

    def test_attachment_ignored(self):
        msg = EmailMessage()
        msg.set_content('Welcome')
        msg.add_attachment(b'<a href="https://example.com">Verify email</a>', maintype='text', subtype='html', filename='attachment.html')
        self.assertIsNone(extract_link_details(msg.as_bytes()))
