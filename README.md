# Mail Verify

Find email verification codes, account confirmation links, and password reset links in Yahoo inboxes from desktop Chrome on macOS. Click a result to fill a code, open a confirmation link, or copy a reset link. No webmail tab is needed. Yahoo is currently the only supported provider.

## Setup

1. Double-click **Install Companion.command** in the project folder. Python 3.9+ is required. If Python is moved or removed later, restore it and rerun the installer.
2. Open `chrome://extensions` in Chrome, enable **Developer mode**, choose **Load unpacked**, and select this project's `extension` folder.
3. Pin **Mail Verify** from Chrome’s Extensions menu and open it.
4. Enter your Yahoo email and a **Yahoo-generated app password**, then click **Add account**. Create the app password in [Yahoo Account Security](https://login.yahoo.com/account/security); enter it in the extension. Your normal Yahoo password cannot be used. Use **Add another Yahoo account** for additional inboxes.
5. If macOS requests Keychain access, approve access for the companion’s Python process.

For an existing installation, rerun **Install Companion.command** after companion changes and click **Reload** on Chrome’s Extensions page after extension changes. Saved accounts are retained.

If suggestions do not appear after refreshing a website, open Mail Verify’s **Details** on `chrome://extensions` and check that **Site access** allows it on that site. Yahoo may restrict app-password generation; an account without an app password cannot use this connection method.

## Use

| Email type | On-page suggestion | Selected action | Manual popup check |
| --- | --- | --- | --- |
| Verification code | Beside a supported code field | **Fill code**, without clicking Submit | **Find verification codes** |
| Account confirmation | Bottom-right card on a recognised “Check your email” screen | **Open confirmation link** in a new tab; this may immediately confirm the account | **Find confirmation links** |
| Password reset | Bottom-right card on a recognised reset-email waiting screen | **Copy password reset link**, then paste it where you want to use it | **Find password reset links** |

Request the email on the website, then choose its matching result. Review the account, sender, subject, and destination before using it. Hover over a code to see its sender and subject. The extension never chooses a result for you; some websites continue automatically after all code digits are filled. Link cards stay out of the way when a code field is recognised.

Use **↻** to restart checking, or **× / Escape** to dismiss an on-page suggestion for that page. The toolbar popup handles account setup and manual checks. A status message confirms a successful reset-link copy; use **Copy again** to repeat it. If a website blocks clipboard access, use the popup.

## Checking and freshness

Automatic checking lasts up to two minutes while the tab is active. Code suggestions check two seconds after each response; link cards and the popup check about every eight seconds. While inbox scans are still running, results are collected every second without starting additional scans. Keep the popup open for manual polling. Hidden tabs stop checking.

Each account scans its inbox only, starting with the latest 30 messages and limiting results to the last ten minutes. Spam and other folders are excluded. Up to four inboxes scan concurrently. Checks return completed results promptly while slower inboxes continue in the background; their results appear on a later poll.

On-page suggestions show emails received since the current verification step began. Resending clears older suggestions; the popup lets you choose other recent emails manually.

## Supported content and limits

- Supports clearly labelled numeric codes of 4–8 digits and common verification inputs on HTTPS pages.
- Recognises common English confirmation and password-reset email prompts and instructions.
- Omits ambiguous results, hidden content, attachments, and unsupported links. Other languages and unusual forms may not work.
- Does not authenticate senders or match results to the current website. Check the sender and destination before using a result; tracking links may redirect.

See [detection and freshness rules](docs/development.md#detection-and-freshness-rules) for exact matching and timestamp behaviour.

## Privacy and permissions

Your Mac connects directly to `imap.mail.yahoo.com:993` over TLS. Credentials are stored in macOS Keychain under `local.yahoo_code_fill`, never in extension storage, configuration files, logs, or command-line arguments. Checks use a read-only inbox and `BODY.PEEK`, so they do not mark messages read.

The extension uses `nativeMessaging`, `activeTab`, `scripting`, and `clipboardWrite`, and runs a content script on HTTPS pages. On-page controls use an isolated content-script context and closed shadow roots. Results are held temporarily in memory. When you select a code to fill, the website can read that code. There are no analytics or AI integrations.

Chrome starts the companion on demand. No background login item, public server, or network listener is installed. Native messaging is restricted to this extension’s identity.

## Remove an account or uninstall

Click **Remove** beside an account in the popup to delete its credential. Removing the last account deletes the Keychain item.

To uninstall the companion, run `python3 companion/install.py --uninstall` from the project folder, then remove the extension through Chrome’s Extensions page. If credentials remain, delete `local.yahoo_code_fill` in Keychain Access. You can also revoke the app password in Yahoo Account Security.

The companion is installed at `~/Library/Application Support/Yahoo Code Fill/`; Chrome registration is at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/local.yahoo_code_fill.json`.

## Development

See the [developer guide](docs/development.md) for architecture, checks, previews, and installation identifiers.

## References

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Yahoo IMAP access](https://help.yahoo.com/kb/SLN28681.html)
