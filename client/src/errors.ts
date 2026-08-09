/**
 * Turning whatever was thrown into something a human can act on.
 *
 * Kept apart from discord.ts deliberately: that module reads `window` as it loads, and this is a
 * pure function worth testing without a browser.
 */

/**
 * The embedded SDK rejects with plain RPC payloads rather than Errors, so the obvious
 * `String(error)` renders "[object Object]" on the error screen and throws away the only useful
 * information there was — exactly when it is needed, during first-time application setup.
 */
export function describeError(error: unknown): string {
  // An Error with an empty message still beats rendering nothing at all.
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  if (typeof error === 'string') return error;

  if (error !== null && typeof error === 'object') {
    const payload = error as { message?: unknown; code?: unknown; error?: unknown };
    const parts: string[] = [];
    if (typeof payload.message === 'string' && payload.message) parts.push(payload.message);
    else if (typeof payload.error === 'string' && payload.error) parts.push(payload.error);
    if (payload.code !== undefined) parts.push(`(code ${String(payload.code)})`);
    if (parts.length > 0) return parts.join(' ');

    try {
      return JSON.stringify(error);
    } catch {
      // Circular or otherwise unserialisable; fall through to String().
    }
  }
  return String(error);
}
