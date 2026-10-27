"""Create account scan managers with test-owned cleanup."""

from account_scan_manager import AccountScanManager


def create_scan_manager(test_case):
    manager = AccountScanManager()
    test_case.addCleanup(manager.close)
    return manager
