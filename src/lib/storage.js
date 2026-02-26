/**
 * Storage utilities for rules, settings, and usage data.
 * Uses browser.storage.sync for cross-device sync.
 */

const DEFAULT_SETTINGS = {
  idleThresholdSeconds: 120,
  heartbeatIntervalSeconds: 15,
};

let deviceId = null;

/**
 * Get or create a stable device ID.
 */
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

/**
 * Get all rules.
 */
export async function getRules() {
  const result = await browser.storage.sync.get('rules');
  return result.rules || [];
}

/**
 * Save rules.
 */
export async function saveRules(rules) {
  await browser.storage.sync.set({ rules });
}

/**
 * Add a new rule.
 */
export async function addRule(rule) {
  const rules = await getRules();
  // Remove existing rule for same domain
  const filtered = rules.filter(r => r.domain !== rule.domain);
  filtered.push(rule);
  await saveRules(filtered);
  return filtered;
}

/**
 * Remove a rule by domain.
 */
export async function removeRule(domain) {
  const rules = await getRules();
  const filtered = rules.filter(r => r.domain !== domain);
  await saveRules(filtered);
  return filtered;
}

/**
 * Get settings.
 */
export async function getSettings() {
  const result = await browser.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...result.settings };
}

/**
 * Save settings.
 */
export async function saveSettings(settings) {
  await browser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, ...settings } });
}

/**
 * Get the usage key for this device.
 */
async function getUsageKey() {
  const id = await getDeviceId();
  return `usage:${id}`;
}

/**
 * Get usage data for this device.
 */
export async function getLocalUsage() {
  const key = await getUsageKey();
  const result = await browser.storage.sync.get(key);
  return result[key] || {};
}

/**
 * Save usage data for this device.
 */
export async function saveLocalUsage(usage) {
  const key = await getUsageKey();
  await browser.storage.sync.set({ [key]: usage });
}

/**
 * Get all usage data across all devices.
 */
export async function getAllUsage() {
  const all = await browser.storage.sync.get(null);
  const combined = {};

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('usage:')) continue;
    // Merge per-device usage into combined
    for (const [domain, hours] of Object.entries(value)) {
      if (!combined[domain]) combined[domain] = {};
      for (const [hourKey, seconds] of Object.entries(hours)) {
        combined[domain][hourKey] = (combined[domain][hourKey] || 0) + seconds;
      }
    }
  }

  return combined;
}

/**
 * Record active seconds for a domain in the current hour slot.
 */
export async function recordUsage(domain, seconds) {
  const usage = await getLocalUsage();
  const hourKey = getHourKey(new Date());

  if (!usage[domain]) usage[domain] = {};
  usage[domain][hourKey] = (usage[domain][hourKey] || 0) + seconds;

  await saveLocalUsage(usage);
}

/**
 * Get the hour key for a Date. Format: "2026-02-26T10"
 */
export function getHourKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}`;
}

/**
 * Calculate total usage for a domain within a rolling window.
 * @param {object} allUsage - Combined usage from all devices
 * @param {string} domain - Domain to check
 * @param {number} windowMinutes - Rolling window size in minutes
 * @returns {number} Total seconds used within the window
 */
export function getUsageInWindow(allUsage, domain, windowMinutes) {
  const domainUsage = allUsage[domain];
  if (!domainUsage) return 0;

  const now = Date.now();
  const windowStart = now - windowMinutes * 60 * 1000;
  let total = 0;

  for (const [hourKey, seconds] of Object.entries(domainUsage)) {
    const hourStart = hourKeyToTimestamp(hourKey);
    const hourEnd = hourStart + 3600 * 1000;

    // Include this hour if any part overlaps with the window
    if (hourEnd > windowStart && hourStart <= now) {
      total += seconds;
    }
  }

  return total;
}

/**
 * Convert hour key back to timestamp.
 */
function hourKeyToTimestamp(hourKey) {
  // "2026-02-26T10" → parse as local time
  const [datePart, hourStr] = hourKey.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  return new Date(y, m - 1, d, parseInt(hourStr, 10)).getTime();
}

/**
 * Calculate when a domain will become unblocked.
 * Returns milliseconds until unblock, or 0 if not blocked.
 */
export function getTimeUntilUnblock(allUsage, domain, allowedMinutes, windowMinutes) {
  const domainUsage = allUsage[domain];
  if (!domainUsage) return 0;

  const allowedSeconds = allowedMinutes * 60;
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;

  // Collect all usage entries with their timestamps, sorted oldest first
  const entries = [];
  for (const [hourKey, seconds] of Object.entries(domainUsage)) {
    const hourStart = hourKeyToTimestamp(hourKey);
    const hourEnd = hourStart + 3600 * 1000;
    if (hourEnd > now - windowMs && hourStart <= now) {
      entries.push({ hourStart, seconds });
    }
  }
  entries.sort((a, b) => a.hourStart - b.hourStart);

  const totalUsed = entries.reduce((sum, e) => sum + e.seconds, 0);
  if (totalUsed <= allowedSeconds) return 0;

  // Find when enough usage rolls off
  let excessSeconds = totalUsed - allowedSeconds;
  for (const entry of entries) {
    // This entry's usage will roll off when its hour leaves the window
    const rollOffTime = entry.hourStart + windowMs + 3600 * 1000;
    excessSeconds -= entry.seconds;
    if (excessSeconds <= 0) {
      return Math.max(0, rollOffTime - now);
    }
  }

  return 0;
}

/**
 * Get usage stats for a domain over different periods.
 */
export function getUsageStats(allUsage, domain) {
  const domainUsage = allUsage[domain];
  if (!domainUsage) return { today: 0, week: 0, month: 0 };

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - 6 * 24 * 3600 * 1000;
  const monthStart = todayStart - 29 * 24 * 3600 * 1000;

  let today = 0, week = 0, month = 0;

  for (const [hourKey, seconds] of Object.entries(domainUsage)) {
    const ts = hourKeyToTimestamp(hourKey);
    if (ts >= todayStart) today += seconds;
    if (ts >= weekStart) week += seconds;
    if (ts >= monthStart) month += seconds;
  }

  return { today, week, month };
}

/**
 * Prune usage entries older than 30 days across all devices.
 * Only prunes this device's data (each device manages its own).
 */
export async function pruneOldUsage() {
  const usage = await getLocalUsage();
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  let changed = false;

  for (const domain of Object.keys(usage)) {
    for (const hourKey of Object.keys(usage[domain])) {
      const ts = hourKeyToTimestamp(hourKey);
      if (ts + 3600 * 1000 < cutoff) {
        delete usage[domain][hourKey];
        changed = true;
      }
    }
    // Remove domain if empty
    if (Object.keys(usage[domain]).length === 0) {
      delete usage[domain];
    }
  }

  if (changed) {
    await saveLocalUsage(usage);
  }
}
