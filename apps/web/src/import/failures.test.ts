import { describe, expect, it } from 'vitest';
import { lookupFailure } from './failures';

describe('lookupFailure', () => {
  it('a database without the Phase 2 migration is "not ready", not "offline"', () => {
    expect(
      lookupFailure({ code: '42703', message: 'column import_batches.sha256 does not exist' }),
    ).toBe('not_ready');
    expect(lookupFailure({ code: 'PGRST204', message: 'Could not find the column' })).toBe(
      'not_ready',
    );
    expect(lookupFailure({ code: '42P01', message: 'relation does not exist' })).toBe('not_ready');
  });

  it('only a request that got no answer is "offline"', () => {
    expect(lookupFailure({ code: '', message: 'TypeError: Failed to fetch' })).toBe('offline');
    expect(lookupFailure({ message: 'Load failed' })).toBe('offline');
  });

  it('any other server error is a plain failure', () => {
    expect(lookupFailure({ code: '42501', message: 'permission denied' })).toBe('other');
  });
});
