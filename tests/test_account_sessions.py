"""Account session coordination and timeout cases."""

from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import account_sessions


class AccountSessionsTests(unittest.TestCase):
    def test_whole_check_times_out(self):
        with patch.object(account_sessions, "CHECK_TIMEOUT_SECONDS", 0.01), patch.object(
            account_sessions.InboxSession, "recent_codes", side_effect=lambda: time.sleep(0.2)
        ):
            with self.assertRaisesRegex(account_sessions.UserError, "too long"):
                account_sessions.check_with_timeout(account_sessions.InboxSession({}))


if __name__ == "__main__":
    unittest.main()
