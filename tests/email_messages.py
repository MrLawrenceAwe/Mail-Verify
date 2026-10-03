"""Build synthetic raw emails for extraction and inbox-scanning tests."""


def make_raw_email(body, subject="Sign in", subtype="plain", *, sender="Example <auth@example.com>"):
    return (
        f"From: {sender}\r\n"
        f"Subject: {subject}\r\n"
        f"Content-Type: text/{subtype}; charset=utf-8\r\n\r\n{body}"
    ).encode()
