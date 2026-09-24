#!/usr/bin/env python3
"""Local Yahoo IMAP bridge. stdout is reserved for Chrome native messaging."""
import ctypes
import email
from email import policy
from email.utils import parseaddr
from html.parser import HTMLParser
import imaplib
import json
import re
import signal
import socket
import ssl
import struct
import sys
import time

SERVICE = b'local.yahoo_code_fill'
ACCOUNT = b'mailbox'
MAX_AGE = 600
MAX_FUTURE_SKEW = 120
CHECK_TIMEOUT = 25
FETCH_BATCH = 5
CODE = r'(?<![\w.+-])\d{4,8}(?!\w|[.-]\d)'
PURPOSE = r'(?:verification|security|authentication|confirmation|login|sign[ -]?in|one[ -]?time|access)'
LABEL = r'(?:code|passcode|otp|pin)'
CODE_PATTERNS = (
    re.compile(rf'\b(?:your|the)\s+(?:{PURPOSE}\s+)?{LABEL}\b\s*(?:is\s*)?[:=—-]?\s*(?P<code>{CODE})', re.I),
    re.compile(rf'\b{PURPOSE}\s+{LABEL}\b\s*(?:is\s*)?[:=—-]?\s*(?P<code>{CODE})', re.I),
    re.compile(rf'\b(?:use|enter)\s+(?P<code>{CODE})\s+to\s+(?:verify|sign[ -]?in|log[ -]?in|authenticate|confirm)\b', re.I),
    re.compile(rf'(?P<code>{CODE})\s+is\s+your\s+(?:{PURPOSE}\s+)?{LABEL}\b', re.I),
)

class UserError(Exception):
    pass

class TextHTML(HTMLParser):
    BLOCK_TAGS = {'br', 'p', 'div', 'td', 'tr', 'li', 'table', 'section', 'article', 'h1', 'h2', 'h3'}
    VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
    INLINE_BREAK = '\x1f'
    def __init__(self):
        super().__init__()
        self.parts = []
        self.stack = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        style = attrs.get('style') or ''
        hidden = (self.stack[-1][1] if self.stack else False) or tag in ('script', 'style', 'template') or 'hidden' in attrs or (attrs.get('aria-hidden') or '').lower() == 'true' or bool(re.search(r'(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b', style, re.I))
        if not hidden and tag in self.BLOCK_TAGS: self.parts.append(' ')
        if tag not in self.VOID_TAGS: self.stack.append((tag, hidden))
    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                hidden = self.stack[index][1]
                del self.stack[index:]
                if not hidden: self.parts.append(' ' if tag in self.BLOCK_TAGS else self.INLINE_BREAK)
                break
    def handle_data(self, data):
        if not self.stack or not self.stack[-1][1]: self.parts.append(data)

def extract_codes(raw):
    msg = email.message_from_bytes(raw, policy=policy.default)
    texts = []
    for part in msg.walk():
        if part.get_content_disposition() == 'attachment': continue
        if part.get_content_type() not in ('text/plain', 'text/html'): continue
        try: value = part.get_content()
        except (LookupError, UnicodeError): continue
        if part.get_content_type() == 'text/html':
            parser = TextHTML()
            parser.feed(value)
            value = ''.join(parser.parts)
            value = re.sub(r'(?<=\d)\x1f(?=\d)', '', value).replace(TextHTML.INLINE_BREAK, ' ')
        texts.append(value)
    subject = str(msg.get('Subject', ''))
    codes = set()
    # Keep subject and body separate: a subject such as "Sign in" must not
    # turn an unrelated order number in the body into a verification code.
    for part in (subject, *texts):
        text = re.sub(r'\s+', ' ', part)
        for pattern in CODE_PATTERNS:
            for match in pattern.finditer(text):
                codes.add(match.group('code'))
                # Adjacent alternatives, including "123456 (or 654321)", are ambiguous.
                alternative = re.match(rf'\s*(?:[,([]\s*)*(?:or|/)\s*(?P<code>{CODE})', text[match.end():], re.I)
                if alternative: codes.add(alternative.group('code'))
    # Ambiguous messages are deliberately omitted instead of guessing.
    if len(codes) != 1: return None
    sender = parseaddr(str(msg.get('From', '')))[1]
    return {'code': codes.pop(), 'sender': sender[:200], 'subject': subject[:160]}

def keychain(action, value=None):
    lib = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    void = ctypes.c_void_p
    uint = ctypes.c_uint32
    lib.SecKeychainFindGenericPassword.argtypes = [void, uint, void, uint, void, ctypes.POINTER(uint), ctypes.POINTER(void), ctypes.POINTER(void)]
    lib.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    lib.SecKeychainItemFreeContent.argtypes = [void, void]
    lib.SecKeychainItemModifyAttributesAndData.argtypes = [void, void, uint, void]
    lib.SecKeychainAddGenericPassword.argtypes = [void, uint, void, uint, void, uint, void, ctypes.POINTER(void)]
    lib.SecKeychainItemDelete.argtypes = [void]
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    cf.CFRelease.argtypes = [void]
    size, data, item = uint(), void(), void()
    status = lib.SecKeychainFindGenericPassword(None, len(SERVICE), SERVICE, len(ACCOUNT), ACCOUNT, ctypes.byref(size), ctypes.byref(data), ctypes.byref(item))
    if status not in (0, -25300): raise UserError('Keychain access was denied or unavailable. Unlock your login Keychain and try again.')
    try:
        if action == 'get':
            return json.loads(ctypes.string_at(data, size.value)) if status == 0 else None
        if action == 'delete':
            result = lib.SecKeychainItemDelete(item) if status == 0 else 0
        elif action == 'set':
            payload = json.dumps(value).encode()
            result = (lib.SecKeychainItemModifyAttributesAndData(item, None, len(payload), payload) if status == 0 else lib.SecKeychainAddGenericPassword(None, len(SERVICE), SERVICE, len(ACCOUNT), ACCOUNT, len(payload), payload, None))
        else: raise UserError('Unsupported Keychain operation.')
        if result: raise UserError('Could not update the login Keychain.')
    finally:
        if data: lib.SecKeychainItemFreeContent(None, data)
        if item: cf.CFRelease(item)


def connect(credentials):
    conn = imaplib.IMAP4_SSL('imap.mail.yahoo.com', 993, ssl_context=ssl.create_default_context(), timeout=15)
    try:
        conn.login(credentials['email'], credentials['password'])
        return conn
    except Exception:
        try: conn.shutdown()
        except Exception: pass
        raise


class MailSession:
    def __init__(self, credentials):
        self.credentials = credentials
        self.conn = None
        self.last_uid = None
        self.mailbox_count = 0
        self.codes = {}

    def close(self):
        conn, self.conn = self.conn, None
        self.last_uid = None
        self.mailbox_count = 0
        self.codes.clear()
        if conn:
            try: conn.shutdown()
            except (OSError, imaplib.IMAP4.error): pass

    def recent_codes(self):
        try:
            if self.conn is None:
                self.conn = connect(self.credentials)
                status, count = self.conn.select('INBOX', readonly=True)
                if status != 'OK': raise UserError('Yahoo could not open your inbox.')
                self.mailbox_count = int(count[0])
            now = time.time()
            self.codes = {uid: item for uid, item in self.codes.items()
                          if 0 <= now - item['receivedAt'] / 1000 <= MAX_AGE}
            if self.last_uid is None:
                # Sequence numbers let the server return only the newest 30
                # messages instead of every UID received during the past day.
                if not self.mailbox_count:
                    self.last_uid = 0
                    return self._results()
                first = max(1, self.mailbox_count - 29)
                status, metadata = self.conn.fetch(f'{first}:{self.mailbox_count}', '(UID INTERNALDATE RFC822.SIZE)')
                if status != 'OK': raise UserError('Yahoo could not inspect recent messages.')
                uids = [match.group(1) for entry in metadata if isinstance(entry, bytes)
                        if (match := re.search(rb'\bUID (\d+)\b', entry))]
                self.last_uid = max(map(int, uids), default=0)
            else:
                status, data = self.conn.uid('search', None, 'UID', f'{self.last_uid + 1}:*')
                if status != 'OK': raise UserError('Yahoo could not search your inbox.')
                all_uids = data[0].split()
                # UID ranges ending in * can return the previous last UID when no new mail exists.
                all_uids = [uid for uid in all_uids if int(uid) > self.last_uid]
                uids = all_uids[-30:]
                if all_uids: self.last_uid = int(all_uids[-1])
                if uids:
                    status, metadata = self.conn.uid('fetch', b','.join(uids), '(UID INTERNALDATE RFC822.SIZE)')
                    if status != 'OK': raise UserError('Yahoo could not inspect recent messages.')
            if not uids: return self._results()
            eligible = {}
            for entry in metadata:
                if not isinstance(entry, bytes): continue
                uid = re.search(rb'\bUID (\d+)\b', entry)
                date = imaplib.Internaldate2tuple(entry)
                size = re.search(rb'\bRFC822.SIZE (\d+)\b', entry)
                if not uid or not date or not size or int(size.group(1)) > 1_000_000: continue
                received = time.mktime(date)
                if -MAX_FUTURE_SKEW <= now - received <= MAX_AGE:
                    eligible[uid.group(1)] = min(received, now)
            candidates = [uid for uid in reversed(uids) if uid in eligible]
            new_found = 0
            for start in range(0, len(candidates), FETCH_BATCH):
                batch = candidates[start:start + FETCH_BATCH]
                status, body = self.conn.uid('fetch', b','.join(batch), '(UID BODY.PEEK[])')
                if status != 'OK': raise UserError('Yahoo could not read recent messages.')
                messages = {}
                for entry in body:
                    if not isinstance(entry, tuple): continue
                    uid = re.search(rb'\bUID (\d+)\b', entry[0])
                    if uid: messages[uid.group(1)] = entry[1]
                for uid in batch:
                    found = extract_codes(messages[uid]) if uid in messages else None
                    if found:
                        found['receivedAt'] = int(eligible[uid] * 1000)
                        self.codes[int(uid)] = found
                        new_found += 1
                    if new_found == 5: break
                if new_found == 5: break
            return self._results()
        except Exception:
            self.close()
            raise

    def _results(self):
        return [item for _, item in sorted(self.codes.items(), reverse=True)[:5]]


def timed_check(session):
    def timeout(_signum, _frame):
        raise UserError('Yahoo took too long to respond. Try checking again.')
    previous = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, CHECK_TIMEOUT)
    try:
        return session.recent_codes()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def handle(request, session):
    if not isinstance(request, dict): raise UserError('Invalid request.')
    action = request.get('action')
    if action == 'status':
        credentials = keychain('get')
        return {'email': credentials['email'] if credentials else None}
    if action == 'disconnect':
        keychain('delete')
        session.close()
        session.credentials = None
        return {'disconnected': True}
    if action == 'configure':
        address = request.get('email', '').strip()
        password = request.get('password', '').replace(' ', '')
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', address) or not 8 <= len(password) <= 128:
            raise UserError('Enter your Yahoo email address and a Yahoo app password.')
        credentials = {'email': address, 'password': password}
        with connect(credentials): pass
        keychain('set', credentials)
        session.close()
        session.credentials = credentials
        return {'email': address}
    if action == 'codes':
        if session.credentials is None:
            session.credentials = keychain('get')
        if not session.credentials: raise UserError('Connect Yahoo Mail first.')
        return {'codes': timed_check(session)}
    raise UserError('Unsupported request.')


def read_message(stream):
    header = stream.read(4)
    if not header: return None
    if len(header) != 4: raise ValueError('Incomplete frame')
    length = struct.unpack('=I', header)[0]
    if not 0 < length <= 16384: raise ValueError('Invalid frame size')
    payload = stream.read(length)
    if len(payload) != length: raise ValueError('Incomplete payload')
    return json.loads(payload)


def main():
    session = MailSession(None)
    try:
        while True:
            try:
                request = read_message(sys.stdin.buffer)
                if request is None: break
                response = {'ok': True, **handle(request, session)}
            except UserError as exc: response = {'ok': False, 'error': str(exc)}
            except imaplib.IMAP4.error: response = {'ok': False, 'error': 'Yahoo rejected the connection. Check your email and app password, then reconnect.'}
            except (OSError, socket.timeout): response = {'ok': False, 'error': 'Could not reach Yahoo Mail or the local Keychain. Check your connection and try again.'}
            except Exception: response = {'ok': False, 'error': 'The local companion could not complete this request.'}
            payload = json.dumps(response).encode()
            sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
            sys.stdout.buffer.flush()
    finally:
        session.close()

if __name__ == '__main__': main()
