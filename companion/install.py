"""Register the local Chrome companion; no admin privileges or credentials required."""

import base64
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HOME_DIR = Path.home()
INSTALL_DIR = HOME_DIR / "Library/Application Support/Yahoo Code Fill"
HOST_MANIFEST_PATH = (
    HOME_DIR
    / "Library/Application Support/Google/Chrome/NativeMessagingHosts/local.yahoo_code_fill.json"
)

COMPANION_FILES = ("host.py", "account_sessions.py", "inbox_session.py", "code_extraction.py", "link_extraction.py", "email_content.py", "keychain.py", "errors.py")
OBSOLETE_COMPANION_FILES = ("mail_session.py",)


def main():
    if sys.platform != "darwin":
        raise SystemExit("This companion installer is for macOS.")
    if "--uninstall" in sys.argv:
        HOST_MANIFEST_PATH.unlink(missing_ok=True)
        # Only remove files owned by this installer. Use Remove account in the popup first.
        for name in (*COMPANION_FILES, *OBSOLETE_COMPANION_FILES, "launch-host", "accounts.lock"):
            (INSTALL_DIR / name).unlink(missing_ok=True)
        print(
            "Companion removed. Remove the extension in Chrome. To remove credentials, delete local.yahoo_code_fill in Keychain Access."
        )
        return
    if sys.version_info < (3, 9):
        raise SystemExit("Python 3.9 or newer is required to install the companion.")
    manifest = json.loads((PROJECT_ROOT / "extension/manifest.json").read_text())
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    extension_id = "".join(chr(ord("a") + int(c, 16)) for c in digest)
    INSTALL_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in COMPANION_FILES:
        shutil.copy2(PROJECT_ROOT / "companion" / name, INSTALL_DIR / name)
    for name in OBSOLETE_COMPANION_FILES:
        (INSTALL_DIR / name).unlink(missing_ok=True)
    launcher = INSTALL_DIR / "launch-host"
    launcher.write_text(
        "#!/bin/sh\nexec "
        + shlex.quote(sys.executable)
        + " "
        + shlex.quote(str(INSTALL_DIR / "host.py"))
        + ' "$@"\n'
    )
    launcher.chmod(0o700)
    HOST_MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    HOST_MANIFEST_PATH.write_text(
        json.dumps(
            {
                "name": "local.yahoo_code_fill",
                "description": "Mail Verify local email verification companion",
                "path": str(launcher),
                "type": "stdio",
                "allowed_origins": [f"chrome-extension://{extension_id}/"],
            },
            indent=2,
        )
        + "\n"
    )
    HOST_MANIFEST_PATH.chmod(0o600)
    print(
        "Mac companion installed. No Yahoo credentials have been requested or stored."
    )
    print("Load this folder with Chrome → Extensions → Developer mode → Load unpacked:")
    print(PROJECT_ROOT / "extension")
    print("Expected extension ID: " + extension_id)


if __name__ == "__main__":
    main()
