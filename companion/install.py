"""Register the local Chrome companion; no admin privileges or credentials required."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
HOME_DIR = Path.home()
DEST = HOME_DIR / 'Library/Application Support/Yahoo Code Fill'
REGISTRY = HOME_DIR / 'Library/Application Support/Google/Chrome/NativeMessagingHosts/local.yahoo_code_fill.json'

def main():
    if sys.platform != 'darwin': raise SystemExit('This companion installer is for macOS.')
    if '--uninstall' in sys.argv:
        REGISTRY.unlink(missing_ok=True)
        # Only remove files owned by this installer. Disconnect in the popup first.
        for name in ('host.py', 'launch-host'):
            (DEST / name).unlink(missing_ok=True)
        print('Companion removed. Remove the extension in Chrome. To remove credentials, delete local.yahoo_code_fill in Keychain Access.')
        return
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    digest = hashlib.sha256(base64.b64decode(manifest['key'])).hexdigest()[:32]
    extension_id = ''.join(chr(ord('a') + int(c, 16)) for c in digest)
    DEST.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copy2(ROOT / 'companion/host.py', DEST / 'host.py')
    launcher = DEST / 'launch-host'
    launcher.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(DEST / 'host.py'))+' "$@"\n')
    launcher.chmod(0o700)
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(json.dumps({'name':'local.yahoo_code_fill','description':'Local Yahoo verification code companion','path':str(launcher),'type':'stdio','allowed_origins':[f'chrome-extension://{extension_id}/']}, indent=2)+'\n')
    REGISTRY.chmod(0o600)
    print('Mac companion installed. No Yahoo credentials have been requested or stored.')
    print('Load this folder with Chrome → Extensions → Developer mode → Load unpacked:')
    print(ROOT / 'extension')
    print('Expected extension ID: '+extension_id)

if __name__ == '__main__': main()
