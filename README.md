# Yahoo Code Fill

A working local prototype for desktop Chrome on macOS. No Yahoo browser tab is needed. A code picker appears automatically on supported HTTPS verification forms. Click the matching email code to fill it; the toolbar popup is only needed for account setup or manual checks.

## Set up on this Mac

The Mac companion has already been installed by Codex. Finish these steps:

1. In Chrome, type `chrome://extensions` into the address bar.
2. Turn on **Developer mode**, choose **Load unpacked**, and select the `extension` folder beside this guide.
3. Pin **Yahoo Code Fill** using Chrome’s Extensions menu, then open it.
4. Enter your Yahoo email and a **Yahoo-generated app password**, then click **Add account**. Generate that password in [Yahoo Account Security](https://login.yahoo.com/account/security). Use an app password, not your normal account password. Enter it in the extension, not in chat. Use **Add another Yahoo account** for each additional inbox.
5. If macOS asks for Keychain access, approve access for the companion’s Python process.

Expected extension ID: `ggmcbkkmgcdiimnpkekakaegmclkgkjj`.

If you loaded an earlier version, click **Reload** for Yahoo Code Fill on Chrome’s Extensions page after installing this update.

If reinstalling or setting up another Mac, first double-click **Install Companion.command**. The installer requires Python 3.9+ and records that Python executable’s path. If Python is moved or removed, rerun the installer after restoring Python.

## Use

1. Ask the website to send an email code.
2. A compact blue **Fill code 123456 / account@yahoo.com** suggestion appears directly beneath the code field (or above it when space is limited) when a visible verification-code field is detected, including Indeed’s “Enter code” form.
3. It checks automatically, then every 2 seconds after each response for up to 2 minutes. The destination website is shown below the suggestion. Hover over a code to see its sender and subject, then click the matching code to fill it.
4. Use **↻** to restart checking, or × / Escape to dismiss the suggestion for this page.

The inline suggestion only shows mail received since the current code step began, with a five-second allowance for mail that arrived just before the field appeared. It keeps the newest code per sender. Clicking “Send new code” or “Resend code” clears the old suggestion immediately and waits for newer mail. Since Yahoo's IMAP arrival times have one-second precision, the picker skips codes dated in the same second as the resend click; use the toolbar popup if a new code arrives that quickly. The popup also remains available for manually choosing older codes.

No toolbar popup is required after setup. Hidden tabs stop checking. Scroll and resize updates reuse cached candidate fields and position the picker on the next animation frame; relevant page changes refresh field discovery. The extension does not click Submit, although some websites submit automatically when all digits are entered.

## Current limits

- Suggestions are styled like Mail autofill and anchored to the input; they are an extension interface rather than a macOS system control.
- Multiple Yahoo accounts. Each account scans its inbox only, the latest 30 messages on the first check, and codes received within the last 10 minutes. Spam and other folders are excluded. With multiple accounts, checks may take longer because inboxes are scanned in turn.
- Recognises numeric codes of 4–8 digits when the code is directly labelled by common English phrases such as “Your code is”, “Security code:”, or “Sign in to Indeed with code:”. Messages containing multiple candidate codes are omitted. Some formats, languages, and alphanumeric codes are not supported yet.
- Supports ordinary input fields and common split-digit forms on HTTPS pages when the fields have a verification-related label or attribute. A generic “code” label also requires email/sign-in verification text in its form or nearby preceding instructions; coupon and promo fields are excluded. Unlabelled fields, embedded cross-origin forms, and unusual custom widgets may not work.
- Sender and subject are provided for your review. The prototype does not authenticate a sender or automatically establish which website owns a code. It never selects a code for you.
- Yahoo may restrict app-password generation for some accounts. If Yahoo does not offer one, this connection method cannot be completed for that account.
- Tested with synthetic email and form cases plus the installed native bridge. A live Yahoo login and a real Chrome extension fill still need account setup and manual validation.

## Privacy and permissions

Email access goes directly from your Mac to `imap.mail.yahoo.com:993` over TLS. Credentials are stored together as a generic password in macOS Keychain under `local.yahoo_code_fill`. An existing single-account credential is retained when adding another account. Credentials are never stored in extension storage, configuration files, logs, or command-line arguments. The companion uses a read-only inbox and BODY.PEEK retrieval, so checking does not mark messages read.

The extension requests `nativeMessaging`, `activeTab`, and `scripting`, and runs a content script on HTTPS sites to recognise code fields automatically. Chrome does not necessarily show a permission prompt after reloading an unpacked extension. If the on-page picker is absent after refreshing the website, open the extension’s **Details** in `chrome://extensions` and check that **Site access** allows it to run on that site. There are no analytics or AI integrations. The on-page picker runs in an isolated content-script context with a closed shadow root. Codes remain in memory and are written into a website’s input only when you click Fill; that website can then read the code.

Chrome starts the companion on demand for automatic checks on the active tab. Background checks reuse the Yahoo connection while the picker is polling and close it after 15 seconds without a new check; simultaneous checks share an in-flight scan. Codes found in the newest five eligible messages are returned immediately; older candidates are checked on later polls, with newly arrived mail taking priority. If that first batch contains no code, the check continues through the remaining candidates. Each check verifies that the saved account is still connected. The popup retains its reusable connection while open. No background login item, public server, or open network listener is installed. Native messaging is restricted to this extension ID.

## Remove account or uninstall

**Remove** beside an account in the popup removes that Yahoo credential from Keychain. Removing the last account deletes the Keychain item.

To uninstall the companion, run this from the Yahoo Code Fill folder:

```sh
python3 companion/install.py --uninstall
```

Remove the extension through Chrome’s Extensions page. If you uninstalled before removing the account, delete the `local.yahoo_code_fill` item in Keychain Access. You can also revoke the app password in Yahoo Account Security.

The companion is installed at `~/Library/Application Support/Yahoo Code Fill/`. Its Chrome registration is at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/local.yahoo_code_fill.json`.

## Developer checks

```sh
python3 -m unittest discover -s tests -v
node --test tests/test_*.js
for file in extension/*.js; do node --check "$file"; done
```

You can also run the test suites with `npm test`. No package installation is needed. Python uses its standard library and macOS Security framework. JavaScript uses native ES modules, with no bundler.

The installer test installs into a temporary directory, launches that copy to verify native-message framing and module imports, then checks uninstall cleanup. It does not access Yahoo or Keychain.

## Code organisation

- `extension/content-entry.js` loads `inline-picker.js` for automatic field detection and picker lifecycle; `inline-picker-view.js` renders the on-page picker. `background.js` brokers active-tab native checks.
- `extension/popup-entry.js` starts the popup; `popup-controller.js` manages account actions and polling, while `popup-view.js` renders its controls and code cards.
- `extension/companion-client.js` handles one-off requests and the reusable native-messaging session.
- `extension/code-fields.js` exports the self-contained field detector and filler injected into the selected page. Its helpers stay inside the function because Chrome serializes it into the page. `code-timing.js` shares timing limits between the popup and inline picker.
- `companion/host.py` handles request dispatch and native-message framing; `account_sessions.py` coordinates connected accounts, while `inbox_session.py` manages IMAP connections and bounded inbox scans.
- `companion/code_extraction.py` parses email content and extracts a single unambiguous code.
- `companion/keychain.py` stores credentials; `errors.py` defines user-facing errors.
- `companion/install.py` installs and removes the companion files listed in `COMPANION_FILES`. Update that list when adding runtime modules. Tests are grouped by the production module they cover.

After changing companion code, rerun **Install Companion.command**; after changing extension code, reload the extension in Chrome. The Keychain service/account identifiers and extension identity are intentionally stable so updates retain access to saved credentials and Chrome registration.

## References

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Yahoo IMAP access](https://help.yahoo.com/kb/SLN28681.html)

To preview the suggestion with synthetic data, run `python3 -m http.server 8764 --bind 127.0.0.1` from the project root and open `http://127.0.0.1:8764/tests/fixtures/inline-picker-preview.html`. No Yahoo access is used by that fixture.
