# Using Mail Verify

## Use

| Email type | On-page suggestion | Selected action | Manual popup check |
| --- | --- | --- | --- |
| Verification code | Beside a supported code field | **Fill code**, without clicking Submit | **Find verification codes** |
| Account confirmation | Bottom-right card on a recognised “Check your email” screen | **Open confirmation link** in a new tab; this may immediately confirm the account | **Find confirmation links** |
| Password reset | Bottom-right card on a recognised reset-email waiting screen | **Open reset link ↗** to open it in a new tab | **Find password reset links** |

Request the email on the website, then choose its matching result. Review the account, sender, subject, arrival time, and link domain before using it. Results show the arrival time in your local timezone, including seconds to distinguish repeated requests. Code suggestions show the sender and inbox; hover to see the subject. The extension never chooses a result for you; some websites continue automatically after all code digits are filled. Link cards stay out of the way when a code field is recognised.

Use **↻** to restart checking, or **× / Escape** to dismiss an on-page suggestion. Resending or navigating restores suggestions. Link cards also return when the waiting panel, recipient, or email purpose changes; code suggestions otherwise stay dismissed on that page. The toolbar popup handles account setup and manual checks. Reset links open in a new tab; complete the new password on the website.

## Checking and freshness

Automatic checking runs in two-minute windows. Hiding a tab stops new on-page checks. Code suggestions start a new window when they return after hiding the tab or scrolling the code field offscreen. Link cards keep their existing deadline when the tab returns. Use **↻** or resend the email to start another window; a new verification step also starts one. Keep the popup open for manual checks.

Checks show inbox emails from the last ten minutes. Spam and other folders are excluded. Results from slower accounts may appear later.

Initial checks inspect the newest 30 messages in each inbox; later checks discover up to 30 newly arrived messages at a time. Messages larger than 1,000,000 bytes (1 MB), including attachments, are skipped. A recent email can therefore be missed in a busy inbox or if it is too large. If an expected result is absent, check Yahoo directly.

Initial on-page code and link suggestions accept emails from the last ten minutes, including mail delivered before the page loaded. Later code steps allow emails received up to five seconds before the step appeared. Changing an existing link panel, recipient, or email purpose excludes mail dated before the next whole second. Resending clears older suggestions; an email arriving immediately after the click may also be excluded. Use the popup to choose other recent emails manually.

## Supported content and limits

- Supports clearly labelled numeric codes of 4–8 digits and common verification inputs on HTTPS pages.
- Recognises common English confirmation and password-reset email prompts and instructions.
- Omits ambiguous results, attachment content, and unsupported links. Other languages and unusual forms may not work.
- HTML filtering skips scripts, styles, templates, and content marked with `hidden`, `aria-hidden="true"`, or inline `display: none` / `visibility: hidden`. It does not evaluate stylesheets; content hidden through CSS classes or other styling may still produce results.
- Does not authenticate senders or match results to the current website. Check the sender and link domain before using a result; tracking links may redirect.

See [detection and freshness rules](development.md#detection-and-freshness-rules) for exact matching and timestamp behaviour.
