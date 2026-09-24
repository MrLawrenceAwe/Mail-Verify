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
import socket
import ssl
import struct
import sys
import time

SERVICE = b'local.yahoo_code_fill'
ACCOUNT = b'mailbox'
MAX_AGE = 600
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
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'): self.hidden += 1
        if tag in ('br', 'p', 'div', 'td'): self.parts.append(' ')
    def handle_endtag(self, tag):
        if tag in ('script', 'style'): self.hidden = max(0, self.hidden - 1)
        self.parts.append(' ')
    def handle_data(self, data):
        if not self.hidden: self.parts.append(data)

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
                # "Your code is 123456 or 654321" offers two choices.
                alternative = re.match(rf'\s*(?:or|/)\s*(?P<code>{CODE})', text[match.end():], re.I)
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


def recent_codes(credentials):
    with connect(credentials) as conn:
        status, _ = conn.select('INBOX', readonly=True)
        if status != 'OK': raise UserError('Yahoo could not open your inbox.')
        since = time.strftime('%d-%b-%Y', time.gmtime(time.time()-86400))
        status, data = conn.uid('search', None, 'SINCE', since)
        if status != 'OK': raise UserError('Yahoo could not search your inbox.')
        results = []
        for uid in reversed(data[0].split()[-30:]):
            status, metadata = conn.uid('fetch', uid, '(INTERNALDATE RFC822.SIZE)')
            if status != 'OK': continue
            header = b' '.join(x for x in metadata if isinstance(x, bytes))
            date = imaplib.Internaldate2tuple(header)
            size = re.search(rb'RFC822.SIZE (\d+)', header)
            if not date or not size or int(size.group(1)) > 1_000_000: continue
            received = time.mktime(date)
            if not 0 <= time.time()-received <= MAX_AGE: continue
            status, body = conn.uid('fetch', uid, '(BODY.PEEK[])')
            if status != 'OK': continue
            raw = next((x[1] for x in body if isinstance(x, tuple)), None)
            found = extract_codes(raw) if raw else None
            if found:
                found['receivedAt'] = int(received * 1000)
                results.append(found)
            if len(results) == 5: break
        return results


def handle(request):
    if not isinstance(request, dict): raise UserError('Invalid request.')
    action = request.get('action')
    if action == 'status':
        credentials = keychain('get')
        return {'email': credentials['email'] if credentials else None}
    if action == 'disconnect':
        keychain('delete')
        return {'disconnected': True}
    if action == 'configure':
        address = request.get('email', '').strip()
        password = request.get('password', '').replace(' ', '')
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', address) or not 8 <= len(password) <= 128:
            raise UserError('Enter your Yahoo email address and a Yahoo app password.')
        credentials = {'email': address, 'password': password}
        with connect(credentials): pass
        keychain('set', credentials)
        return {'email': address}
    if action == 'codes':
        credentials = keychain('get')
        if not credentials: raise UserError('Connect Yahoo Mail first.')
        return {'codes': recent_codes(credentials)}
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
    try:
        request = read_message(sys.stdin.buffer)
        if request is None: return
        response = {'ok': True, **handle(request)}
    except UserError as exc: response = {'ok': False, 'error': str(exc)}
    except imaplib.IMAP4.error: response = {'ok': False, 'error': 'Yahoo rejected the connection. Check your email and app password, then reconnect.'}
    except (OSError, socket.timeout): response = {'ok': False, 'error': 'Could not reach Yahoo Mail or the local Keychain. Check your connection and try again.'}
    except Exception: response = {'ok': False, 'error': 'The local companion could not complete this request.'}
    payload = json.dumps(response).encode()
    sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
    sys.stdout.buffer.flush()

if __name__ == '__main__': main()
