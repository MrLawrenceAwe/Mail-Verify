"""Email extraction cases."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
from code_extraction import extract_code


class CodeExtractionTests(unittest.TestCase):
    def message(self, body, subject="Sign in", subtype="plain"):
        return f"From: Example <auth@example.com>\r\nSubject: {subject}\r\nContent-Type: text/{subtype}; charset=utf-8\r\n\r\n{body}".encode()

    def test_plain_code(self):
        found = extract_code(self.message("Your verification code is 482913."))
        self.assertEqual(found["code"], "482913")
        self.assertEqual(found["sender"], "auth@example.com")

    def test_plain_your_code(self):
        self.assertEqual(
            extract_code(self.message("Your code is 123456.", subject="Welcome"))[
                "code"
            ],
            "123456",
        )

    def test_subject_code(self):
        self.assertEqual(
            extract_code(self.message("Welcome!", subject="Your code is 123456"))[
                "code"
            ],
            "123456",
        )

    def test_use_to_sign_in(self):
        self.assertEqual(
            extract_code(self.message("Use 123456 to sign in.", subject="Welcome"))[
                "code"
            ],
            "123456",
        )

    def test_indeed_sign_in_with_code(self):
        for subtype, body, subject in (
            ("plain", "Sign in to Indeed with code: 123456", "Indeed"),
            ("plain", "Welcome", "Sign in to Indeed with code: 123456"),
            ("html", "<p>Sign in to Indeed with code: <b>123456</b></p>", "Indeed"),
        ):
            with self.subTest(subtype=subtype, subject=subject):
                self.assertEqual(extract_code(self.message(body, subject, subtype))["code"], "123456")
        self.assertIsNone(extract_code(self.message("Sign in to Indeed with code: 123456 or 654321")))
        self.assertIsNone(extract_code(self.message("Sign in to Indeed. Order code: 123456")))

    def test_html(self):
        self.assertEqual(
            extract_code(
                self.message(
                    "<p>Your security code is</p><b>123456</b>", subtype="html"
                )
            )["code"],
            "123456",
        )

    def test_html_code_split_across_spans(self):
        self.assertEqual(
            extract_code(
                self.message(
                    "<p>Your verification code is <span>123</span><span>456</span></p>",
                    subtype="html",
                )
            )["code"],
            "123456",
        )
        self.assertEqual(
            extract_code(
                self.message(
                    "<span>Your verification code is</span><span>123456</span>",
                    subtype="html",
                )
            )["code"],
            "123456",
        )

    def test_hidden_html_code_ignored(self):
        for hidden in (
            'style="display:none"',
            'style="visibility: hidden"',
            "hidden",
            'aria-hidden="true"',
        ):
            with self.subTest(hidden=hidden):
                body = f"<div {hidden}><p>Your code is 111111</p></div><p>Your code is 222222</p>"
                self.assertEqual(
                    extract_code(self.message(body, subtype="html"))["code"], "222222"
                )

    def test_ambiguous(self):
        self.assertIsNone(
            extract_code(self.message("Your verification code is 123456 or 654321"))
        )

    def test_parenthesized_alternative_is_ambiguous(self):
        self.assertIsNone(
            extract_code(self.message("Your verification code is 123456 (or 654321)."))
        )
        self.assertIsNone(
            extract_code(self.message("Your verification code is 123456, or 654321."))
        )

    def test_alternative_with_verb_is_ambiguous(self):
        self.assertIsNone(
            extract_code(self.message("Your code is 123456 or use 654321 instead."))
        )

    def test_grouped_number_is_not_truncated_to_a_code(self):
        for value in ("1234 5678", "1234,5678"):
            with self.subTest(value=value):
                self.assertIsNone(
                    extract_code(self.message(f"Your verification code is {value}."))
                )

    def test_ordinary_numbers(self):
        self.assertIsNone(
            extract_code(self.message("Order 482913 has shipped.", subject="Receipt"))
        )

    def test_sign_in_subject_does_not_label_order_number(self):
        self.assertIsNone(
            extract_code(
                self.message(
                    "Order #482913 is ready for collection.", subject="Sign in"
                )
            )
        )

    def test_unrelated_date_does_not_make_code_ambiguous(self):
        self.assertEqual(
            extract_code(
                self.message(
                    "Your verification code is 123456. Sent in September 2026."
                )
            )["code"],
            "123456",
        )

    def test_long_number(self):
        self.assertIsNone(
            extract_code(self.message("Your verification reference is 123456789012"))
        )

    def test_duplicate_code(self):
        self.assertEqual(
            extract_code(
                self.message("Your verification code is 123456. Repeat code: 123456")
            )["code"],
            "123456",
        )

    def test_scripts_ignored(self):
        self.assertEqual(
            extract_code(
                self.message(
                    "<script>var security=654321;</script><p>Security code: 123456</p>",
                    subtype="html",
                )
            )["code"],
            "123456",
        )

    def test_attachment_ignored(self):
        from email.message import EmailMessage

        m = EmailMessage()
        m.set_content("Your verification code is 123456")
        m.add_attachment(
            b"Security code 654321",
            maintype="text",
            subtype="plain",
            filename="notes.txt",
        )
        self.assertEqual(extract_code(m.as_bytes())["code"], "123456")

    def test_attached_email_cannot_supply_or_conflict_with_code(self):
        from email.message import EmailMessage

        attached = EmailMessage()
        attached["From"] = "auth@example.com"
        attached.set_content("Your verification code is 654321")
        for body, expected in (
            ("See the attached message.", None),
            ("Your verification code is 123456", "123456"),
        ):
            with self.subTest(body=body):
                outer = EmailMessage()
                outer["From"] = "friend@example.com"
                outer["Subject"] = "Forwarded information"
                outer.set_content(body)
                outer.add_attachment(attached)
                found = extract_code(outer.as_bytes())
                self.assertEqual(found["code"] if found else None, expected)



if __name__ == "__main__":
    unittest.main()
