import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRetryAfter } from '../../../src/providers/transport/errors.ts';

afterEach(() => vi.useRealTimers());

describe('parseRetryAfter', () => {
  it('数字按秒,HTTP 日期按距今,缺失与不成形为 null', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T00:00:00Z'));
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('Wed, 21 Sep 2026 00:00:30 GMT')).toBe(30000);
  });
  it('已过期的日期不等待', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T00:00:00Z'));
    expect(parseRetryAfter('Mon, 01 Jan 2024 00:00:00 GMT')).toBe(0);
  });
});
