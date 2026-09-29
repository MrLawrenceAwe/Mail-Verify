"""Extract one unambiguous verification code from an email."""

import email
from email import policy
from email.utils import parseaddr
from email_content import VisibleEmailHTMLParser, iter_text_parts
import re

# Reject the first group of a longer, formatted number rather than showing
# a plausible but incomplete code (for example, "1234 5678").
CODE_REGEX = r"(?<![\w.+-])\d{4,8}(?!\w|[.,-]\d|[ ,]\d{4,8}\b)"
PURPOSE_REGEX = r"(?:verification|security|authentication|confirmation|login|sign[ -]?in|one[ -]?time|access)"
LABEL_REGEX = r"(?:code|passcode|otp|pin)"
CODE_PATTERNS = (
    # Indeed and similar providers put the service between the action and code.
    re.compile(
        rf"\b(?:sign[ -]?in|log[ -]?in)\s+to\s+[^.!?\r\n]{{1,80}}?\s+with\s+(?:your\s+)?{LABEL_REGEX}\s*[:=—-]?\s*(?P<code>{CODE_REGEX})",
        re.I,
    ),
    re.compile(
        rf"\b(?:your|the)\s+(?:{PURPOSE_REGEX}\s+)?{LABEL_REGEX}\b\s*(?:is\s*)?[:=—-]?\s*(?P<code>{CODE_REGEX})",
        re.I,
    ),
    re.compile(
        rf"\b{PURPOSE_REGEX}\s+{LABEL_REGEX}\b\s*(?:is\s*)?[:=—-]?\s*(?P<code>{CODE_REGEX})", re.I
    ),
    re.compile(
        rf"\b(?:use|enter)\s+(?P<code>{CODE_REGEX})\s+to\s+(?:verify|sign[ -]?in|log[ -]?in|authenticate|confirm)\b",
        re.I,
    ),
    re.compile(rf"(?P<code>{CODE_REGEX})\s+is\s+your\s+(?:{PURPOSE_REGEX}\s+)?{LABEL_REGEX}\b", re.I),
)


class EmailHTMLTextParser(VisibleEmailHTMLParser):
    BLOCK_TAGS = {"br", "p", "div", "td", "tr", "li", "table", "section", "article", "h1", "h2", "h3"}
    INLINE_BREAK = "\x1f"

    def __init__(self):
        super().__init__()
        self.parts = []

    def visible_start(self, tag, attrs):
        if tag in self.BLOCK_TAGS:
            self.parts.append(" ")

    def visible_end(self, tag):
        self.parts.append(" " if tag in self.BLOCK_TAGS else self.INLINE_BREAK)

    def visible_data(self, data):
        self.parts.append(data)


def extract_code_details(raw):
    msg = email.message_from_bytes(raw, policy=policy.default)
    texts = []
    for content_type, value in iter_text_parts(msg):
        if content_type == "text/html":
            parser = EmailHTMLTextParser()
            parser.feed(value)
            value = "".join(parser.parts)
            value = re.sub(r"(?<=\d)\x1f(?=\d)", "", value).replace(
                EmailHTMLTextParser.INLINE_BREAK, " "
            )
        texts.append(value)
    subject = str(msg.get("Subject", ""))
    codes = set()
    # Keep subject and body separate: a subject such as "Sign in" must not
    # turn an unrelated order number in the body into a verification code.
    for part in (subject, *texts):
        text = re.sub(r"\s+", " ", part)
        for pattern in CODE_PATTERNS:
            for match in pattern.finditer(text):
                codes.add(match.group("code"))
                # Adjacent alternatives, including "123456 (or 654321)", are ambiguous.
                alternative = re.match(
                    rf"\s*(?:[,([]\s*)*(?:or|/)\s*(?:(?:use|enter)\s+)?(?:code\s+)?(?P<code>{CODE_REGEX})",
                    text[match.end() :],
                    re.I,
                )
                if alternative:
                    codes.add(alternative.group("code"))
    # Ambiguous messages are deliberately omitted instead of guessing.
    if len(codes) != 1:
        return None
    sender = parseaddr(str(msg.get("From", "")))[1]
    return {"code": codes.pop(), "sender": sender[:200], "subject": subject[:160]}
