# Development

Python uses its standard library and the macOS Security framework. JavaScript uses native ES modules without a bundler. No package installation is required.

Run `npm test` for the automated suites. See [testing and previews](testing.md) for commands, synthetic fixtures, shared harnesses, and manual validation.

## Extension modules

Chrome entry points and `popup.html` stay at the extension root. `popup/` contains toolbar controllers, rendering, and styles; `inline/` contains on-page controllers, views, and coordination; `shared/` contains transport, polling, freshness and URL rules, field handling, and presentation helpers used across surfaces.

| Module | Responsibility |
| --- | --- |
| `content-entry.js` | Starts the code picker and email-link card with one page coordinator. |
| `inline/page-coordinator.js` | Shares code-field candidates, DOM observation, and page-change notifications. |
| `inline/active-modal.js`, `inline/suggestion-mount.js` | Select the active native modal and mount suggestions above its backdrop. |
| `inline/code-picker-controller.js`, `inline/code-picker-view.js` | Control, position, and render code suggestions beside a detected field. |
| `inline/code-picker-policy.js`, `inline/email-link-card-policy.js` | Filter suggestions and classify request controls and mutations. |
| `inline/email-link-step.js` | Detect confirmation/reset waiting prompts and return a step identity and mail type. |
| `inline/email-link-card-controller.js`, `inline/email-link-card-view.js` | Control and render the link card. |
| `inline/mutation-inspection.js` | Share bounded mutation traversal and attribute-target deduplication; picker and link policies supply relevance rules. |
| `popup-entry.js`, `popup/popup-controller.js`, `popup/popup-view.js` | Start the toolbar popup, manage accounts and polling, and render controls and results. |
| `shared/email-link-details.js`, `shared/mail-presentation.js`, `shared/reset-link-copy.js` | Share link-detail rows, mail-type-specific labels and guidance, and reset-link clipboard handling. |
| `inline/inline-client.js`, `background.js` | Hold a page request port open, validate active-tab access, and share in-flight native requests per mail type. |
| `shared/companion-client.js` | Handle native requests and reusable sessions; distinguish unavailable connections with `CompanionUnavailableError` from operational response errors and timeouts. |
| `shared/polling-lifecycle.js` | Manage polling deadlines, stale responses, scheduled checks, and queued retries. |
| `shared/scan-schedule.js` | Decide when to collect pending workers or start a full scan and choose the next poll delay. |
| `shared/mail-timing.js`, `shared/email-link-url.js` | Share freshness and link-URL rules. |
| `inline/request-controls.js` | Share on-page request-control labels and selectors. |
| `shared/code-fields.js` | Detect and fill verification inputs through `detectOrFillCodeFields()` and return verification-context roots for step tracking; helpers stay inside the injected function because Chrome serializes it. |
| `inline/code-step-context.js` | Read bounded verification-context text and return `recipientKey`: `null` for an incomplete read, or a serialised recipient list (including `"[]"` when no recipient is recognised). |
| `inline/recipient-identity.js` | Match ordinary and masked email addresses and serialise recipient identities; code and link detectors supply their own instruction classifiers. |

### Request contract

The inline request field is `mailType`; native requests use `action`. Mail types and result keys are `codes`, `confirmationLinks`, and `passwordResetLinks`. Responses include `scanPending`; requests with `collectOnly: true` collect existing workers and cached results without starting scans. Update the companion and extension together when changing this contract.

### Polling lifecycle

Automatic checking lasts up to two minutes. Code suggestions normally check two seconds after each response; link cards and the popup check about every eight seconds. Pending scans are collected every second, while full checks continue at the normal interval so healthy accounts can discover new mail.

[Scan scheduling](../extension/shared/scan-schedule.js) decides between collection and full checks and supplies the next delay. [Polling lifecycle](../extension/shared/polling-lifecycle.js) owns timers, deadlines, response invalidation, and queued retries:

- Scheduling requires an explicit delay. Cancelling a timer retains the polling deadline.
- Ending the polling window clears its timer and deadline; invalidating inline checks also invalidates active response bookkeeping. Neither cancels companion workers.
- A retry during an active check invalidates its response and queues another check. Check completion distinguishes stale responses, normal completion, and queued retries.
- The [popup controller](../extension/popup/popup-controller.js) closes its native session when resetting a check, separately from the polling deadline.

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

### Inbox scan invariants

[InboxSession](../companion/inbox_session.py) discovers and queues at most 30 recent messages, then downloads eligible bodies newest first in batches of five. It processes every returned body before returning a batch's results; empty batches continue within the scan budget. Deferred bodies remain queued behind newly arrived mail.

Missing metadata and bodies are retried. Initial discovery remembers processed bodies, including messages without results, so retries advance rather than repeatedly downloading the newest batch. Discovery progress and body completion are tracked separately; retry state clears when discovery completes or the connection closes.

Each inbox retains the union of its five newest results and the newest result from each of five distinct senders, giving at most nine results. Cached results and queued bodies expire after ten minutes. Each check reloads credentials; removed or changed accounts cannot retain an active connection.

## Detection and freshness rules

The code picker's initial freshness cutoff accepts mail from the last ten minutes, matching the popup even when mail arrives before field discovery. Subsequent code attempts and on-page link results must have arrived since the verification step began, allowing five seconds for mail delivered just before it appeared. The code picker keeps the newest code per sender and account. Resend countdown ticks and completion, including parenthesised countdowns, retain the same verification step. Resending clears older suggestions. Yahoo arrival timestamps have one-second precision, so on-page suggestions skip emails dated in the same second as the resend click. The popup can show recent emails excluded by that rule.

- Codes are numeric, 4–8 digits, directly labelled by common English instructions such as “Your code is”, “Security code:”, or “Sign in to Indeed with code:”. Emails with multiple candidate codes are omitted.
- Code fields must be ordinary inputs or common split-digit forms on HTTPS pages with verification-related labels or attributes. A generic “code” label needs nearby email/sign-in instructions. Coupon and promo fields are excluded; unlabelled fields, cross-origin embedded forms, and unusual widgets may not work.
- Link cards recognise common English waiting prompts in short visible panels. Newsletter screens are excluded.
- Link-step identity tracks the panel, email purpose, and recipients in delivery instructions. Incidental status text and countdowns retain results and the polling deadline; panel replacement, recipient changes, purpose changes, navigation, and explicit resends start new attempts.
- Confirmation links require instructions such as “Verify email”, “Confirm account”, or “Activate account”; password-reset subjects are excluded. Reset links require instructions such as “Reset your password”, “Change your password”, or “Password reset”; help/support links and negated reset instructions are excluded.
- Both link types require a visible HTML link or instructions immediately before a plain-text URL. Qualifying HTML takes precedence over plain text. Only supported HTTPS URLs are accepted; attachments, hidden links, and emails with multiple distinct qualifying links are omitted.
- Extraction runs locally without AI or visiting links. It does not authenticate senders or match results to the current website. Tracking links show their initial destination; redirects and subsequent steps are handled by the website. Unusual wording, other languages, alphanumeric codes, and older emails may not appear.

## Page detection and performance

Scroll and resize reuse cached field and page-control candidates and position the picker on the next animation frame. The picker tries below, above, and beside the field to avoid covering inputs, buttons, and links; when every position overlaps controls, it chooses the smallest overlap. Relevant DOM mutations refresh discovery. Field detection supplies context roots for both generic code matching and step tracking. Code inputs can use HTML labels, `aria-label`, or an accessible name assembled from `aria-labelledby` references; changes to referenced labels refresh detection. Supported split-digit groups use a stable labelled anchor so moving focus between digits preserves suggestions; selecting a separate group starts a new attempt. Filling rediscovers fields rather than trusting cached hints. Hidden documents skip mutation dispatch and invalidate candidates for rediscovery when visible. Hiding stops new on-page mail requests; existing companion workers can finish.

Native modal dialogs take precedence over background forms. Their inputs use a separate discovery scope, and both suggestion types mount inside the modal rather than in the inert background. The active dialog is selected from focus or its viewport backdrop, rather than DOM order, including when multiple dialogs are open. Modal suggestions use manual popovers to keep viewport positioning and escape dialog transforms or clipping. Dialog opening and closing refresh detection.

Code-step tracking identifies email recipients (including masked addresses) in nearby code-delivery instructions. Recipient changes, field changes, navigation, and explicit resend clicks start new attempts; incidental status messages retain valid codes. An identical detached input replaced inside the same unchanged context retains unused codes and their original freshness cutoff; fills validate the replacement input. Controls explicitly requesting only SMS, text messages, or phone delivery do not restart email checking. Resend controls belong to their owning form or task panel, so another form cannot invalidate active email results. Standalone resend controls beside a panel remain supported. An incomplete context retains the last known recipient identity.

| Inspection | Node budget | Text budget | Exhaustion behaviour |
| --- | --- | --- | --- |
| Mutation batch, either controller | 500 across the batch | 10,000 code units across the batch, including current and previous character data | Queue a coalesced discovery scan: 150 ms for codes, 250 ms for links. |
| Code-step context | 500 across all context roots | 10,000 code units across all context roots | Retain the last known recipient identity. |
| Generic code-field context | 500 per context root | 10,000 code units per context root | Skip the incomplete root; explicit field hints remain supported. |
| Link panel, before layout/text extraction | 500 per panel | 10,000 raw code units per panel | Skip the panel, including an oversized body fallback; continue with later panels. |
| Rendered link-panel text | — | 2,500 characters per panel | Skip the panel. |

Mutation and code-context inspection read individual text nodes without aggregating element `textContent` or querying unrestricted descendants. Attribute targets are deduplicated per mutation batch. Code-context reads skip hidden content, scripts, styles, and templates and reuse each root within a discovery or fill. See [mutation inspection](../extension/inline/mutation-inspection.js), [code-step context](../extension/inline/code-step-context.js), and [field handling](../extension/shared/code-fields.js).

[Link-panel detection](../extension/inline/email-link-step.js) bounds traversal before layout or `innerText` reads. It skips explicitly hidden subtrees, scripts, styles, and templates; markup hidden only by CSS can still exhaust the raw-text budget.

## Installation identity and updates

Follow the [installation and update instructions](setup.md#setup), then refresh affected web pages.

Expected extension ID: `ggmcbkkmgcdiimnpkekakaegmclkgkjj`.

The extension key, native-host identifier `local.yahoo_code_fill`, Keychain service/account identifiers, and installation directory `~/Library/Application Support/Yahoo Code Fill/` stay stable so updates retain saved credentials and Chrome registration. Their Yahoo names are storage identities, not product branding. The original single-account Keychain record remains readable to avoid stranding existing app passwords.

Yahoo is the only connected provider. Supporting another provider requires its own connection implementation.
