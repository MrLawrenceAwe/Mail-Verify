# Testing

See the [developer guide](development.md) for architecture, request contracts, and detection rules.

## Automated checks

Run `npm test` for the Python and JavaScript suites. To run them separately or check JavaScript syntax:

```sh
python3 -m unittest discover -s tests -v
node --test tests/test_*.js
npm run check
```

`npm run check` checks JavaScript syntax in source, tests, scripts, and preview modules without executing them. It also checks literal manifest file paths, local static imports and re-exports, and local HTML script and stylesheet references. Content-script module entry points loaded through literal `import(chrome.runtime.getURL("…"))` calls and their static dependencies must be declared as web-accessible resources using the same match patterns as the importing content script. Missing files, missing or unused resource declarations, and syntax errors fail the command. This checks the project's file references, rather than the full Chrome manifest schema or browser behaviour.

The [static checker](../scripts/check-static.js) uses Node's VM module parser with `--experimental-vm-modules`, supplied by the npm command; it never links or evaluates the parsed modules. No package installation is required.

The installer test installs into a temporary directory, launches that copy to verify native-message framing and imports, then checks uninstall cleanup. It does not access Yahoo or Keychain.

Test suites stay at `tests/`; shared harnesses, mocks, and message builders live in `tests/support/`.

JavaScript result builders live in `tests/support/mail_results.js`; code and link messages share metadata without inheriting each other’s result fields. `mock_inline_runtime.js` supplies the fake runtime and its connection ports. Browser fixtures live in `tests/fixtures/`.

`tests/support/mock_native_runtime.js` supplies native ports for background and companion-client tests. Each port owns its listeners, requests, and disconnect state. Tests can reply through a specific port or explicitly deliver a callback queued before disconnection. Concurrent mail-type tests check that responses and session lifetimes remain separate.

The suites use synthetic mail and fake Chrome/IMAP connections. Policy and step-detection suites cover pure matching and filtering; controller suites cover polling and page lifecycle.

`test_mutation_inspection.js` owns shared traversal, node/text budgets, suggestion exclusion, and attribute subtree deduplication checks. Picker and link-card policy suites retain their selectors, context rules, and attribute-specific rediscovery cases.

| Suite | Behaviour groups | Shared harness |
| --- | --- | --- |
| `test_code_picker_steps.js`, `test_code_picker_polling.js`, `test_code_picker_positioning.js`, `test_code_picker_selection.js` | Steps, polling, positioning, selection | `support/code_picker_harness.js` |
| `test_code_picker_position_calculation.js` | Pure positioning calculations and obstacle avoidance | — |
| `test_email_link_card_steps.js`, `test_email_link_card_polling.js`, `test_email_link_card_mutations.js`, `test_email_link_card_selection.js` | Steps, polling, mutations, selection | `support/email_link_card_harness.js` |
| `test_popup_*.js` | Polling, accounts, result selection with the real view | `support/popup_harness.js` |
| `test_code_fields.js` | Detection and filling, including numeric split-digit length checks | `support/verification_field_harness.js` |

The field harness evaluates the serialized entry point in an isolated VM to verify it has no module-scope dependencies. Code-picker split-digit step tests reuse it with their own document overrides.

Code-picker step and selection tests, field tests, and step-context tests use `tests/support/dom_nodes.js` to build explicit element/text-node trees with shared parent and sibling wiring. Field tests define aggregate `textContent` reads locally; step-context tests reject them. Tests update `firstChild.data` to change instructions; the picker harness does not convert plain objects into DOM nodes.

`tests/support/timer_queue.js` stores callbacks for explicit execution by insertion order or requested delay. `runNextWithDelay(registeredDelayMs)` immediately runs the first callback registered with that delay; it does not wait or advance a clock. Code-picker tests select discovery and polling callbacks by delay rather than timer insertion order. When a check is deliberately pending, start the callback, resolve its mocked response, then await completion.

`tests/support/email_messages.py` shares `make_raw_email()` across code extraction, link extraction, and inbox-scanning tests. Its subject, subtype, and sender options describe each synthetic message; multipart and attachment cases build their own MIME structure.

Account-scan and host tests use `tests/support/account_scans.py` to create managers with `TestCase.addCleanup`. Tests that block workers also release and close them before leaving the scan mock.

`tests/support/async_callbacks.js` provides `waitForAsyncCallbacks()` to let pending promise callbacks finish without running queued timers.

## Synthetic previews

Run `python3 -m http.server 8767 --bind 127.0.0.1` from the project root. All previews use synthetic mail. When testing edits, disable caching or use a fresh local port so Chrome reloads imported modules. For fixtures with a replacement delivery button, wait at least one second after resending before delivering the replacement.

In the [interactive code preview](http://127.0.0.1:8767/docs/preview.html?interactive), **Resend email** and **Send again** must immediately clear the old suggestion. Click **Deliver replacement code** and verify that the new suggestion fills `654321`.

### Modal and link-step scenarios

In the reset scenarios, **Update connection status** must retain the offered link. **Change recipient** and **Resend email** must clear it. Start each check with a fresh suggestion.

| Preview | Expected result |
| --- | --- |
| [Code in a modal](http://127.0.0.1:8767/tests/fixtures/modal-suggestions-preview.html?mode=modal-code) | The suggestion fills the verification field in the dialog. |
| [Reset link in a modal](http://127.0.0.1:8767/tests/fixtures/modal-suggestions-preview.html?mode=modal-reset) | The suggestion opens the reset link. |
| [Reset link on the page](http://127.0.0.1:8767/tests/fixtures/modal-suggestions-preview.html?mode=page-reset) | The waiting panel shows the reset suggestion outside a dialog. |
| [Scaled and clipped reset dialog](http://127.0.0.1:8767/tests/fixtures/modal-suggestions-preview.html?mode=modal-reset&transform=1) | The suggestion stays positioned and usable despite the dialog’s transform and clipping. |
| [Stacked dialogs](http://127.0.0.1:8767/tests/fixtures/modal-suggestions-preview.html?mode=modal-reset&stacked=1) and [reversed DOM order](http://127.0.0.1:8767/tests/fixtures/modal-suggestions-preview.html?mode=modal-reset&stacked=reverse) | In both variants the suggestion belongs to the active dialog and remains usable. |

### Verification-step scenarios

In each variant, **Resend SMS code** must retain the email result and **Resend verification email** must clear it. Use **Deliver replacement email** after the resend delay.

| Preview | Additional check |
| --- | --- |
| [Code](http://127.0.0.1:8767/tests/fixtures/verification-step-preview.html?mode=codes) | **Replace identical input** retains the unused code. Selecting it fills the replacement input. |
| [Confirmation link](http://127.0.0.1:8767/tests/fixtures/verification-step-preview.html?mode=confirmationLinks) | The replacement appears as a confirmation suggestion. |
| [Password reset link](http://127.0.0.1:8767/tests/fixtures/verification-step-preview.html?mode=passwordResetLinks) | The replacement appears as a reset suggestion. |
| [Code with both resend controls in one form](http://127.0.0.1:8767/tests/fixtures/verification-step-preview.html?mode=codes&sameForm=1) | **Resend SMS code** still retains the email result when both controls share the form. |

### Field and mounting scenarios

[Independent numeric fields preview](http://127.0.0.1:8767/tests/fixtures/inline-numeric-fields-preview.html) checks two independent full-length numeric verification fields in one form. Selecting the email-code suggestion must fill the email field and retain the phone field’s existing value.

[Mixed numeric fields preview](http://127.0.0.1:8767/tests/fixtures/mixed-numeric-code-preview.html) combines six numeric email-code boxes with a full-length numeric phone-code field. The initial suggestion must fill only the phone field. **Test split email fields** focuses an unlabelled email digit; the next suggestion must fill those six boxes and preserve the phone field.

[Direct code fill preview](http://127.0.0.1:8767/tests/fixtures/direct-code-fill-preview.html) checks direct filling across four independent numeric fields: **Fill selected email code** must report PASS and preserve the other three populated codes.

[Link card modal move preview](http://127.0.0.1:8767/tests/fixtures/link-card-modal-move-preview.html) checks moving the same waiting form between the page and a modal. **Move waiting form into modal** must keep the existing confirmation suggestion accessible inside the dialog; **Return waiting form to page** must restore it outside the dialog with the same result. These checks use synthetic mail only.

## Manual validation

After installing the companion, reloading the extension, and refreshing the test page:

1. Connect a Yahoo account and confirm that it appears in the popup.
2. Request a fresh code on an HTTPS page. Select its on-page suggestion and verify the field value; repeat using the popup.
3. Request a confirmation email. Select its link and verify that the intended destination opens in a new tab.
4. Request a reset email. Select **Open reset link ↗** and verify it opens the reset page in a new tab. Repeat from the toolbar popup.
5. Resend an email and confirm that older on-page results disappear. Hide the tab and confirm checking stops; return and check again.
6. Remove the account and confirm that its results disappear.

These checks require real Yahoo mail and Chrome; automated suites do not establish end-to-end success.
