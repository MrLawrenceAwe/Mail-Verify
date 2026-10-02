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

To preview synthetic code suggestions, run `python3 -m http.server 8764 --bind 127.0.0.1` from the project root and open `http://127.0.0.1:8764/tests/fixtures/code-picker-preview.html`. The fixture does not access Yahoo.

The suites use synthetic mail and fake Chrome/IMAP connections. Previous manual checks covered the installed native bridge and inline inbox access; filling a newly received code still needs end-to-end validation. For a complete manual check, request a new email on an HTTPS page and select its result to fill a code, open a confirmation link, or copy a reset link.

## Extension modules

Chrome entry points and `popup.html` stay at the extension root. `popup/` contains toolbar controllers, rendering, and styles; `inline/` contains on-page controllers, views, and coordination; `shared/` contains transport, polling, extraction policy, and shared presentation helpers.

| Module | Responsibility |
| --- | --- |
| `content-entry.js` | Starts the code picker and email-link card with one page coordinator. |
| `inline/page-coordinator.js` | Shares code-field candidates, DOM observation, and page-change notifications. |
| `inline/code-picker-controller.js`, `inline/code-picker-view.js` | Control and render code suggestions beside a detected field. |
| `inline/email-link-card-controller.js`, `inline/email-link-card-view.js` | Detect confirmation/reset steps and control and render the link card. Step detection returns a separate identity key and mail type. |
| `popup-entry.js`, `popup/popup-controller.js`, `popup/popup-view.js` | Start the toolbar popup, manage accounts and polling, and render controls and results. |
| `shared/email-link-details.js`, `shared/mail-types.js`, `shared/reset-link-copy.js` | Share link-detail rows, mail-type-specific labels and guidance, and reset-link clipboard handling. |
| `inline/inline-client.js`, `background.js` | Hold a page request port open, validate active-tab access, and share in-flight scans per mail type. |
| `shared/companion-client.js` | Handle one-off native requests and reusable native-messaging sessions. |
| `shared/polling-lifecycle.js` | Manage polling deadlines and stale responses; share check cancellation and queued retries between on-page controllers. |
| `shared/mail-timing.js`, `shared/step-text.js`, `shared/email-link-url.js` | Share freshness, step-text and request-control parsing, and link-URL rules. |
| `shared/code-fields.js` | Detect and fill verification inputs; helpers stay inside the injected function because Chrome serializes it. |

The inline request field is `mailType`; native requests use `action`. Mail type values and result keys are `codes`, `confirmationLinks`, and `passwordResetLinks`. Update the companion and extension together when changing this contract.

Scroll and resize updates reuse cached field candidates and position the picker on the next animation frame. Relevant DOM changes refresh discovery. Mutation batches deduplicate attribute targets and cache descendant containment until child-list or role changes invalidate it. Hidden documents skip mutation dispatch and invalidate field candidates for rediscovery when visible. Filling always rediscovers fields and verifies the target rather than trusting cached hints.

## Companion modules

| Module | Responsibility |
| --- | --- |
| `host.py` | Dispatch requests, frame native messages, and serialize credential updates. |
| `account_sessions.py` | Coordinate connected accounts and collect results and warnings. |
| `inbox_session.py` | Reuse IMAP connections and manage bounded incremental inbox scans. |
| `code_extraction.py` | Extract one unambiguous verification code. |
| `link_extraction.py` | Extract confirmation and password-reset links. |
| `email_content.py` | Traverse MIME parts and parse visible HTML for both extractors. |
| `keychain.py`, `errors.py` | Store credentials and define user-facing errors. |
| `install.py` | Discover, install, and remove companion runtime modules. |

Up to four account scans run concurrently in a thread pool. Each request waits at most 250 ms for scans, returns completed results, and retains pending work for later polls without overlapping scans for the same session. Cached results expire after ten minutes. Removing an account or changing credentials or mail type discards its results immediately and closes its connection after any active worker finishes.

Each worker uses a 25-second scan budget, applying the remaining budget to blocking IMAP reads with a maximum socket timeout of 15 seconds. Session requests have a 35-second companion watchdog; account setup allows 60 seconds for login and Keychain access. A watchdog disconnects the native port, clears the pending request, and allows retry. One-off account operations use their own native port so they can also be disconnected on timeout.

Background sessions close after 15 seconds without a new check; the popup reuses its session while open. Simultaneous requests of the same type share an in-flight scan. Separate sessions per type prevent one scan from consuming another type’s results.

A scan returns results from the newest five eligible messages immediately when it finds any. Older candidates remain queued for later polls, behind newly arrived mail; if the first batch contains no result, the scan continues through remaining candidates. Missing metadata and bodies are retried. Each check reloads credentials so removed or changed accounts cannot retain an active connection.

## Detection and freshness rules

On-page results must have arrived since the verification step began, allowing five seconds for mail delivered just before it appeared. The code picker keeps the newest code per sender and account. Resending clears older suggestions. Yahoo arrival timestamps have one-second precision, so on-page suggestions skip emails dated in the same second as the resend click. The popup can show recent emails excluded by that rule.

- Codes are numeric, 4–8 digits, directly labelled by common English instructions such as “Your code is”, “Security code:”, or “Sign in to Indeed with code:”. Emails with multiple candidate codes are omitted.
- Code fields must be ordinary inputs or common split-digit forms on HTTPS pages with verification-related labels or attributes. A generic “code” label needs nearby email/sign-in instructions. Coupon and promo fields are excluded; unlabelled fields, cross-origin embedded forms, and unusual widgets may not work.
- Link cards recognise common English waiting prompts in short visible panels. Newsletter screens are excluded.
- Confirmation links require instructions such as “Verify email”, “Confirm account”, or “Activate account”; password-reset subjects are excluded. Reset links require instructions such as “Reset your password”, “Change your password”, or “Password reset”; help/support links and negated reset instructions are excluded.
- Both link types require a visible HTML link or instructions immediately before a plain-text URL. Qualifying HTML takes precedence over plain text. Only supported HTTPS URLs are accepted; attachments, hidden links, and emails with multiple distinct qualifying links are omitted.
- Extraction runs locally without AI or visiting links. It does not authenticate senders or match results to the current website. Tracking links show their initial destination; redirects and subsequent steps are handled by the website. Unusual wording, other languages, alphanumeric codes, and older emails may not appear.

## Installation identity and updates

Follow the [installation and update instructions](../README.md#setup), then refresh affected web pages.

Expected extension ID: `ggmcbkkmgcdiimnpkekakaegmclkgkjj`.

The extension key, native-host identifier `local.yahoo_code_fill`, Keychain service/account identifiers, and installation directory `~/Library/Application Support/Yahoo Code Fill/` stay stable so updates retain saved credentials and Chrome registration. Their Yahoo names are storage identities, not product branding. The original single-account Keychain record remains readable to avoid stranding existing app passwords.

Yahoo is the only connected provider. Supporting another provider requires its own connection implementation.
