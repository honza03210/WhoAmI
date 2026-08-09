import { describe, expect, it } from 'vitest';
import { describeError } from '../client/src/errors';

/**
 * The embedded SDK rejects with RPC payloads rather than Errors. Rendering one with `String()`
 * produces "[object Object]" — which is what a misconfigured Discord application used to show
 * instead of the reason. Nothing here may ever return that.
 */
describe('describeError', () => {
  it('uses an Error message', () => {
    expect(describeError(new Error('Token exchange failed (502)'))).toBe('Token exchange failed (502)');
  });

  it('reads the shape the SDK actually rejects with', () => {
    expect(describeError({ code: 4006, message: 'Not authenticated' })).toBe('Not authenticated (code 4006)');
    expect(describeError({ message: 'Invalid scope' })).toBe('Invalid scope');
    expect(describeError({ code: 4006 })).toBe('(code 4006)');
  });

  it('reads an error field when there is no message', () => {
    expect(describeError({ error: 'invalid_client' })).toBe('invalid_client');
  });

  it('falls back to the serialized payload rather than losing it', () => {
    expect(describeError({ rpc: { detail: 'nope' } })).toBe('{"rpc":{"detail":"nope"}}');
  });

  it('survives values that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(describeError(circular)).toBe('[object Object]');
  });

  it('passes strings through', () => {
    expect(describeError('plain failure')).toBe('plain failure');
  });

  it('never renders a useful object as "[object Object]"', () => {
    for (const thrown of [
      { code: 4006, message: 'Not authenticated' },
      { message: 'Invalid scope' },
      { error: 'invalid_client' },
      { rpc: { detail: 'nope' } },
      new Error('boom'),
    ]) {
      expect(describeError(thrown)).not.toBe('[object Object]');
    }
  });

  it('handles an Error with no message', () => {
    expect(describeError(new Error())).toBe('Error');
  });
});
