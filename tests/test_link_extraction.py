"""Confirmation link extraction and URL rejection cases."""
from email.message import EmailMessage
from pathlib import Path
import json
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
from link_extraction import extract_confirmation_link_details, extract_password_reset_link_details, is_supported_email_link_url

class ConfirmationLinkExtractionTests(unittest.TestCase):
    def test_email_link_url_policy_matches_extension_cases(self):
        cases = json.loads((Path(__file__).parent / "fixtures/email-link-urls.json").read_text())
        for case in cases:
            with self.subTest(url=case["url"]):
                self.assertEqual(is_supported_email_link_url(case["url"]), case["supported"])
        self.assertFalse(is_supported_email_link_url("https://example.com/" + "a" * 4096))

    def message(self, body, subtype="html", subject="Confirm your account"):
        msg = EmailMessage()
        msg["From"] = "Service <hello@example.com>"
        msg["Subject"] = subject
        msg.set_content(body, subtype=subtype)
        return msg.as_bytes()

    def test_button_and_footer(self):
        result = extract_confirmation_link_details(self.message('<a href="https://example.com/confirm?a=1&amp;b=2"><b>Verify your email</b></a><a href="https://example.com/unsubscribe">Unsubscribe</a>'))
        self.assertEqual(result["url"], "https://example.com/confirm?a=1&b=2")
        self.assertEqual(result["sender"], "hello@example.com")

    def test_plain_text(self):
        result = extract_confirmation_link_details(self.message('Confirm your account:\nhttps://example.com/activate?token=abc', 'plain'))
        self.assertEqual(result["url"], 'https://example.com/activate?token=abc')

    def test_blank_lines_between_instruction_and_url(self):
        for separator in ("\n\n", "\r\n\r\n", "\n \t\n\n"):
            with self.subTest(separator=separator):
                raw = self.message("Verify your email:" + separator + "https://example.com/verify?token=abc", "plain")
                self.assertEqual(extract_confirmation_link_details(raw)["url"], "https://example.com/verify?token=abc")

    def test_unrelated_paragraph_cannot_inherit_confirmation_instruction(self):
        raw = self.message("Verify your email using the dashboard button.\n\nPrivacy policy:\n\nhttps://example.com/privacy", "plain")
        self.assertIsNone(extract_confirmation_link_details(raw))

    def test_plain_text_confirmation_does_not_label_a_later_unrelated_url(self):
        body = (
            "Confirm your account by using the button in your dashboard. "
            "For help, read https://example.com/help"
        )
        self.assertIsNone(extract_confirmation_link_details(self.message(body, "plain")))

    def test_html_and_plain_are_alternative_renderings(self):
        msg = EmailMessage()
        msg["From"] = "Service <hello@example.com>"
        msg["Subject"] = "Verify your email"
        msg.set_content("Confirm your email:\nhttps://example.com/verify?token=real")
        msg.add_alternative('<a href="https://track.example.net/click?id=real">Confirm your email</a>', subtype="html")
        self.assertEqual(extract_confirmation_link_details(msg.as_bytes())["url"], "https://track.example.net/click?id=real")

    def test_plain_link_is_used_when_html_has_no_visible_confirmation(self):
        msg = EmailMessage()
        msg["From"] = "Service <hello@example.com>"
        msg["Subject"] = "Verify your email"
        msg.set_content("Confirm your email:\nhttps://example.com/verify?token=real")
        msg.add_alternative('<a href="https://example.com/hidden" style="display:none">Confirm your email</a>', subtype="html")
        self.assertEqual(extract_confirmation_link_details(msg.as_bytes())["url"], "https://example.com/verify?token=real")

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
                self.assertIsNone(extract_confirmation_link_details(self.message(element)))
                self.assertEqual(extract_confirmation_link_details(self.message(element + visible))["url"], "https://example.com/new")

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
                self.assertIsNone(extract_confirmation_link_details(self.message(body)))

    def test_duplicate_link_and_password_subject(self):
        body = '<a href="https://example.com/a">Confirm account</a>' * 2
        self.assertIsNotNone(extract_confirmation_link_details(self.message(body)))
        for subject in ("Reset your password", "Password reset request"):
            with self.subTest(subject=subject):
                self.assertIsNone(extract_confirmation_link_details(self.message(body, subject=subject)))

    def test_onboarding_subject_can_mention_setting_a_password(self):
        body = '<a href="https://example.com/a">Verify your email</a>'
        result = extract_confirmation_link_details(
            self.message(body, subject="Verify your email and set your password")
        )
        self.assertEqual(result["url"], "https://example.com/a")

    def test_attachment_ignored(self):
        msg = EmailMessage()
        msg.set_content('Welcome')
        msg.add_attachment(b'<a href="https://example.com">Verify email</a>', maintype='text', subtype='html', filename='attachment.html')
        self.assertIsNone(extract_confirmation_link_details(msg.as_bytes()))


    def test_plain_confirmation_footer_does_not_inherit_the_instruction(self):
        raw = self.message("Confirm your email: https://example.com/confirm?token=real\nPrivacy policy: https://example.com/privacy", "plain")
        self.assertEqual(extract_confirmation_link_details(raw)["url"], "https://example.com/confirm?token=real")


class PasswordResetExtractionTests(unittest.TestCase):
    message = ConfirmationLinkExtractionTests.message

    def test_blank_lines_between_instruction_and_url(self):
        for separator in ("\n\n", "\r\n\r\n", "\n \t\n\n"):
            with self.subTest(separator=separator):
                raw = self.message("Reset your password:" + separator + "https://example.com/reset?token=abc", "plain")
                self.assertEqual(extract_password_reset_link_details(raw)["url"], "https://example.com/reset?token=abc")

    def test_unrelated_paragraph_cannot_inherit_reset_instruction(self):
        raw = self.message("Reset your password using the dashboard button.\n\nPrivacy policy:\n\nhttps://example.com/privacy", "plain")
        self.assertIsNone(extract_password_reset_link_details(raw))

    def test_explicit_reset_html_and_plain(self):
        for label in ("Reset your password", "Reset password", "Change my password", "Password reset", "Recover your password"):
            for subtype, body in (("html", f'<a href="https://example.com/reset?token=a&amp;b=2">{label}</a>'),
                                  ("plain", f'{label}:\nhttps://example.com/reset?token=a&b=2')):
                with self.subTest(label=label, subtype=subtype):
                    raw = self.message(body, subtype, "Password reset request")
                    self.assertEqual(extract_password_reset_link_details(raw)["url"], "https://example.com/reset?token=a&b=2")
                    self.assertIsNone(extract_confirmation_link_details(raw))

    def test_reset_rejects_unsafe_hidden_ambiguous_and_unrelated_links(self):
        for body in (
            '<a href="http://example.com/reset">Reset password</a>',
            '<a href="https://user@example.com/reset">Reset password</a>',
            '<a hidden href="https://example.com/reset">Reset password</a>',
            '<a href="https://example.com/a">Reset password</a><a href="https://example.com/b">Reset password</a>',
            '<a href="https://example.com/help">Contact support</a>',
            '<a href="https://example.com/verify">Verify email</a>',
            '<a href="https://example.com/reset">Cancel password reset</a>',
        ):
            with self.subTest(body=body):
                self.assertIsNone(extract_password_reset_link_details(self.message(body, subject="Reset password")))
        self.assertIsNone(extract_password_reset_link_details(self.message(
            "Reset your password using the button. For help visit https://example.com/help", "plain")))

    def test_reset_multipart_prefers_html_and_ignores_attachments(self):
        msg = EmailMessage()
        msg.set_content("Reset your password: https://example.com/reset")
        msg.add_alternative('<a href="https://track.example.com/click">Reset password</a>', subtype="html")
        self.assertEqual(extract_password_reset_link_details(msg.as_bytes())["url"], "https://track.example.com/click")
        attachment = EmailMessage()
        attachment.set_content("Welcome")
        attachment.add_attachment(b'<a href="https://example.com/reset">Reset password</a>', maintype="text", subtype="html", filename="reset.html")
        self.assertIsNone(extract_password_reset_link_details(attachment.as_bytes()))


    def test_help_and_negated_reset_contexts_are_not_reset_actions(self):
        for subtype, body in (
            ("html", '<a href="https://example.com/help">Password reset help</a>'),
            ("html", '<a href="https://example.com/help">Help to reset your password</a>'),
            ("html", '<a href="https://example.com/help">Did not request a password reset?</a>'),
            ("plain", "If you did not request a password reset, contact support at https://example.com/support"),
            ("plain", "If you didn't request this, reset your password at https://example.com/security"),
            ("plain", "For help with your password reset: https://example.com/help"),
        ):
            with self.subTest(body=body):
                self.assertIsNone(extract_password_reset_link_details(self.message(body, subtype, "Password reset")))

    def test_help_link_does_not_hide_the_real_reset_action(self):
        for subtype, body in (
            ("html", '<a href="https://example.com/reset?token=real">Reset your password</a><a href="https://example.com/help">Password reset help</a>'),
            ("plain", "Reset your password: https://example.com/reset?token=real\n\nIf you did not request a password reset, contact support at https://example.com/help"),
        ):
            with self.subTest(subtype=subtype):
                self.assertEqual(extract_password_reset_link_details(self.message(body, subtype, "Password reset"))["url"], "https://example.com/reset?token=real")

    def test_password_reset_link_label_is_supported(self):
        raw = self.message('<a href="https://example.com/reset">Password reset link</a>', subject="Password reset")
        self.assertEqual(extract_password_reset_link_details(raw)["url"], "https://example.com/reset")


    def test_positive_conditional_reset_instructions_are_supported(self):
        for label in (
            "If you requested a password reset, click here to reset your password:",
            "If you'd like to reset your password, use this link:",
        ):
            for subtype, body in (("plain", f"{label} https://example.com/reset?token=real"),
                                  ("html", f'<a href="https://example.com/reset?token=real">{label}</a>')):
                with self.subTest(label=label, subtype=subtype):
                    self.assertEqual(extract_password_reset_link_details(self.message(body, subtype, "Password reset"))["url"], "https://example.com/reset?token=real")

    def test_plain_reset_footer_does_not_inherit_the_instruction(self):
        for separator in ("\n", " ", "\n\n"):
            for footer in ("Privacy policy: https://example.com/privacy", "Visit our website: https://example.com/"):
                with self.subTest(separator=separator, footer=footer):
                    raw = self.message("Reset your password: https://example.com/reset?token=real" + separator + footer, "plain")
                    self.assertEqual(extract_password_reset_link_details(raw)["url"], "https://example.com/reset?token=real")

    def test_explicit_second_reset_url_still_causes_ambiguity(self):
        raw = self.message("Reset your password: https://example.com/reset?token=one\nReset your password: https://example.com/reset?token=two", "plain")
        self.assertIsNone(extract_password_reset_link_details(raw))

    def test_unsupported_preceding_url_cannot_label_a_later_url(self):
        raw = self.message("Reset your password: http://example.com/reset\nPrivacy policy: https://example.com/privacy", "plain")
        self.assertIsNone(extract_password_reset_link_details(raw))
