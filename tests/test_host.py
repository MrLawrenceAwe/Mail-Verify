import io
import json
from pathlib import Path
import struct
import sys
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
import host

class ExtractionTests(unittest.TestCase):
    def message(self, body, subject='Sign in', subtype='plain'):
        return f'From: Example <auth@example.com>\r\nSubject: {subject}\r\nContent-Type: text/{subtype}; charset=utf-8\r\n\r\n{body}'.encode()
    def test_plain_code(self):
        found=host.extract_codes(self.message('Your verification code is 482913.'))
        self.assertEqual(found['code'],'482913')
        self.assertEqual(found['sender'],'auth@example.com')
    def test_plain_your_code(self):
        self.assertEqual(host.extract_codes(self.message('Your code is 123456.',subject='Welcome'))['code'],'123456')
    def test_subject_code(self):
        self.assertEqual(host.extract_codes(self.message('Welcome!',subject='Your code is 123456'))['code'],'123456')
    def test_use_to_sign_in(self):
        self.assertEqual(host.extract_codes(self.message('Use 123456 to sign in.',subject='Welcome'))['code'],'123456')
    def test_html(self):
        self.assertEqual(host.extract_codes(self.message('<p>Your security code is</p><b>123456</b>',subtype='html'))['code'],'123456')
    def test_html_code_split_across_spans(self):
        self.assertEqual(host.extract_codes(self.message('<p>Your verification code is <span>123</span><span>456</span></p>',subtype='html'))['code'],'123456')
        self.assertEqual(host.extract_codes(self.message('<span>Your verification code is</span><span>123456</span>',subtype='html'))['code'],'123456')
    def test_hidden_html_code_ignored(self):
        for hidden in ('style="display:none"', 'style="visibility: hidden"', 'hidden', 'aria-hidden="true"'):
            with self.subTest(hidden=hidden):
                body=f'<div {hidden}><p>Your code is 111111</p></div><p>Your code is 222222</p>'
                self.assertEqual(host.extract_codes(self.message(body,subtype='html'))['code'],'222222')
    def test_ambiguous(self):
        self.assertIsNone(host.extract_codes(self.message('Your verification code is 123456 or 654321')))
    def test_parenthesized_alternative_is_ambiguous(self):
        self.assertIsNone(host.extract_codes(self.message('Your verification code is 123456 (or 654321).')))
        self.assertIsNone(host.extract_codes(self.message('Your verification code is 123456, or 654321.')))
    def test_ordinary_numbers(self):
        self.assertIsNone(host.extract_codes(self.message('Order 482913 has shipped.',subject='Receipt')))
    def test_sign_in_subject_does_not_label_order_number(self):
        self.assertIsNone(host.extract_codes(self.message('Order #482913 is ready for collection.',subject='Sign in')))
    def test_unrelated_date_does_not_make_code_ambiguous(self):
        self.assertEqual(host.extract_codes(self.message('Your verification code is 123456. Sent in September 2026.'))['code'],'123456')
    def test_long_number(self):
        self.assertIsNone(host.extract_codes(self.message('Your verification reference is 123456789012')))
    def test_duplicate_code(self):
        self.assertEqual(host.extract_codes(self.message('Your verification code is 123456. Repeat code: 123456'))['code'],'123456')
    def test_scripts_ignored(self):
        self.assertEqual(host.extract_codes(self.message('<script>var security=654321;</script><p>Security code: 123456</p>',subtype='html'))['code'],'123456')
    def test_attachment_ignored(self):
        from email.message import EmailMessage
        m=EmailMessage();m.set_content('Your verification code is 123456')
        m.add_attachment(b'Security code 654321',maintype='text',subtype='plain',filename='notes.txt')
        self.assertEqual(host.extract_codes(m.as_bytes())['code'],'123456')
    def test_frame(self):
        p=json.dumps({'action':'status'}).encode()
        self.assertEqual(host.read_message(io.BytesIO(struct.pack('=I',len(p))+p)),{'action':'status'})
    def test_large_frame_rejected(self):
        with self.assertRaises(ValueError):host.read_message(io.BytesIO(struct.pack('=I',20000)))
    def test_truncated_frame_rejected(self):
        with self.assertRaises(ValueError):host.read_message(io.BytesIO(struct.pack('=I',10)+b'{}'))
    def test_configure_does_not_store_failed_login(self):
        with patch.object(host,'connect',side_effect=host.imaplib.IMAP4.error()), patch.object(host,'keychain') as keychain:
            with self.assertRaises(host.imaplib.IMAP4.error):host.handle({'action':'configure','email':'test@yahoo.com','password':'abcdefghijklmnop'},host.MailSession(None))
            keychain.assert_not_called()

    def test_recent_codes_batches_fetches_and_keeps_newest_first(self):
        class FakeConnection:
            def __init__(self): self.fetches=[]; self.searches=[]; self.sequence_fetches=[]; self.closed=False; self.count=12
            def select(self, *_args, **_kwargs): return 'OK', [str(self.count).encode()]
            def fetch(self, sequence, _parts):
                self.sequence_fetches.append(sequence)
                first, last = map(int, sequence.split(':'))
                date = host.imaplib.Time2Internaldate(time.time()-60).encode()
                return 'OK', [b'1 (UID '+str(uid).encode()+b' INTERNALDATE '+date+b' RFC822.SIZE 100)' for uid in range(first, last+1)]
            def uid(self, command, *args):
                if command == 'search':
                    self.searches.append(args)
                    ids = range(min(int(args[2].split(':')[0]), self.count), self.count + 1)
                    return 'OK', [b' '.join(str(i).encode() for i in ids)]
                self.fetches.append(args)
                uids = args[0].split(b',')
                if 'INTERNALDATE' in args[1]:
                    date = host.imaplib.Time2Internaldate(time.time()-60).encode()
                    return 'OK', [b'1 (UID '+uid+b' INTERNALDATE '+date+b' RFC822.SIZE 100)' for uid in uids]
                return 'OK', [(b'1 (UID '+uid+b' BODY[] {80}',
                               self_message(uid)) for uid in uids]
            def shutdown(self): self.closed=True
        def self_message(uid):
            return self.message('Your verification code is '+str(int(uid)+100000)+'.')
        conn=FakeConnection()
        with patch.object(host,'connect',return_value=conn):
            session=host.MailSession({'email':'test@yahoo.com','password':'unused'})
            codes=session.recent_codes()
            self.assertEqual(session.recent_codes(),codes)
            self.assertEqual(len(conn.fetches),1,'unchanged mail should not be fetched again')
            conn.count=13
            self.assertEqual(session.recent_codes()[0]['code'],'100013')
            self.assertEqual(conn.fetches[1][0],b'13')
            self.assertEqual(conn.fetches[2][0],b'13')
            session.close()
        self.assertEqual([item['code'] for item in codes],['100012','100011','100010','100009','100008'])
        self.assertEqual(len(conn.fetches),3)
        self.assertEqual(conn.sequence_fetches,['1:12'])
        self.assertEqual(conn.fetches[0][0],b'12,11,10,9,8')
        self.assertEqual(conn.searches[0],(None,'UID','13:*'))
        self.assertTrue(conn.closed)

    def test_initial_scan_is_bounded_to_newest_30_messages(self):
        class FakeConnection:
            def select(self, *_args, **_kwargs): return 'OK', [b'10000']
            def fetch(self, sequence, _parts):
                self.sequence = sequence
                date = host.imaplib.Time2Internaldate(time.time()-3600).encode()
                return 'OK', [b'1 (UID '+str(uid).encode()+b' INTERNALDATE '+date+b' RFC822.SIZE 100)' for uid in range(9971,10001)]
            def uid(self, *_args): raise AssertionError('No UID search or body fetch is needed for old mail')
            def shutdown(self): pass
        conn=FakeConnection()
        with patch.object(host,'connect',return_value=conn):
            session=host.MailSession({'email':'test@yahoo.com','password':'unused'})
            self.assertEqual(session.recent_codes(),[])
        self.assertEqual(conn.sequence,'9971:10000')
        self.assertEqual(session.last_uid,10000)

    def test_whole_check_times_out(self):
        with patch.object(host,'CHECK_TIMEOUT',0.01), patch.object(host.MailSession,'recent_codes',side_effect=lambda: time.sleep(0.2)):
            with self.assertRaisesRegex(host.UserError,'too long'):
                host.timed_check(host.MailSession({}))

if __name__=='__main__': unittest.main()
