# Setup and removal

## Setup

1. Double-click **Install Companion.command** in the project folder. Python 3.9+ is required. If Python is moved or removed later, restore it and rerun the installer.
2. Open `chrome://extensions` in Chrome, enable **Developer mode**, choose **Load unpacked**, and select this project's `extension` folder.
3. Pin **Mail Verify** from Chrome’s Extensions menu and open it.
4. Enter your Yahoo email and a **Yahoo-generated app password**, then click **Save account**. Create the app password in [Yahoo Account Security](https://login.yahoo.com/account/security); enter it in the extension. Your normal Yahoo password cannot be used. Use **Add or update Yahoo account** for additional inboxes or to update an existing account’s app password.
5. If macOS requests Keychain access, approve access for the companion’s Python process.

For an existing installation, rerun **Install Companion.command** after companion changes and click **Reload** on Chrome’s Extensions page after extension changes. Saved accounts are retained.

If a mail check reports **Unsupported request**, the installed companion is out of date. Close the popup, rerun **Install Companion.command**, then reopen the popup and check again. Reloading the extension alone does not update the companion.

If suggestions do not appear after refreshing a website, open Mail Verify’s **Details** on `chrome://extensions` and check that **Site access** allows it on that site. Yahoo may restrict app-password generation; an account without an app password cannot use this connection method.

## Remove an account or uninstall

Click **Remove** beside an account in the popup to delete its credential. Removing the last account deletes the Keychain item.

To uninstall the companion, run `python3 companion/install.py --uninstall` from the project folder, then remove the extension through Chrome’s Extensions page. If credentials remain, delete `local.yahoo_code_fill` in Keychain Access. You can also revoke the app password in Yahoo Account Security.

The companion is installed at `~/Library/Application Support/Yahoo Code Fill/`; Chrome registration is at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/local.yahoo_code_fill.json`.

