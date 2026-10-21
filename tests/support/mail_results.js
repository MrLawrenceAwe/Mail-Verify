const messageMetadata = {
  uid: 1,
  accountEmail: "test@yahoo.com",
  sender: "sender@example.com",
  receivedAt: 1000,
};

export function makeVerificationCodeMessage(overrides = {}) {
  return {
    ...messageMetadata,
    code: "123456",
    subject: "Sign in",
    ...overrides,
  };
}

export function makeEmailLinkMessage(overrides = {}) {
  return {
    ...messageMetadata,
    url: "https://example.com/confirm?token=secret",
    subject: "Confirm your email",
    ...overrides,
  };
}
