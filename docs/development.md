# Development

Python uses its standard library and the macOS Security framework. JavaScript uses native ES modules without a bundler. No package installation is required.

## Checks and preview

Run `npm test` for the Python and JavaScript suites. To run them separately or check JavaScript syntax:

```sh
python3 -m unittest discover -s tests -v
node --test tests/test_*.js
find extension -name "*.js" -exec node --check {} \;
```

The installer test installs into a temporary directory, launches that copy to verify native-message framing and imports, then checks uninstall cleanup. It does not access Yahoo or Keychain.

To preview synthetic code suggestions, run `python3 -m http.server 8764 --bind 127.0.0.1` from the project root and open `http://127.0.0.1:8764/tests/fixtures/code-picker-preview.html`. The fixture does not access Yahoo. **Resend email** and **Send again** must immediately clear the old suggestion. Wait at least one second after resending, then click **Deliver replacement code** and verify that the replacement suggestion fills `654321`.

`tests/fixtures/inline-regression-preview.html` supplies synthetic mail for modal and link-step checks. Use `?mode=modal-code` to fill a code in a native modal, `?mode=modal-reset` to copy a reset link in a modal, or `?mode=status` for a normal waiting panel. Add `&transform=1` to test a scaled, clipped dialog. **Update connection status** must retain the offered link; **Change recipient** and **Resend email** must clear it. These fixtures do not access Yahoo. When testing edits, serve with caching disabled or use a fresh local port so Chrome reloads imported modules.

`tests/fixtures/numeric-code-preview.html` checks two independent full-length numeric verification fields in one form. Selecting the email-code suggestion must fill the email field and retain the phone field’s existing value.

`tests/fixtures/mixed-numeric-code-preview.html` combines six numeric email-code boxes with a full-length numeric phone-code field. The initial suggestion must fill only the phone field. **Test split email fields** focuses an unlabelled email digit; the next suggestion must fill those six boxes and preserve the phone field.

The suites use synthetic mail and fake Chrome/IMAP connections. Policy and step-detection suites cover pure matching and filtering; controller suites cover polling and page lifecycle. `test_popup_integration.js` covers the popup controller and its real view together. [Code-field tests](../tests/test_code_fields.js) verify that numeric split-digit groups reject mismatched code lengths.

`tests/timer_queue.js` stores callbacks for explicit execution by insertion order or requested delay; it does not advance a clock. `tests/email_messages.py` shares `make_raw_email()` across code extraction, link extraction, and inbox-scanning tests. Its subject, subtype, and sender options describe each synthetic message; multipart and attachment cases build their own MIME structure.

### Manual validation

After installing the companion, reloading the extension, and refreshing the test page:

1. Connect a Yahoo account and confirm that it appears in the popup.
2. Request a fresh code on an HTTPS page. Select its on-page suggestion and verify the field value; repeat using the popup.
3. Request a confirmation email. Select its link and verify that the intended destination opens in a new tab.
4. Request a reset email. Copy its link, verify the clipboard value, and use **Copy again** to repeat the copy.
5. Resend an email and confirm that older on-page results disappear. Hide the tab and confirm checking stops; return and check again.
6. Remove the account and confirm that its results disappear.

These checks require real Yahoo mail and Chrome; automated suites do not establish end-to-end success.

## Extension modules

Chrome entry points and `popup.html` stay at the extension root. `popup/` contains toolbar controllers, rendering, and styles; `inline/` contains on-page controllers, views, and coordination; `shared/` contains transport, polling, extraction policy, and shared presentation helpers.

| Module | Responsibility |
| --- | --- |
| `content-entry.js` | Starts the code picker and email-link card with one page coordinator. |
| `inline/page-coordinator.js` | Shares code-field candidates, DOM observation, and page-change notifications. |
| `inline/suggestion-mount.js` | Mounts suggestions inside the active native modal so they remain clickable above its backdrop. |
| `inline/code-picker-controller.js`, `inline/code-picker-view.js` | Control, position, and render code suggestions beside a detected field. |
| `inline/code-picker-policy.js`, `inline/email-link-card-policy.js` | Filter suggestions and classify request controls and mutations. |
| `inline/email-link-step.js` | Detect confirmation/reset waiting prompts and return a step identity and mail type. |
| `inline/email-link-card-controller.js`, `inline/email-link-card-view.js` | Control and render the link card. |
| `inline/mutation-inspection.js` | Share bounded mutation traversal and attribute-target deduplication; picker and link policies supply relevance rules. |
| `popup-entry.js`, `popup/popup-controller.js`, `popup/popup-view.js` | Start the toolbar popup, manage accounts and polling, and render controls and results. |
| `shared/email-link-details.js`, `shared/mail-presentation.js`, `shared/reset-link-copy.js` | Share link-detail rows, mail-type-specific labels and guidance, and reset-link clipboard handling. |
| `inline/inline-client.js`, `background.js` | Hold a page request port open, validate active-tab access, and share in-flight native requests per mail type. |
| `shared/companion-client.js` | Handle one-off native requests and reusable native-messaging sessions. |
| `shared/polling-lifecycle.js` | Manage polling deadlines, stale responses, scheduled checks, and queued retries. |
| `shared/scan-schedule.js` | Decide when to collect pending workers or start a full scan and choose the next poll delay. |
| `shared/mail-timing.js`, `shared/email-link-url.js` | Share freshness and link-URL rules. |
| `inline/request-controls.js` | Share on-page request-control labels and selectors. |
| `shared/code-fields.js` | Detect and fill verification inputs through `handleVerificationFields()` and return verification-context roots for step tracking; helpers stay inside the injected function because Chrome serializes it. |
| `inline/code-step-context.js` | Read bounded verification-context text and return `recipientKey`: `null` for an incomplete read, or a serialised recipient list (including `"[]"` when no recipient is recognised). |
| `inline/recipient-identity.js` | Match ordinary and masked email addresses and serialise recipient identities; code and link detectors supply their own instruction classifiers. |

### Request contract

The inline request field is `mailType`; native requests use `action`. Mail type values and result keys are `codes`, `confirmationLinks`, and `passwordResetLinks`. Mail responses include the boolean `scanPending`. Requests with `collectOnly: true` collect existing workers and cached results without starting scans. All surfaces collect pending scans every second, then resume their normal check interval. While a slower account remains pending, full checks still run at the normal interval so healthy accounts can discover new mail. Update the companion and extension together when changing this contract.

Automatic checking runs for up to two minutes. Code suggestions normally check two seconds after each response; link cards and the popup check about every eight seconds. `beginCheck()` returns `{ collectOnly }` and updates the next full-scan time; `pollDelayMs` gives the delay before the next check. Polling lifecycle `schedule(callback, delay)` requires an explicit delay; scan cadence belongs to the scan schedule. `stopScheduledPolling()` clears the timer and deadline; `invalidateChecks()` invalidates inline check bookkeeping and responses and clears the timer. Neither method cancels companion workers already running. Inline `checks.finish(token)` returns `stale`, `complete`, or `retry`, so callers distinguish invalidated completions from normal completion and a queued retry.

## Companion modules

| Module | Responsibility |
| --- | --- |
| `host.py` | Dispatch requests, frame native messages, and serialize credential updates. |
| `account_scan_manager.py` | Manage account scan workers, pending scans, connections, cached results, and warnings. `discard_account_state(email)` discards runtime state without deleting saved credentials. |
| `inbox_session.py` | Reuse IMAP connections and manage bounded incremental inbox scans. |
| `code_extraction.py` | Extract one unambiguous verification code. |
| `link_extraction.py` | Extract confirmation and password-reset links. |
| `email_content.py` | Traverse MIME parts and parse visible HTML for both extractors. |
| `keychain.py`, `errors.py` | Access the saved credential record through `access_saved_credentials()` and define user-facing errors. |
| `install.py` | Discover, install, and remove companion runtime modules. |

Up to four account scans run concurrently in a thread pool. Each request waits at most 250 ms for scans, returns completed results and pending status, and retains pending work for later collection polls without overlapping scans for the same session. Collection polls do not rescan accounts that already finished. Cached results expire after ten minutes. Removing an account or changing credentials or mail type discards its results immediately and closes its connection after any active worker finishes.

Each worker uses a 25-second scan budget, applying the remaining budget to blocking IMAP reads with a maximum socket timeout of 15 seconds. Session requests have a 35-second companion watchdog; account setup allows 60 seconds for login and Keychain access. A watchdog disconnects the native port, clears the pending request, and allows retry. One-off account operations use their own native port so they can also be disconnected on timeout.

Background sessions close after 15 seconds without a new check; the popup reuses its session while open. Simultaneous requests of the same type share an in-flight native request. Separate sessions per type prevent one request from consuming another type’s results.

A scan downloads eligible messages in batches of at most five, newest first. It processes every returned body in a batch and returns as soon as that batch yields results. Older candidates remain unfetched and queued for later polls, behind newly arrived mail; empty batches continue through remaining candidates within the scan budget. Missing metadata and bodies are retried. Each check reloads credentials so removed or changed accounts cannot retain an active connection.

Initial discovery starts with the latest 30 inbox messages. `MAX_CANDIDATE_MESSAGES` also bounds the metadata and body candidate queues; it is separate from download batch size and retained result limits. `discovery_cursor_uid` tracks discovered UIDs even when their metadata or bodies still need fetching; `pending_body_timestamps_seconds` maps queued body UIDs to arrival times in seconds. Each inbox retains the union of its five newest results (`NEWEST_OVERALL_COUNT`) and its newest result from each of five distinct senders. These groups overlap, so an inbox can retain up to nine results.

## Detection and freshness rules

On-page results must have arrived since the verification step began, allowing five seconds for mail delivered just before it appeared. The code picker keeps the newest code per sender and account. Resend countdown ticks and completion, including parenthesised countdowns, retain the same verification step. Resending clears older suggestions. Yahoo arrival timestamps have one-second precision, so on-page suggestions skip emails dated in the same second as the resend click. The popup can show recent emails excluded by that rule.

- Codes are numeric, 4–8 digits, directly labelled by common English instructions such as “Your code is”, “Security code:”, or “Sign in to Indeed with code:”. Emails with multiple candidate codes are omitted.
- Code fields must be ordinary inputs or common split-digit forms on HTTPS pages with verification-related labels or attributes. A generic “code” label needs nearby email/sign-in instructions. Coupon and promo fields are excluded; unlabelled fields, cross-origin embedded forms, and unusual widgets may not work.
- Link cards recognise common English waiting prompts in short visible panels. Newsletter screens are excluded.
- Link-step identity tracks the panel, email purpose, and recipients in delivery instructions. Incidental status text and countdowns retain results and the polling deadline; panel replacement, recipient changes, purpose changes, navigation, and explicit resends start new attempts.
- Confirmation links require instructions such as “Verify email”, “Confirm account”, or “Activate account”; password-reset subjects are excluded. Reset links require instructions such as “Reset your password”, “Change your password”, or “Password reset”; help/support links and negated reset instructions are excluded.
- Both link types require a visible HTML link or instructions immediately before a plain-text URL. Qualifying HTML takes precedence over plain text. Only supported HTTPS URLs are accepted; attachments, hidden links, and emails with multiple distinct qualifying links are omitted.
- Extraction runs locally without AI or visiting links. It does not authenticate senders or match results to the current website. Tracking links show their initial destination; redirects and subsequent steps are handled by the website. Unusual wording, other languages, alphanumeric codes, and older emails may not appear.

## Page detection and performance

Scroll and resize reuse cached field candidates and position the picker on the next animation frame. Relevant DOM mutations refresh discovery. Field detection supplies context roots for both generic code matching and step tracking. Code inputs can use HTML labels, `aria-label`, or an accessible name assembled from `aria-labelledby` references; changes to referenced labels refresh detection. Supported split-digit groups use a stable labelled anchor so moving focus between digits preserves suggestions; selecting a separate group starts a new attempt. Filling rediscovers fields rather than trusting cached hints. Hidden documents skip mutation dispatch and invalidate candidates for rediscovery when visible. Hiding stops new on-page mail requests; existing companion workers can finish.

Native modal dialogs take precedence over background forms. Their inputs use a separate discovery scope, and both suggestion types mount inside the modal rather than in the inert background. Modal suggestions use manual popovers to keep viewport positioning and escape dialog transforms or clipping. Dialog opening and closing refresh detection.

Code-step tracking identifies email recipients (including masked addresses) in nearby code-delivery instructions. Recipient changes, field changes, navigation, and explicit resend clicks start new attempts; incidental status messages retain valid codes. Step tracking never reads aggregate element `textContent`, and skips explicitly hidden content, content hidden by computed CSS display, visibility, or opacity, scripts, styles, and templates. An incomplete context retains the last known recipient identity instead of guessing from truncated text.

| Inspection | Node budget | Text budget | Exhaustion behaviour |
| --- | --- | --- | --- |
| Mutation batch, either controller | 500 across the batch | 10,000 code units across the batch, including current and previous character data | Queue a coalesced discovery scan: 150 ms for codes, 250 ms for links. |
| Code-step context | 500 across all context roots | 10,000 code units across all context roots | Retain the last known recipient identity. |
| Generic code-field context | 500 per context root | 10,000 code units per context root | Skip the incomplete root; explicit field hints remain supported. |
| Link panel, before layout/text extraction | 500 per panel | 10,000 raw code units per panel | Skip the panel, including an oversized body fallback; continue with later panels. |
| Rendered link-panel text | — | 2,500 characters per panel | Skip the panel. |

Mutation inspection walks changed subtrees directly without aggregating element `textContent` or querying unrestricted descendants. Attribute targets are deduplicated per batch. Both code-picker and link-card attribute inspection traverse descendants under the same batch node budget.

Generic code-field context reads individual visible text nodes and skips hidden content, scripts, styles, and templates. Each context root is read once per discovery or fill. Focus on an unlabelled digit selects its validated OTP group, using a labelled digit as the stable suggestion anchor.

Link-panel detection skips explicitly hidden subtrees, scripts, styles, and templates before requesting layout or reading `innerText`. Extensive markup hidden only by CSS can still exhaust the raw-text budget.

## Installation identity and updates

Follow the [installation and update instructions](setup.md#setup), then refresh affected web pages.

Expected extension ID: `ggmcbkkmgcdiimnpkekakaegmclkgkjj`.

The extension key, native-host identifier `local.yahoo_code_fill`, Keychain service/account identifiers, and installation directory `~/Library/Application Support/Yahoo Code Fill/` stay stable so updates retain saved credentials and Chrome registration. Their Yahoo names are storage identities, not product branding. The original single-account Keychain record remains readable to avoid stranding existing app passwords.

Yahoo is the only connected provider. Supporting another provider requires its own connection implementation.
