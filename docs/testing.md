# Testing

See the [developer guide](development.md) for architecture, request contracts, and detection rules.

## Automated checks

Run `npm test` for the Python and JavaScript suites. To run them separately or check JavaScript syntax:

```sh
python3 -m unittest discover -s tests -v
node --test tests/test_*.js
find extension -name "*.js" -exec node --check {} \;
```

The installer test installs into a temporary directory, launches that copy to verify native-message framing and imports, then checks uninstall cleanup. It does not access Yahoo or Keychain.

Test suites stay at `tests/`; shared harnesses, mocks, and message builders live in `tests/support/`. Browser fixtures live in `tests/fixtures/`. The suites use synthetic mail and fake Chrome/IMAP connections. Policy and step-detection suites cover pure matching and filtering; controller suites cover polling and page lifecycle.

| Suite | Behaviour groups | Shared harness |
| --- | --- | --- |
| `test_code_picker_*.js` | Steps, polling, positioning, selection | `support/code_picker_harness.js` |
| `test_email_link_card_*.js` controller suites | Steps, polling, mutations, selection | `support/email_link_card_harness.js` |
| `test_popup_*.js` | Polling, accounts, result selection with the real view | `support/popup_harness.js` |
| `test_code_fields.js` | Detection and filling, including numeric split-digit length checks | `support/verification_field_harness.js` |

The field harness evaluates the serialized entry point in an isolated VM to verify it has no module-scope dependencies.

`tests/support/timer_queue.js` stores callbacks for explicit execution by insertion order or requested delay; it does not advance a clock. `tests/support/email_messages.py` shares `make_raw_email()` across code extraction, link extraction, and inbox-scanning tests. Its subject, subtype, and sender options describe each synthetic message; multipart and attachment cases build their own MIME structure.

`tests/support/async_callbacks.js` provides `waitForAsyncCallbacks()` to let pending promise callbacks finish without running queued timers.

## Synthetic previews

To preview synthetic code suggestions, run `python3 -m http.server 8764 --bind 127.0.0.1` from the project root and open `http://127.0.0.1:8764/docs/preview.html?interactive`. The fixture does not access Yahoo. **Resend email** and **Send again** must immediately clear the old suggestion. Wait at least one second after resending, then click **Deliver replacement code** and verify that the replacement suggestion fills `654321`.

`tests/fixtures/modal-suggestions-preview.html` supplies synthetic mail for modal and link-step checks. Use `?mode=modal-code` to fill a code in a native modal, `?mode=modal-reset` to copy a reset link in a modal, or `?mode=status` for a normal waiting panel. Add `&transform=1` to test a scaled, clipped dialog. **Update connection status** must retain the offered link; **Change recipient** and **Resend email** must clear it. Add `&stacked=1` to open a second modal, or `&stacked=reverse` to put the active modal first in DOM order. Suggestions must belong to the active dialog and remain usable. These fixtures do not access Yahoo. When testing edits, serve with caching disabled or use a fresh local port so Chrome reloads imported modules.

`tests/fixtures/numeric-code-preview.html` checks two independent full-length numeric verification fields in one form. Selecting the email-code suggestion must fill the email field and retain the phone field’s existing value.

`tests/fixtures/mixed-numeric-code-preview.html` combines six numeric email-code boxes with a full-length numeric phone-code field. The initial suggestion must fill only the phone field. **Test split email fields** focuses an unlabelled email digit; the next suggestion must fill those six boxes and preserve the phone field.

`tests/fixtures/verification-step-preview.html` checks resend scope and verification-field replacement. Use `?mode=codes`, `?mode=confirmationLinks`, or `?mode=passwordResetLinks`. **Resend SMS code** must retain the existing email result; **Resend verification email** must clear it. In code mode, **Replace identical input** must retain the unused code, and selecting it must report a successful fill in the current input. Add `&sameForm=1` to place the SMS resend in the same form as the email step; it must still retain the email result. After resending, wait at least one second before **Deliver replacement email**.

## Manual validation

After installing the companion, reloading the extension, and refreshing the test page:

1. Connect a Yahoo account and confirm that it appears in the popup.
2. Request a fresh code on an HTTPS page. Select its on-page suggestion and verify the field value; repeat using the popup.
3. Request a confirmation email. Select its link and verify that the intended destination opens in a new tab.
4. Request a reset email. Copy its link, verify the clipboard value, and use **Copy again** to repeat the copy.
5. Resend an email and confirm that older on-page results disappear. Hide the tab and confirm checking stops; return and check again.
6. Remove the account and confirm that its results disappear.

These checks require real Yahoo mail and Chrome; automated suites do not establish end-to-end success.
