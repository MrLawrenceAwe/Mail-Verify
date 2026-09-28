"""Extract an unambiguous account confirmation link without visiting it."""
import email
from email import policy
from email.utils import parseaddr
from html.parser import HTMLParser
import re
from urllib.parse import urlsplit

from code_extraction import iter_non_attachment_parts

CONFIRM = re.compile(r"\b(?:verify|confirm|activate)\s+(?:(?:your|my|the|this|new)\s+)?(?:e-?mail(?:\s+address)?|account|registration)\b", re.I)
EXCLUDE = re.compile(r"\b(?:unsubscribe|password|reset|delete|cancel|payment|purchase)\b", re.I)


def safe_url(value):
    if len(value) > 4096 or re.search(r"[\s\x00-\x1f\x7f\\]", value):
        return False
    try:
        parsed = urlsplit(value)
        return (parsed.scheme == "https" and bool(parsed.hostname) and
                not parsed.username and not parsed.password and parsed.port in (None, 443))
    except ValueError:
        return False


class LinkParser(HTMLParser):
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__()
        self.links = []
        self.anchor = None
        self.stack = []

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
        if tag == "a" and not hidden:
            self.anchor = [attrs.get("href", ""), []]
        if tag == "img" and self.anchor and not hidden:
            self.anchor[1].append(attrs.get("alt", ""))
        if tag not in self.VOID_TAGS:
            self.stack.append((tag, hidden))

    def handle_data(self, data):
        if self.anchor and not (self.stack and self.stack[-1][1]):
            self.anchor[1].append(data)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                hidden = self.stack[index][1]
                del self.stack[index:]
                if tag == "a" and self.anchor and not hidden:
                    self.links.append((self.anchor[0], " ".join(self.anchor[1])))
                    self.anchor = None
                break


def extract_link_details(raw):
    msg = email.message_from_bytes(raw, policy=policy.default)
    subject = str(msg.get("Subject", ""))
    if EXCLUDE.search(subject):
        return None
    # HTML and plain text are alternative renderings of one message. Prefer
    # visible HTML links; the text version can use a different tracking URL.
    html_candidates, plain_candidates = set(), set()
    for part in iter_non_attachment_parts(msg):
        if part.get_content_type() not in ("text/html", "text/plain"):
            continue
        try:
            value = part.get_content()
        except (LookupError, UnicodeError):
            continue
        if part.get_content_type() == "text/html":
            parser = LinkParser()
            parser.feed(value)
            links = parser.links
            candidates = html_candidates
        else:
            # Require an explicit confirmation instruction immediately before a URL.
            links = []
            for match in re.finditer(r"https://[^\s<>\"']+", value):
                context = value[max(0, match.start() - 180):match.start()]
                context = re.split(r"\n\s*\n", context)[-1]
                links.append((match.group().rstrip(".,);]"), context))
            candidates = plain_candidates
        for url, label in links:
            label = re.sub(r"\s+", " ", label)
            if CONFIRM.search(label) and not EXCLUDE.search(label) and safe_url(url):
                candidates.add(url)
    candidates = html_candidates if html_candidates else plain_candidates
    if len(candidates) != 1:
        return None
    return {"url": candidates.pop(), "sender": parseaddr(str(msg.get("From", "")))[1][:200],
            "subject": subject[:160]}
