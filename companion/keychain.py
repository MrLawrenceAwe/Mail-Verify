"""Store Yahoo credentials in the macOS login Keychain."""

import ctypes
import json
from errors import UserError

KEYCHAIN_SERVICE = b"local.yahoo_code_fill"
KEYCHAIN_ACCOUNT = b"mailbox"


def access_saved_credentials(action, credentials_record=None):
    security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    void = ctypes.c_void_p
    uint = ctypes.c_uint32
    security.SecKeychainFindGenericPassword.argtypes = [
        void,
        uint,
        void,
        uint,
        void,
        ctypes.POINTER(uint),
        ctypes.POINTER(void),
        ctypes.POINTER(void),
    ]
    security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    security.SecKeychainItemFreeContent.argtypes = [void, void]
    security.SecKeychainItemModifyAttributesAndData.argtypes = [void, void, uint, void]
    security.SecKeychainAddGenericPassword.argtypes = [
        void,
        uint,
        void,
        uint,
        void,
        uint,
        void,
        ctypes.POINTER(void),
    ]
    security.SecKeychainItemDelete.argtypes = [void]
    core_foundation = ctypes.CDLL(
        "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
    )
    core_foundation.CFRelease.argtypes = [void]
    size, data, item = uint(), void(), void()
    status = security.SecKeychainFindGenericPassword(
        None,
        len(KEYCHAIN_SERVICE),
        KEYCHAIN_SERVICE,
        len(KEYCHAIN_ACCOUNT),
        KEYCHAIN_ACCOUNT,
        ctypes.byref(size),
        ctypes.byref(data),
        ctypes.byref(item),
    )
    if status not in (0, -25300):
        raise UserError(
            "Keychain access was denied or unavailable. Unlock your login Keychain and try again."
        )
    try:
        if action == "get":
            return (
                json.loads(ctypes.string_at(data, size.value)) if status == 0 else None
            )
        if action == "delete":
            result = security.SecKeychainItemDelete(item) if status == 0 else 0
        elif action == "set":
            payload = json.dumps(credentials_record).encode()
            result = (
                security.SecKeychainItemModifyAttributesAndData(
                    item, None, len(payload), payload
                )
                if status == 0
                else security.SecKeychainAddGenericPassword(
                    None,
                    len(KEYCHAIN_SERVICE),
                    KEYCHAIN_SERVICE,
                    len(KEYCHAIN_ACCOUNT),
                    KEYCHAIN_ACCOUNT,
                    len(payload),
                    payload,
                    None,
                )
            )
        else:
            raise UserError("Unsupported Keychain operation.")
        if result:
            raise UserError("Could not update the login Keychain.")
    finally:
        if data:
            security.SecKeychainItemFreeContent(None, data)
        if item:
            core_foundation.CFRelease(item)
