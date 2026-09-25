"""Check that the installed companion runs independently of the source tree."""

import contextlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import install


class InstallerTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin", "macOS companion")
    def test_install_launch_and_uninstall(self):
        with tempfile.TemporaryDirectory(prefix="yahoo companion ") as temporary:
            root = Path(temporary)
            destination = root / "Application Support" / "Yahoo Code Fill"
            manifest_path = root / "NativeMessagingHosts" / "local.yahoo_code_fill.json"
            with patch.object(install, "INSTALL_DIR", destination), patch.object(
                install, "HOST_MANIFEST_PATH", manifest_path
            ), patch.object(sys, "argv", ["install.py"]), contextlib.redirect_stdout(
                io.StringIO()
            ):
                install.main()
                manifest = json.loads(manifest_path.read_text())
                self.assertEqual(
                    manifest["allowed_origins"],
                    ["chrome-extension://ggmcbkkmgcdiimnpkekakaegmclkgkjj/"],
                )
                # An unsupported action exercises imports and framing without accessing Keychain or Yahoo.
                request = json.dumps({"action": "unsupported"}).encode()
                result = subprocess.run(
                    [manifest["path"]],
                    input=struct.pack("=I", len(request)) + request,
                    cwd=root,
                    capture_output=True,
                    timeout=5,
                    check=True,
                )
                length = struct.unpack("=I", result.stdout[:4])[0]
                self.assertEqual(length, len(result.stdout[4:]))
                self.assertEqual(
                    json.loads(result.stdout[4:]),
                    {"ok": False, "error": "Unsupported request."},
                )
                unrelated = destination / "personal-note.txt"
                unrelated.write_text("Keep this file.")
                with patch.object(sys, "argv", ["install.py", "--uninstall"]):
                    install.main()
                self.assertFalse(manifest_path.exists())
                self.assertFalse((destination / "launch-host").exists())
                for filename in install.COMPANION_FILES:
                    self.assertFalse((destination / filename).exists())
                self.assertEqual(unrelated.read_text(), "Keep this file.")
