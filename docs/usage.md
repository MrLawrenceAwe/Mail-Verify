# Using Mail Verify

## Use

| Email type | On-page suggestion | Selected action | Manual popup check |
| --- | --- | --- | --- |
| Verification code | Beside a supported code field | **Fill code**, without clicking Submit | **Find verification codes** |
| Account confirmation | Bottom-right card on a recognised “Check your email” screen | **Open confirmation link** in a new tab; this may immediately confirm the account | **Find confirmation links** |
| Password reset | Bottom-right card on a recognised reset-email waiting screen | **Copy password reset link**, then paste it where you want to use it | **Find password reset links** |

Request the email on the website, then choose its matching result. Review the account, sender, subject, and link host before using it. Hover over a code to see its sender and subject. The extension never chooses a result for you; some websites continue automatically after all code digits are filled. Link cards stay out of the way when a code field is recognised.

Use **↻** to restart checking, or **× / Escape** to dismiss an on-page suggestion. Resending or navigating restores suggestions. Link cards also return when the waiting panel, recipient, or email purpose changes; code suggestions otherwise stay dismissed on that page. The toolbar popup handles account setup and manual checks. A status message confirms a successful reset-link copy; use **Copy again** to repeat it. If a website blocks clipboard access, use the popup.

## Checking and freshness

Automatic checking lasts up to two minutes while the tab is active. Keep the popup open for manual checks. Hiding a tab stops new on-page checks.

Checks show inbox emails from the last ten minutes. Spam and other folders are excluded. Results from slower accounts may appear later.

On-page suggestions show emails received around or after the verification step appeared. Resending clears older suggestions; an email arriving immediately after the click may also be excluded. Use the popup to choose other recent emails manually.

## Supported content and limits

- Supports clearly labelled numeric codes of 4–8 digits and common verification inputs on HTTPS pages.
- Recognises common English confirmation and password-reset email prompts and instructions.
- Omits ambiguous results, hidden content, attachments, and unsupported links. Other languages and unusual forms may not work.
- Does not authenticate senders or match results to the current website. Check the sender and link host before using a result; tracking links may redirect.

See [detection and freshness rules](development.md#detection-and-freshness-rules) for exact matching and timestamp behaviour.

