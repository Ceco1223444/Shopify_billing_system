/**
 * Remembers that the next sign-in was started from THIS tab (the login form).
 * A sign-in that arrives without it came from another tab of the same browser,
 * which shares one login across all its tabs and windows.
 */
let startedHere = false;

export function markLoginStartedHere(): void {
  startedHere = true;
}

export function consumeLoginStartedHere(): boolean {
  const value = startedHere;
  startedHere = false;
  return value;
}
