import { describe, expect, it } from 'vitest';
import { fromVnDateTimeInput, toVnDateTimeInput } from './hr-datetime.js';

describe('Vietnam HR datetime fields', () => {
  it('shows a server instant as Vietnam wall time independent of browser locale', () => {
    expect(toVnDateTimeInput('2026-10-19T01:00:00.000Z')).toBe('2026-10-19T08:00');
    expect(toVnDateTimeInput('2026-10-19T17:30:00.000Z')).toBe('2026-10-20T00:30');
  });

  it('submits Vietnam wall time as the same authoritative instant', () => {
    expect(fromVnDateTimeInput('2026-10-19T08:00')).toBe('2026-10-19T01:00:00.000Z');
    expect(fromVnDateTimeInput('2026-10-20T00:30')).toBe('2026-10-19T17:30:00.000Z');
    expect(fromVnDateTimeInput('')).toBeNull();
  });

  it('rejects an invalid wall date instead of silently normalizing it', () => {
    expect(() => fromVnDateTimeInput('2026-02-31T08:00')).toThrow();
    expect(() => fromVnDateTimeInput('2026-10-19T24:00')).toThrow();
  });
});
