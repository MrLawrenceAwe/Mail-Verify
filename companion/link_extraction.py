"""Extract an unambiguous confirmation or password reset link without visiting it."""
import email
from email import policy
import re
from urllib.parse import urlsplit

from email_content import VisibleEmailHTMLParser, iter_text_parts, extract_message_metadata

EXCLUDED_ACTIONS_REGEX = r"unsubscribe|delete|cancel|payment|purchase"

CONFIRMATION_LABEL_PATTERN = re.compile(r"\b(?:verify|confirm|activate)\s+(?:(?:your|my|the|this|new)\s+)?(?:e-?mail(?:\s+address)?|account|registration)\b", re.I)
CONFIRMATION_EXCLUDED_LABEL_PATTERN = re.compile(rf"\b(?:{EXCLUDED_ACTIONS_REGEX}|password|reset)\b", re.I)
CONFIRMATION_EXCLUDED_SUBJECT_PATTERN = re.compile(
    rf"\b(?:{EXCLUDED_ACTIONS_REGEX})\b|"
    r"\b(?:reset|forgot|change|update|recover)\b.{0,35}\bpassword\b|"
    r"\bpassword\b.{0,35}\b(?:reset|recovery)\b",
    re.I,
)


def is_supported_email_link_url(value):
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
        self.anchor_url = None
        self.anchor_text_parts = []

    def visible_start(self, tag, attrs):
        if tag == "a":
            self.anchor_url = attrs.get("href", "")
            self.anchor_text_parts = []
        if tag == "img" and self.anchor_url is not None:
            self.anchor_text_parts.append(attrs.get("alt", ""))

    def visible_data(self, data):
        if self.anchor_url is not None:
            self.anchor_text_parts.append(data)

    def visible_end(self, tag):
        if tag == "a" and self.anchor_url is not None:
            self.links.append((self.anchor_url, " ".join(self.anchor_text_parts)))
            self.anchor_url = None
            self.anchor_text_parts = []


RESET_LABEL_PATTERN = re.compile(
    r"\b(?:reset|change|recover)\s+(?:(?:your|my|the|this)\s+)?password\b", re.I,
)
RESET_LINK_LABEL_PATTERN = re.compile(r"password\s+(?:reset|recovery)(?:\s+link)?[\s:!.-]*", re.I)
RESET_UNRELATED_LABEL_PATTERN = re.compile(
    r"\b(?:help|support|contact|troubleshoot(?:ing)?|faq|documentation|learn|not|never)\b|"
    r"\b(?:didn|don|wasn|isn)['’]t\b", re.I,
)
RESET_EXCLUDED_PATTERN = re.compile(rf"\b(?:{EXCLUDED_ACTIONS_REGEX})\b", re.I)


def extract_confirmation_link_details(raw_message):
    return extract_labelled_link(raw_message, CONFIRMATION_LABEL_PATTERN.search, CONFIRMATION_EXCLUDED_LABEL_PATTERN, CONFIRMATION_EXCLUDED_SUBJECT_PATTERN)


def extract_password_reset_link_details(raw_message):
    return extract_labelled_link(raw_message, is_password_reset_label, RESET_EXCLUDED_PATTERN, RESET_EXCLUDED_PATTERN)


def is_password_reset_label(label):
    if RESET_UNRELATED_LABEL_PATTERN.search(label):
        return False
    return bool(RESET_LABEL_PATTERN.search(label) or RESET_LINK_LABEL_PATTERN.fullmatch(label.strip()))


def extract_labelled_link(raw_message, label_matches, excluded_label_pattern, excluded_subject_pattern):
    message = email.message_from_bytes(raw_message, policy=policy.default)
    subject, display_metadata = extract_message_metadata(message)
    if excluded_subject_pattern.search(subject):
        return None
    # HTML and plain text are alternative renderings of one message. Prefer
    # visible HTML links; the text version can use a different tracking URL.
    html_candidates, plain_candidates = set(), set()
    for content_type, value in iter_text_parts(message):
        if content_type == "text/html":
            parser = EmailLinkParser()
            parser.feed(value)
            links = parser.links
            candidates = html_candidates
        else:
            # Require an explicit link instruction immediately before a URL.
            links = []
            previous_url_end = 0
            for match in re.finditer(r"https?://[^\s<>\"']+", value):
                # Even an unsupported HTTP URL ends its instruction; it must
                # not label a later HTTPS footer URL.
                context = value[max(previous_url_end, match.start() - 180):match.start()]
                previous_url_end = match.end()
                # Blank lines before the URL are layout, not a new paragraph.
                # Keep only the last nonempty paragraph so unrelated prose
                # still separates a footer URL from an earlier instruction.
                context = re.split(r"\n\s*\n", context.rstrip())[-1]
                # An action phrase in an earlier sentence must not turn a
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
            if label_matches(label) and not excluded_label_pattern.search(label) and is_supported_email_link_url(url):
                candidates.add(url)
    candidates = html_candidates if html_candidates else plain_candidates
    if len(candidates) != 1:
        return None
    return {"url": candidates.pop(), **display_metadata}
