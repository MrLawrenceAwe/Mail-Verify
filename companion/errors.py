import imaplib


class UserError(Exception):
    """An error whose message can be displayed to the user."""

    def __init__(self, message, *, code=None):
        super().__init__(message)
        self.code = code


def inbox_error_message(error):
    if isinstance(error, UserError):
        return str(error)
    if isinstance(error, (imaplib.IMAP4.abort, OSError)):
        return "Could not reach Yahoo Mail. Check your internet connection and try checking again."
    return (
        "Yahoo rejected the mail check. Try checking again. If it still fails, "
        "use Add or update Yahoo account in the toolbar popup to check your "
        "email address and save a new Yahoo-generated app password."
    )
