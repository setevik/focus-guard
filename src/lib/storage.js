/**
 * Storage utilities for rules, settings, and usage data.
 *
 * Storage layout:
 *   storage.sync  → rules, settings (shared across devices)
 *   storage.sync  → usage:<deviceId> (hour-level summary for cross-device budget)
 *   storage.local → usage (minute-level authoritative data for this device)
 *   storage.local → deviceId
 */

import { canonicalizeDomain } from './domain.js';

const DEFAULT_SETTINGS = {
  idleThresholdSeconds: 120,
  heartbeatIntervalSeconds: 15,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

let deviceId = null;

// ── Device ID ──────────────────────────────────────────────────

export async function getDeviceId() {
  if (deviceId) return deviceId;
  const result = await browser.storage.local.get('deviceId');
  if (result.deviceId) {
    deviceId = result.deviceId;
  } else {
    deviceId = crypto.randomUUID();
    await browser.storage.local.set({ deviceId });
  }
  return deviceId;
}

// ── Rules ──────────────────────────────────────────────────────

export async function getRules() {
  const result = await browser.storage.sync.get('rules');
  return result.rules || [];
}

export async function saveRules(rules) {
  await browser.storage.sync.set({ rules });
}

/**
 * Add or replace a rule. The domain is canonicalized before saving.
 * Returns { rules } on success, or { error } on validation failure.
 */
export async function addRule(rule) {
  const domain = canonicalizeDomain(rule.domain);
  if (!domain) {
    return { error: `Invalid domain: "${rule.domain}"` };
  }

  const canonicalRule = {
    domain,
    allowedMinutes: rule.allowedMinutes,
    windowMinutes: rule.windowMinutes,
    matchSubdomains: rule.matchSubdomains,
  };

  const rules = await getRules();
  const filtered = rules.filter(r => r.domain !== domain);
  filtered.push(canonicalRule);
  await saveRules(filtered);
  return { rules: filtered };
}

export async function removeRule(domain) {
  const rules = await getRules();
  const filtered = rules.filter(r => r.domain !== domain);
  await saveRules(filtered);
  return filtered;
}

// ── Settings ───────────────────────────────────────────────────

export async function getSettings() {
  const result = await browser.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...result.settings };
}

export async function saveSettings(settings) {
  await browser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, ...settings } });
}

// ── Usage (local, minute-level) ────────────────────────────────

export async function getLocalUsage() {
  const result = await browser.storage.local.get('usage');
  return result.usage || {};
}

async function saveLocalUsage(usage) {
  await browser.storage.local.set({ usage });
}

/**
 * Record active seconds for a domain in the current minute slot.
 */
export async function recordUsage(domain, seconds) {
  const usage = await getLocalUsage();
  const key = getMinuteKey(new Date());

  if (!usage[domain]) usage[domain] = {};
  usage[domain][key] = (usage[domain][key] || 0) + seconds;

  await saveLocalUsage(usage);
}

// ── Cross-device usage merge ───────────────────────────────────

/**
 * Get merged usage: this device's minute-level data + other devices'
 * hour-level sync summaries. Our own sync summary is excluded to
 * avoid double-counting.
 */
export async function getAllUsage() {
  const id = await getDeviceId();
  const ownSyncKey = `usage:${id}`;

  const localUsage = await getLocalUsage();

  const syncData = await browser.storage.sync.get(null);
  const combined = {};

  // Local data (minute-level, authoritative for this device)
  for (const [domain, slots] of Object.entries(localUsage)) {
    combined[domain] = { ...slots };
  }

  // Remote devices (hour-level summaries, skip our own)
  for (const [key, value] of Object.entries(syncData)) {
    if (!key.startsWith('usage:')) continue;
    if (key === ownSyncKey) continue;

    for (const [domain, slots] of Object.entries(value)) {
      if (!combined[domain]) combined[domain] = {};
      for (const [slotKey, seconds] of Object.entries(slots)) {
        combined[domain][slotKey] = (combined[domain][slotKey] || 0) + seconds;
      }
    }
  }

  return combined;
}

// ── Sync summary ───────────────────────────────────────────────

/**
 * Aggregate local minute-level data to hour-level and write to
 * storage.sync for cross-device budget enforcement.
 * Keeps only the last 24 hours to stay within sync storage limits.
 */
export async function syncUsageSummary() {
  const localUsage = await getLocalUsage();
  const id = await getDeviceId();
  const key = `usage:${id}`;

  const cutoff = Date.now() - 24 * HOUR_MS;
  const summary = {};

  for (const [domain, slots] of Object.entries(localUsage)) {
    for (const [slotKey, seconds] of Object.entries(slots)) {
      const ts = slotKeyToTimestamp(slotKey);
      if (ts < cutoff) continue;

      const hourKey = toHourKey(slotKey);
      if (!summary[domain]) summary[domain] = {};
      summary[domain][hourKey] = (summary[domain][hourKey] || 0) + seconds;
    }
  }

  await browser.storage.sync.set({ [key]: summary });
}

// ── Time slot utilities ────────────────────────────────────────

/**
 * Minute-level key: "2026-02-28T10:05"
 */
export function getMinuteKey(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

/**
 * Convert any slot key to its start timestamp.
 * Handles both minute ("2026-02-28T10:05") and hour ("2026-02-28T10") keys.
 */
export function slotKeyToTimestamp(key) {
  const tIdx = key.indexOf('T');
  const datePart = key.substring(0, tIdx);
  const timePart = key.substring(tIdx + 1);
  const [y, m, d] = datePart.split('-').map(Number);

  if (timePart.includes(':')) {
    const [h, mi] = timePart.split(':').map(Number);
    return new Date(y, m - 1, d, h, mi).getTime();
  }
  return new Date(y, m - 1, d, parseInt(timePart, 10)).getTime();
}

/**
 * Duration of a slot in milliseconds.
 * Minute key → 60 000 ms, hour key → 3 600 000 ms.
 */
export function slotDurationMs(key) {
  const tIdx = key.indexOf('T');
  return key.indexOf(':', tIdx + 1) !== -1 ? MINUTE_MS : HOUR_MS;
}

/**
 * Extract the hour-level key from any slot key.
 * "2026-02-28T10:05" → "2026-02-28T10"
 * "2026-02-28T10"    → "2026-02-28T10"
 */
function toHourKey(slotKey) {
  return slotKey.substring(0, 13);
}

// ── Budget math (proportional) ─────────────────────────────────

/**
 * Calculate total usage for a domain within a rolling window,
 * using proportional bucket contribution.
 *
 * For each time slot, only the fraction that overlaps with the
 * window [now - windowMs, now] is counted.
 */
export function getUsageInWindow(allUsage, domain, windowMinutes) {
  const domainUsage = allUsage[domain];
  if (!domainUsage) return 0;

  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  const windowStart = now - windowMs;

  let total = 0;

  for (const [key, seconds] of Object.entries(domainUsage)) {
    const slotStart = slotKeyToTimestamp(key);
    const duration = slotDurationMs(key);
    const slotEnd = slotStart + duration;

    const overlapStart = Math.max(slotStart, windowStart);
    const overlapEnd = Math.min(slotEnd, now);

    if (overlapEnd <= overlapStart) continue;

    const fraction = (overlapEnd - overlapStart) / duration;
    total += seconds * fraction;
  }

  return total;
}

/**
 * Calculate milliseconds until a domain becomes unblocked.
 *
 * Models usage contribution as uniformly spread across each slot.
 * As the rolling window slides forward, slots at the trailing edge
 * drain linearly. We walk through drain events chronologically to
 * find when total usage drops below the allowed budget.
 *
 * Returns 0 if not currently blocked.
 */
export function getTimeUntilUnblock(allUsage, domain, allowedMinutes, windowMinutes) {
  const domainUsage = allUsage[domain];
  if (!domainUsage) return 0;

  const allowedSeconds = allowedMinutes * 60;
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;

  const currentUsage = getUsageInWindow(allUsage, domain, windowMinutes);
  if (currentUsage < allowedSeconds) return 0;

  let excess = currentUsage - allowedSeconds;
  // At the exact boundary (excess ≈ 0), return a small fixed value
  // rather than attempting drain math on floating-point dust.
  if (excess < 1) return MINUTE_MS;

  // Build drain schedule.
  // Each slot drains at a constant rate = seconds / duration as the
  // window's trailing edge sweeps through it.
  //
  // For a slot [slotStart, slotEnd]:
  //   drain begins at T = max(now, slotStart + windowMs)
  //   drain ends   at T = slotEnd + windowMs
  //   rate         = seconds / (slotEnd - slotStart)  seconds per ms
  const timePoints = [];

  for (const [key, seconds] of Object.entries(domainUsage)) {
    const slotStart = slotKeyToTimestamp(key);
    const duration = slotDurationMs(key);
    const slotEnd = slotStart + duration;

    // Only slots currently contributing to the window
    if (slotEnd <= now - windowMs || slotStart >= now) continue;

    const rate = seconds / duration; // seconds per ms
    const drainStart = Math.max(now, slotStart + windowMs);
    const drainEnd = slotEnd + windowMs;

    if (drainEnd <= now) continue;

    timePoints.push({ time: drainStart, deltaRate: rate });
    timePoints.push({ time: drainEnd, deltaRate: -rate });
  }

  timePoints.sort((a, b) => a.time - b.time);

  let currentTime = now;
  let activeRate = 0;

  for (const point of timePoints) {
    if (point.time > currentTime && activeRate > 0) {
      const dt = point.time - currentTime;
      const drained = activeRate * dt;

      if (drained >= excess) {
        const needed = excess / activeRate;
        return Math.ceil(currentTime + needed - now);
      }
      excess -= drained;
    }
    currentTime = point.time;
    activeRate += point.deltaRate;
  }

  return 0;
}

/**
 * Usage stats for display (today / last 7 days / last 30 days).
 * Uses proportional contribution at period boundaries.
 */
export function getUsageStats(allUsage, domain) {
  const domainUsage = allUsage[domain];
  if (!domainUsage) return { today: 0, week: 0, month: 0 };

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - 6 * 24 * HOUR_MS;
  const monthStart = todayStart - 29 * 24 * HOUR_MS;

  let today = 0, week = 0, month = 0;

  for (const [key, seconds] of Object.entries(domainUsage)) {
    const slotStart = slotKeyToTimestamp(key);
    const duration = slotDurationMs(key);
    const slotEnd = slotStart + duration;

    // Today
    if (slotEnd > todayStart) {
      const overlap = Math.min(slotEnd, Date.now()) - Math.max(slotStart, todayStart);
      if (overlap > 0) today += seconds * (overlap / duration);
    }
    // Week
    if (slotEnd > weekStart) {
      const overlap = Math.min(slotEnd, Date.now()) - Math.max(slotStart, weekStart);
      if (overlap > 0) week += seconds * (overlap / duration);
    }
    // Month
    if (slotEnd > monthStart) {
      const overlap = Math.min(slotEnd, Date.now()) - Math.max(slotStart, monthStart);
      if (overlap > 0) month += seconds * (overlap / duration);
    }
  }

  return {
    today: Math.round(today),
    week: Math.round(week),
    month: Math.round(month),
  };
}

// ── Cleanup ────────────────────────────────────────────────────

/**
 * Prune local usage entries older than 30 days.
 */
export async function pruneOldUsage() {
  const usage = await getLocalUsage();
  const cutoff = Date.now() - 30 * 24 * HOUR_MS;
  let changed = false;

  for (const domain of Object.keys(usage)) {
    for (const key of Object.keys(usage[domain])) {
      const ts = slotKeyToTimestamp(key);
      const duration = slotDurationMs(key);
      if (ts + duration < cutoff) {
        delete usage[domain][key];
        changed = true;
      }
    }
    if (Object.keys(usage[domain]).length === 0) {
      delete usage[domain];
      changed = true;
    }
  }

  if (changed) {
    await saveLocalUsage(usage);
  }
}
