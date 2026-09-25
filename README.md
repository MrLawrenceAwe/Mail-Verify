# Yahoo Code Fill

A working local prototype for desktop Chrome on macOS. No Yahoo browser tab is needed. Open the extension on a sign-in page to retrieve recent Yahoo verification emails, then click a code to fill it.

## Set up on this Mac

The Mac companion has already been installed by Codex. Finish these steps:

1. In Chrome, type `chrome://extensions` into the address bar.
2. Turn on **Developer mode**, choose **Load unpacked**, and select the `extension` folder beside this guide.
3. Pin **Yahoo Code Fill** using Chrome’s Extensions menu, then open it.
4. Enter your Yahoo email and a **Yahoo-generated app password**, then click **Connect securely**. Generate that password in [Yahoo Account Security](https://login.yahoo.com/account/security). Use an app password, not your normal account password. Enter it in the extension, not in chat.
5. If macOS asks for Keychain access, approve access for the companion’s Python process.

Expected extension ID: `ggmcbkkmgcdiimnpkekakaegmclkgkjj`.

If you loaded an earlier version, click **Reload** for Yahoo Code Fill on Chrome’s Extensions page after installing this update.

If reinstalling or setting up another Mac, first double-click **Install Companion.command**. The installer requires Python 3.9+ and records that Python executable’s path. If Python is moved or removed, rerun the installer after restoring Python.

## Use

1. Ask the website to send an email code.
2. Click its verification-code field, then open **Yahoo Code Fill** from the Chrome toolbar.
3. The extension checks your Yahoo inbox. While waiting for a code, it checks about every 8 seconds for up to 2 minutes while the popup remains open. A slow Yahoo response may delay a check; the next check starts at least 2 seconds after it finishes. Press **Check for a code** to interrupt a slow check and retry.
4. Review the sender, subject, and destination website. Click **Fill on [website]** for the right email.

Closing the popup stops checking. Reopen it or press **Check for a code** to try again. The extension does not click Submit, although some websites submit automatically when all digits are entered.

## Current limits

- This first version requires opening the toolbar popup; it does not automatically detect every code field or show a system keyboard suggestion.
- One Yahoo account. Inbox only, the latest 30 messages on the first check, and codes received within the last 10 minutes. Spam and other folders are excluded.
- Recognises numeric codes of 4–8 digits when the code is directly labelled by common English phrases such as “Your code is” or “Security code:”. Messages containing multiple candidate codes are omitted. Some formats, languages, and alphanumeric codes are not supported yet.
- Supports ordinary input fields and common split-digit forms on HTTPS pages when the fields have a verification-related label or attribute. A generic “code” label is deliberately insufficient because it may refer to a coupon or other code. Unlabelled fields, embedded cross-origin forms, and unusual custom widgets may not work.
- Sender and subject are provided for your review. The prototype does not authenticate a sender or automatically establish which website owns a code. It never selects a code for you.
- Yahoo may restrict app-password generation for some accounts. If Yahoo does not offer one, this connection method cannot be completed for that account.
- Tested with synthetic email and form cases plus the installed native bridge. A live Yahoo login and a real Chrome extension fill still need account setup and manual validation.

## Privacy and permissions

Email access goes directly from your Mac to `imap.mail.yahoo.com:993` over TLS. Credentials are stored as a generic password in macOS Keychain under `local.yahoo_code_fill`. They are never stored in extension storage, configuration files, logs, or command-line arguments. The companion uses a read-only inbox and BODY.PEEK retrieval, so checking does not mark messages read.

The extension requests `nativeMessaging`, `activeTab`, and `scripting`. Clicking the extension grants temporary access to the active tab. It has no blanket access to all websites, no analytics, and no AI integration. Codes remain in popup memory and are sent to the chosen page only when you click Fill. Once filled, that website can read the code.

Chrome starts the companion on demand and keeps it connected while the popup is open. It reuses the Yahoo connection and checks only newly arrived messages after the first scan. Closing the popup ends the connection. No background login item, public server, or open network listener is installed. Native messaging is restricted to this extension ID.

## Remove account or uninstall

**Remove account** in the popup removes the saved Yahoo credential from Keychain.

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

- `extension/popup-entry.js` starts the popup; `popup.js` owns its controls, rendering, and polling.
- `extension/companion-client.js` handles one-off requests and the reusable native-messaging session.
- `extension/fill-code.js` exports the self-contained function injected into the selected page. Its helpers stay inside the function because Chrome serializes it into the page.
- `companion/host.py` handles request dispatch and native-message framing; `mail_session.py` manages IMAP connections and bounded inbox scans.
- `companion/code_extraction.py` parses email content and extracts a single unambiguous code.
- `companion/keychain.py` stores credentials; `errors.py` defines user-facing errors.
- `companion/install.py` installs and removes the companion files listed in `COMPANION_FILES`. Update that list when adding runtime modules. Tests are grouped by the production module they cover.

After changing companion code, rerun **Install Companion.command**; after changing extension code, reload the extension in Chrome. The Keychain service/account identifiers and extension identity are intentionally stable so updates retain access to saved credentials and Chrome registration.

## References

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Yahoo IMAP access](https://help.yahoo.com/kb/SLN28681.html)
