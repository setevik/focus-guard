import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getMinuteKey,
  slotKeyToTimestamp,
  slotDurationMs,
  getUsageInWindow,
  getTimeUntilUnblock,
  getUsageStats,
} from '../src/lib/storage.js';

// ── getMinuteKey ───────────────────────────────────────────────

describe('getMinuteKey', () => {
  it('formats date as minute-level key', () => {
    const date = new Date(2026, 1, 28, 10, 5); // Feb 28, 2026, 10:05
    assert.equal(getMinuteKey(date), '2026-02-28T10:05');
  });

  it('zero-pads single-digit values', () => {
    const date = new Date(2026, 0, 3, 9, 7); // Jan 3, 2026, 09:07
    assert.equal(getMinuteKey(date), '2026-01-03T09:07');
  });

  it('handles midnight', () => {
    const date = new Date(2026, 5, 15, 0, 0);
    assert.equal(getMinuteKey(date), '2026-06-15T00:00');
  });
});

// ── slotKeyToTimestamp ─────────────────────────────────────────

describe('slotKeyToTimestamp', () => {
  it('parses minute keys', () => {
    const ts = slotKeyToTimestamp('2026-02-28T10:05');
    const expected = new Date(2026, 1, 28, 10, 5).getTime();
    assert.equal(ts, expected);
  });

  it('parses hour keys', () => {
    const ts = slotKeyToTimestamp('2026-02-28T10');
    const expected = new Date(2026, 1, 28, 10, 0).getTime();
    assert.equal(ts, expected);
  });

  it('roundtrips with getMinuteKey', () => {
    const date = new Date(2026, 1, 28, 14, 30);
    const key = getMinuteKey(date);
    const ts = slotKeyToTimestamp(key);
    // Should match to the start of that minute
    assert.equal(ts, new Date(2026, 1, 28, 14, 30).getTime());
  });
});

// ── slotDurationMs ─────────────────────────────────────────────

describe('slotDurationMs', () => {
  it('returns 60s for minute keys', () => {
    assert.equal(slotDurationMs('2026-02-28T10:05'), 60_000);
  });

  it('returns 1h for hour keys', () => {
    assert.equal(slotDurationMs('2026-02-28T10'), 3_600_000);
  });
});

// ── getUsageInWindow ───────────────────────────────────────────

describe('getUsageInWindow', () => {
  it('returns 0 for unknown domain', () => {
    assert.equal(getUsageInWindow({}, 'reddit.com', 180), 0);
  });

  it('returns 0 for empty usage', () => {
    const usage = { 'reddit.com': {} };
    assert.equal(getUsageInWindow(usage, 'reddit.com', 180), 0);
  });

  it('sums usage from minute slots fully within the window', () => {
    const now = Date.now();
    const key1 = getMinuteKey(new Date(now - 10 * 60_000)); // 10 min ago
    const key2 = getMinuteKey(new Date(now - 5 * 60_000));  // 5 min ago

    const usage = {
      'reddit.com': {
        [key1]: 15,
        [key2]: 15,
      },
    };

    const result = getUsageInWindow(usage, 'reddit.com', 180);
    assert.equal(result, 30);
  });

  it('excludes slots outside the window', () => {
    const now = Date.now();
    const insideKey = getMinuteKey(new Date(now - 5 * 60_000));    // 5 min ago
    const outsideKey = getMinuteKey(new Date(now - 200 * 60_000)); // 200 min ago (outside 180-min window)

    const usage = {
      'reddit.com': {
        [insideKey]: 15,
        [outsideKey]: 15,
      },
    };

    const result = getUsageInWindow(usage, 'reddit.com', 180);
    assert.equal(result, 15);
  });

  it('applies proportional contribution for partially overlapping hour slots', () => {
    const now = Date.now();
    // Create an hour slot that starts 3.5 hours ago — only 30 min overlap with a 180-min window
    const threeAndHalfHoursAgo = new Date(now - 210 * 60_000);
    const hourStart = new Date(
      threeAndHalfHoursAgo.getFullYear(),
      threeAndHalfHoursAgo.getMonth(),
      threeAndHalfHoursAgo.getDate(),
      threeAndHalfHoursAgo.getHours()
    );
    const hourKey = `${hourStart.getFullYear()}-${String(hourStart.getMonth() + 1).padStart(2, '0')}-${String(hourStart.getDate()).padStart(2, '0')}T${String(hourStart.getHours()).padStart(2, '0')}`;

    // The hour slot covers [hourStart, hourStart + 1h].
    // Window covers [now - 180min, now].
    // If hourStart is ~3.5h ago, hourEnd is ~2.5h ago.
    // Window start is 3h ago.
    // Overlap = hourEnd - windowStart = 2.5h_ago - 3h_ago = wait let me compute more carefully

    // hourStart = now - 210min
    // hourEnd = now - 210min + 60min = now - 150min
    // windowStart = now - 180min
    // overlap = min(hourEnd, now) - max(hourStart, windowStart) = (now-150min) - (now-180min) = 30min
    // fraction = 30min / 60min = 0.5

    const usage = {
      'reddit.com': {
        [hourKey]: 120, // 120 seconds in that hour
      },
    };

    const result = getUsageInWindow(usage, 'reddit.com', 180);
    // Proportional: fraction of the hour that overlaps with the window
    // Exact value depends on timing, but should be between 40 and 70
    assert.ok(result > 0 && result < 120, `Expected proportional fraction of 120, got ${result}`);
  });

  it('handles mixed minute and hour slots', () => {
    const now = Date.now();
    const minuteKey = getMinuteKey(new Date(now - 5 * 60_000)); // 5 min ago

    // Hour slot from 2 hours ago (fully within 180-min window)
    const twoHoursAgo = new Date(now - 120 * 60_000);
    const hourKey = `${twoHoursAgo.getFullYear()}-${String(twoHoursAgo.getMonth() + 1).padStart(2, '0')}-${String(twoHoursAgo.getDate()).padStart(2, '0')}T${String(twoHoursAgo.getHours()).padStart(2, '0')}`;

    const usage = {
      'reddit.com': {
        [minuteKey]: 15,   // minute slot: fully within window
        [hourKey]: 60,     // hour slot: fully within window
      },
    };

    const result = getUsageInWindow(usage, 'reddit.com', 180);
    assert.equal(result, 75);
  });
});

// ── getTimeUntilUnblock ────────────────────────────────────────

describe('getTimeUntilUnblock', () => {
  it('returns 0 when not blocked', () => {
    const now = Date.now();
    const key = getMinuteKey(new Date(now - 5 * 60_000));

    const usage = {
      'reddit.com': { [key]: 60 }, // 1 min used
    };

    // Budget: 5 min per 180 min
    assert.equal(getTimeUntilUnblock(usage, 'reddit.com', 5, 180), 0);
  });

  it('returns 0 for unknown domain', () => {
    assert.equal(getTimeUntilUnblock({}, 'reddit.com', 5, 180), 0);
  });

  it('returns positive value when blocked', () => {
    const now = Date.now();
    // Exceed budget: 6 minutes of usage (budget is 5) across recent minute slots
    const usage = { 'reddit.com': {} };
    for (let i = 1; i <= 24; i++) {
      const key = getMinuteKey(new Date(now - i * 60_000));
      usage['reddit.com'][key] = 15; // 15s per minute slot = 360s total = 6 min
    }

    const timeUntil = getTimeUntilUnblock(usage, 'reddit.com', 5, 180);
    assert.ok(timeUntil > 0, `Expected positive, got ${timeUntil}`);
    // Excess = 60s. Each slot drains at 15s/60000ms.
    // The oldest slot (24 min ago) starts draining at slotStart + windowMs = ~156 min from now.
    // At that point, drain rate = 15/60000 s/ms. Time to drain 60s = 60/(15/60000) = 240000ms = 4 min.
    // So unblock ≈ 156 + 4 = 160 min from now.
    assert.ok(
      timeUntil > 100 * 60_000,
      `Expected >100 min, got ${Math.round(timeUntil / 60_000)} min`
    );
  });

  it('returns positive value for exact boundary (usage == limit)', () => {
    const now = Date.now();
    const key = getMinuteKey(new Date(now - 2 * 60_000));
    const usage = {
      'reddit.com': { [key]: 300 }, // exactly 5 min
    };

    const timeUntil = getTimeUntilUnblock(usage, 'reddit.com', 5, 180);
    // At exact boundary, returns the minimum 60s sentinel
    assert.ok(timeUntil > 0, `Expected positive, got ${timeUntil}`);
  });

  it('handles hour-level remote slots in countdown', () => {
    const now = Date.now();
    // Hour slot from 30 min ago (fully in window)
    const hourDate = new Date(now - 30 * 60_000);
    const hourKey = `${hourDate.getFullYear()}-${String(hourDate.getMonth() + 1).padStart(2, '0')}-${String(hourDate.getDate()).padStart(2, '0')}T${String(hourDate.getHours()).padStart(2, '0')}`;

    const usage = {
      'reddit.com': { [hourKey]: 600 }, // 10 min in a single hour slot
    };

    const timeUntil = getTimeUntilUnblock(usage, 'reddit.com', 5, 180);
    assert.ok(timeUntil > 0, `Expected positive, got ${timeUntil}`);
  });
});

// ── getUsageStats ──────────────────────────────────────────────

describe('getUsageStats', () => {
  it('returns zeros for unknown domain', () => {
    const stats = getUsageStats({}, 'reddit.com');
    assert.deepEqual(stats, { today: 0, week: 0, month: 0 });
  });

  it('counts today usage', () => {
    const now = Date.now();
    const key = getMinuteKey(new Date(now - 5 * 60_000));
    const usage = { 'reddit.com': { [key]: 120 } };

    const stats = getUsageStats(usage, 'reddit.com');
    assert.equal(stats.today, 120);
    assert.equal(stats.week, 120);
    assert.equal(stats.month, 120);
  });

  it('separates today from older usage', () => {
    const now = new Date();
    const todayKey = getMinuteKey(new Date(now.getTime() - 5 * 60_000));

    // Yesterday slot
    const yesterday = new Date(now.getTime() - 30 * 3_600_000);
    const yesterdayKey = getMinuteKey(yesterday);

    const usage = {
      'reddit.com': {
        [todayKey]: 60,
        [yesterdayKey]: 90,
      },
    };

    const stats = getUsageStats(usage, 'reddit.com');
    assert.equal(stats.today, 60);
    assert.ok(stats.week >= 150, `Expected week >= 150, got ${stats.week}`);
  });
});
