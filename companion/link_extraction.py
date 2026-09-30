"""Extract an unambiguous account confirmation link without visiting it."""
import email
from email import policy
import re
from urllib.parse import urlsplit

from email_content import VisibleEmailHTMLParser, iter_text_parts, message_headers

CONFIRMATION_LABEL_PATTERN = re.compile(r"\b(?:verify|confirm|activate)\s+(?:(?:your|my|the|this|new)\s+)?(?:e-?mail(?:\s+address)?|account|registration)\b", re.I)
EXCLUDED_LABEL_PATTERN = re.compile(r"\b(?:unsubscribe|password|reset|delete|cancel|payment|purchase)\b", re.I)
EXCLUDED_SUBJECT_PATTERN = re.compile(
    r"\b(?:unsubscribe|delete|cancel|payment|purchase)\b|"
    r"\b(?:reset|forgot|change|update|recover)\b.{0,35}\bpassword\b|"
    r"\bpassword\b.{0,35}\b(?:reset|recovery)\b",
    re.I,
)


def is_supported_confirmation_url(value):
    if len(value) > 4096 or re.search(r"[\s\x00-\x1f\x7f\\]", value):
        return False
    try:
        parsed = urlsplit(value)
        # Browsers reject percent-encoded or malformed hostnames that urlsplit
        # accepts, so do not pass those URLs through to the popup renderer.
        return (parsed.scheme == "https" and bool(parsed.hostname) and
                "%" not in parsed.hostname and
                not parsed.username and not parsed.password and parsed.port in (None, 443))
    except ValueError:
        return False


class EmailLinkParser(VisibleEmailHTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.anchor = None

    def visible_start(self, tag, attrs):
        if tag == "a":
            self.anchor = [attrs.get("href", ""), []]
        if tag == "img" and self.anchor:
            self.anchor[1].append(attrs.get("alt", ""))

    def visible_data(self, data):
        if self.anchor:
            self.anchor[1].append(data)

    def visible_end(self, tag):
        if tag == "a" and self.anchor:
            self.links.append((self.anchor[0], " ".join(self.anchor[1])))
            self.anchor = None


def extract_link_details(raw):
    msg = email.message_from_bytes(raw, policy=policy.default)
    subject, headers = message_headers(msg)
    if EXCLUDED_SUBJECT_PATTERN.search(subject):
        return None
    # HTML and plain text are alternative renderings of one message. Prefer
    # visible HTML links; the text version can use a different tracking URL.
    html_candidates, plain_candidates = set(), set()
    for content_type, value in iter_text_parts(msg):
        if content_type == "text/html":
            parser = EmailLinkParser()
            parser.feed(value)
            links = parser.links
            candidates = html_candidates
        else:
            # Require an explicit confirmation instruction immediately before a URL.
            links = []
            for match in re.finditer(r"https://[^\s<>\"']+", value):
                context = value[max(0, match.start() - 180):match.start()]
                context = re.split(r"\n\s*\n", context)[-1]
                # A confirmation phrase in an earlier sentence must not turn a
                # later help, privacy, or other unrelated URL into a candidate.
                sentences = re.split(r"[.!?](?:\s+|$)", context)
                context = next(
                    (sentence for sentence in reversed(sentences) if sentence.strip()),
                    "",
                )
                links.append((match.group().rstrip(".,);]"), context))
            candidates = plain_candidates
        for url, label in links:
            label = re.sub(r"\s+", " ", label)
            if CONFIRMATION_LABEL_PATTERN.search(label) and not EXCLUDED_LABEL_PATTERN.search(label) and is_supported_confirmation_url(url):
                candidates.add(url)
    candidates = html_candidates if html_candidates else plain_candidates
    if len(candidates) != 1:
        return None
    return {"url": candidates.pop(), **headers}
