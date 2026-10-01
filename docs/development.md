# Development

Python uses its standard library and the macOS Security framework. JavaScript uses native ES modules without a bundler. No package installation is required.

## Checks and preview

Run `npm test` for the Python and JavaScript suites. To run them separately or check JavaScript syntax:

```sh
python3 -m unittest discover -s tests -v
node --test tests/test_*.js
for file in extension/*.js; do node --check "$file"; done
```

The installer test installs into a temporary directory, launches that copy to verify native-message framing and imports, then checks uninstall cleanup. It does not access Yahoo or Keychain.

To preview synthetic code suggestions, run `python3 -m http.server 8764 --bind 127.0.0.1` from the project root and open `http://127.0.0.1:8764/tests/fixtures/code-picker-preview.html`. The fixture does not access Yahoo.

Validation has included synthetic email and form tests, a live check through the installed native bridge, and an inline inbox check on an HTTPS demo form. An end-to-end fill with a newly received code still needs validation.

## Extension modules

| Module | Responsibility |
| --- | --- |
| `content-entry.js` | Starts the code picker and email-link card with one page coordinator. |
| `page-coordinator.js` | Shares code-field candidates, DOM observation, and page-change notifications. |
| `code-picker.js`, `code-picker-view.js` | Control and render code suggestions beside a detected field. |
| `email-link-card.js`, `email-link-card-view.js` | Detect confirmation/reset steps and control and render the link card. Step detection returns a separate identity key and mode. |
| `popup-entry.js`, `popup-controller.js`, `popup-view.js` | Start the toolbar popup, manage accounts and polling, and render controls and results. |
| `email-link-details.js`, `mail-modes.js`, `reset-link-copy.js` | Share link-detail rows, mode-specific labels and guidance, and reset-link clipboard handling. |
| `inline-client.js`, `background.js` | Hold a page request port open, validate active-tab access, and share in-flight scans per mail type. |
| `companion-client.js` | Handle one-off native requests and reusable native-messaging sessions. |
| `polling-lifecycle.js` | Manage polling deadlines, stale-response generations, and retries. |
| `mail-timing.js`, `step-text.js`, `email-link-url.js` | Share freshness, countdown-normalisation, and link-URL rules. |
| `code-fields.js` | Detect and fill verification inputs; helpers stay inside the injected function because Chrome serializes it. |

The mail modes and native request/result keys are `codes`, `confirmationLinks`, and `passwordResetLinks`. There are no aliases for older request names; update the companion and reload the extension together.

Scroll and resize updates reuse cached field candidates and position the picker on the next animation frame. Relevant DOM changes refresh discovery. Filling always rediscovers fields and verifies the target rather than trusting cached hints.

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

Background sessions close after 15 seconds without a new check; the popup reuses its session while open. Simultaneous requests of the same type share an in-flight scan. Separate sessions per type prevent one scan from consuming another type’s results.

A scan returns results from the newest five eligible messages immediately when it finds any. Older candidates remain queued for later polls, behind newly arrived mail; if the first batch contains no result, the scan continues through remaining candidates. Missing metadata and bodies are retried. Each check reloads credentials so removed or changed accounts cannot retain an active connection.

## Installation identity and updates

After companion changes, rerun **Install Companion.command**. After extension changes, click **Reload** on Chrome’s Extensions page and refresh affected web pages. The installer records the Python executable’s path; reinstall after restoring Python if it moves or is removed.

Expected extension ID: `ggmcbkkmgcdiimnpkekakaegmclkgkjj`.

The extension key, native-host identifier `local.yahoo_code_fill`, Keychain service/account identifiers, and installation directory `~/Library/Application Support/Yahoo Code Fill/` stay stable so updates retain saved credentials and Chrome registration. Their Yahoo names are storage identities, not product branding. The original single-account Keychain record remains readable to avoid stranding existing app passwords.

Yahoo is the only connected provider. Supporting another provider requires its own connection implementation.
