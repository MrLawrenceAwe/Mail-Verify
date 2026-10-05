"""Shared traversal of visible email content."""

import re
from html.parser import HTMLParser
from email.utils import parseaddr

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


def extract_message_metadata(message):
    """Return the full matching subject and bounded metadata for display."""
    subject = str(message.get("Subject", ""))
    return subject, {
        "sender": parseaddr(str(message.get("From", "")))[1][:200],
        "subject": subject[:160],
    }


def iter_text_parts(message):
    if message.get_content_disposition() == "attachment":
        return
    if message.is_multipart():
        for child in message.iter_parts():
            yield from iter_text_parts(child)
    elif message.get_content_type() in ("text/plain", "text/html"):
        try:
            yield message.get_content_type(), message.get_content()
        except (LookupError, UnicodeError):
            return


class VisibleEmailHTMLParser(HTMLParser):
    """Dispatch visible HTML events while tracking hidden ancestors."""

    def __init__(self):
        super().__init__()
        self.stack = []
        self.open_tag_indices = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        style = attrs.get("style") or ""
        hidden = (
            (self.stack[-1][1] if self.stack else False)
            or tag in ("script", "style", "template")
            or "hidden" in attrs
            or (attrs.get("aria-hidden") or "").lower() == "true"
            or bool(re.search(r"(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b", style, re.I))
        )
        if not hidden:
            self.visible_start(tag, attrs)
        if tag not in VOID_TAGS:
            self.open_tag_indices.setdefault(tag, []).append(len(self.stack))
            self.stack.append((tag, hidden))

    def handle_endtag(self, tag):
        indices = self.open_tag_indices.get(tag)
        if not indices:
            return
        index = indices[-1]
        hidden = self.stack[index][1]
        # Locate the matching ancestor without searching the stack. Each open
        # element is removed once, keeping malformed HTML processing linear.
        while len(self.stack) > index:
            open_tag, _ = self.stack.pop()
            open_indices = self.open_tag_indices[open_tag]
            open_indices.pop()
            if not open_indices:
                del self.open_tag_indices[open_tag]
        if not hidden:
            self.visible_end(tag)

    def handle_data(self, data):
        if not self.stack or not self.stack[-1][1]:
            self.visible_data(data)

    def visible_start(self, tag, attrs):
        pass

    def visible_end(self, tag):
        pass

    def visible_data(self, data):
        pass
