// -----------------------------------------------------------------------------
// The one error type this integration raises on purpose.
//
// It lives in its own module so every driver can throw it without dragging in
// the others: a `code` the caller can branch on, and a message written for the
// person reading it under a button in the Gladys Configuration screen.
// -----------------------------------------------------------------------------

export class PortalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortalError';
    this.code = code;
  }
}
