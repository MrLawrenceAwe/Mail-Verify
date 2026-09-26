"""Extract one unambiguous verification code from an email."""

import email
from email import policy
from email.utils import parseaddr
from html.parser import HTMLParser
import re

# Reject the first group of a longer, formatted number rather than showing
# a plausible but incomplete code (for example, "1234 5678").
CODE = r"(?<![\w.+-])\d{4,8}(?!\w|[.,-]\d|[ ,]\d{4,8}\b)"
PURPOSE = r"(?:verification|security|authentication|confirmation|login|sign[ -]?in|one[ -]?time|access)"
LABEL = r"(?:code|passcode|otp|pin)"
CODE_PATTERNS = (
    # Indeed and similar providers put the service between the action and code.
    re.compile(
        rf"\b(?:sign[ -]?in|log[ -]?in)\s+to\s+[^.!?\r\n]{{1,80}}?\s+with\s+(?:your\s+)?{LABEL}\s*[:=—-]?\s*(?P<code>{CODE})",
        re.I,
    ),
    re.compile(
        rf"\b(?:your|the)\s+(?:{PURPOSE}\s+)?{LABEL}\b\s*(?:is\s*)?[:=—-]?\s*(?P<code>{CODE})",
        re.I,
    ),
    re.compile(
        rf"\b{PURPOSE}\s+{LABEL}\b\s*(?:is\s*)?[:=—-]?\s*(?P<code>{CODE})", re.I
    ),
    re.compile(
        rf"\b(?:use|enter)\s+(?P<code>{CODE})\s+to\s+(?:verify|sign[ -]?in|log[ -]?in|authenticate|confirm)\b",
        re.I,
    ),
    re.compile(rf"(?P<code>{CODE})\s+is\s+your\s+(?:{PURPOSE}\s+)?{LABEL}\b", re.I),
)


class EmailTextParser(HTMLParser):
    BLOCK_TAGS = {
        "br",
        "p",
        "div",
        "td",
        "tr",
        "li",
        "table",
        "section",
        "article",
        "h1",
        "h2",
        "h3",
    }
    VOID_TAGS = {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
    INLINE_BREAK = "\x1f"

    def __init__(self):
        super().__init__()
        self.parts = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        style = attrs.get("style") or ""
        hidden = (
            (self.stack[-1][1] if self.stack else False)
            or tag in ("script", "style", "template")
            or "hidden" in attrs
            or (attrs.get("aria-hidden") or "").lower() == "true"
            or bool(
                re.search(
                    r"(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b",
                    style,
                    re.I,
                )
            )
        )
        if not hidden and tag in self.BLOCK_TAGS:
            self.parts.append(" ")
        if tag not in self.VOID_TAGS:
            self.stack.append((tag, hidden))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                hidden = self.stack[index][1]
                del self.stack[index:]
                if not hidden:
                    self.parts.append(
                        " " if tag in self.BLOCK_TAGS else self.INLINE_BREAK
                    )
                break

    def handle_data(self, data):
        if not self.stack or not self.stack[-1][1]:
            self.parts.append(data)


def iter_non_attachment_parts(part):
    if part.get_content_disposition() == "attachment":
        return
    if part.is_multipart():
        for child in part.iter_parts():
            yield from iter_non_attachment_parts(child)
    else:
        yield part


def extract_code(raw):
    msg = email.message_from_bytes(raw, policy=policy.default)
    texts = []
    for part in iter_non_attachment_parts(msg):
        if part.get_content_type() not in ("text/plain", "text/html"):
            continue
        try:
            value = part.get_content()
        except (LookupError, UnicodeError):
            continue
        if part.get_content_type() == "text/html":
            parser = EmailTextParser()
            parser.feed(value)
            value = "".join(parser.parts)
            value = re.sub(r"(?<=\d)\x1f(?=\d)", "", value).replace(
                EmailTextParser.INLINE_BREAK, " "
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
                    rf"\s*(?:[,([]\s*)*(?:or|/)\s*(?:(?:use|enter)\s+)?(?:code\s+)?(?P<code>{CODE})",
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
