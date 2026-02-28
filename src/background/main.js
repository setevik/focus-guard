/**
 * FocusGuard — Background (Event Page) Script
 *
 * Responsibilities:
 * - Heartbeat-based active time tracking
 * - Budget enforcement (block when exhausted)
 * - History scrubbing for blocked domains
 * - Message handling from content scripts and popup
 * - Periodic usage compaction/pruning and sync
 *
 * IMPORTANT: All event listeners are registered synchronously at the
 * top level so the event page can be properly woken up by Firefox.
 */

import { getDomainFromUrl, findMatchingRule } from '../lib/domain.js';
import {
  getRules, getSettings, getAllUsage, recordUsage,
  getUsageInWindow, getTimeUntilUnblock, getUsageStats,
  pruneOldUsage, syncUsageSummary, getDeviceId,
  addRule, removeRule, saveSettings,
} from '../lib/storage.js';

// ── State ──────────────────────────────────────────────────────

let currentRules = [];
let settings = { idleThresholdSeconds: 120, heartbeatIntervalSeconds: 15 };
let idleState = 'active'; // 'active' | 'idle' | 'locked'
let trackedTabId = null;
let trackedDomain = null;
let heartbeatTimer = null;
let lastHeartbeatTime = null;
let initialized = false;

// Cached set of currently blocked domains, updated periodically
const blockedDomains = new Set();

// ── Lazy Initialization ────────────────────────────────────────

async function ensureInitialized() {
  if (initialized) return;
  initialized = true;

  await getDeviceId();
  currentRules = await getRules();
  settings = await getSettings();

  browser.idle.setDetectionInterval(settings.idleThresholdSeconds);
  await refreshBlockedDomains();
}

// ── Event Listeners (registered synchronously at top level) ────

browser.tabs.onActivated.addListener(async (activeInfo) => {
  await ensureInitialized();
  await evaluateTab(activeInfo.tabId);
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    if (tab.active) {
      await ensureInitialized();
      await evaluateTab(tabId);
    }
  }
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  await ensureInitialized();
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    stopHeartbeat();
    return;
  }
  await evaluateCurrentTab();
});

browser.idle.onStateChanged.addListener((newState) => {
  idleState = newState;
  if (newState === 'active' && trackedDomain) {
    startHeartbeat();
  } else {
    stopHeartbeat();
  }
});

browser.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'sync') return;

  if (changes.rules) {
    currentRules = changes.rules.newValue || [];
    await refreshBlockedDomains();
    await evaluateCurrentTab();
  }
  if (changes.settings) {
    settings = { ...settings, ...changes.settings.newValue };
    browser.idle.setDetectionInterval(settings.idleThresholdSeconds);

    if (heartbeatTimer) {
      stopHeartbeat();
      if (trackedDomain && idleState === 'active') {
        startHeartbeat();
      }
    }
  }
});

browser.runtime.onMessage.addListener((message, sender) => {
  return onMessage(message, sender);
});

browser.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['blocking']
);

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'prune-usage') {
    pruneOldUsage().then(() => syncUsageSummary());
  } else if (alarm.name === 'history-scrub') {
    scrubAllBlockedHistory();
  } else if (alarm.name === 'sync-usage') {
    syncUsageSummary();
  }
});

// Periodic alarms
browser.alarms.create('prune-usage', { periodInMinutes: 60 });
browser.alarms.create('history-scrub', { periodInMinutes: 10 });
browser.alarms.create('sync-usage', { periodInMinutes: 5 });

// ── Initial load ───────────────────────────────────────────────

(async () => {
  await ensureInitialized();
  await evaluateCurrentTab();
})();

// ── Tab Evaluation ─────────────────────────────────────────────

async function evaluateCurrentTab() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await evaluateTab(tab.id);
    }
  } catch {
    stopHeartbeat();
  }
}

async function evaluateTab(tabId) {
  stopHeartbeat();
  trackedTabId = null;
  trackedDomain = null;

  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return;
  }

  if (!tab.url || !tab.active) return;

  const domain = getDomainFromUrl(tab.url);
  if (!domain) return;

  const rule = findMatchingRule(tab.url, currentRules);
  if (!rule) return;

  const blocked = await isDomainBlocked(domain, rule);
  if (blocked) {
    redirectToBlocked(tabId, domain);
    return;
  }

  trackedTabId = tabId;
  trackedDomain = domain;

  if (idleState === 'active') {
    startHeartbeat();
  }
}

// ── Budget Check ───────────────────────────────────────────────

async function isDomainBlocked(domain, rule) {
  const allUsage = await getAllUsage();
  const usedSeconds = getUsageInWindow(allUsage, domain, rule.windowMinutes);
  return usedSeconds >= rule.allowedMinutes * 60;
}

function redirectToBlocked(tabId, domain) {
  const blockedUrl = browser.runtime.getURL(
    `src/blocked/blocked.html?domain=${encodeURIComponent(domain)}`
  );
  browser.tabs.update(tabId, { url: blockedUrl });
}

// ── Request Interception ───────────────────────────────────────

function onBeforeRequest(details) {
  if (details.type !== 'main_frame') return {};

  const domain = getDomainFromUrl(details.url);
  if (!domain) return {};

  const rule = findMatchingRule(details.url, currentRules);
  if (!rule) return {};

  if (blockedDomains.has(domain)) {
    const blockedUrl = browser.runtime.getURL(
      `src/blocked/blocked.html?domain=${encodeURIComponent(domain)}`
    );
    return { redirectUrl: blockedUrl };
  }

  return {};
}

async function refreshBlockedDomains() {
  const allUsage = await getAllUsage();
  blockedDomains.clear();
  for (const rule of currentRules) {
    const usedSeconds = getUsageInWindow(allUsage, rule.domain, rule.windowMinutes);
    if (usedSeconds >= rule.allowedMinutes * 60) {
      blockedDomains.add(rule.domain);
    }
  }
}

// ── Heartbeat ──────────────────────────────────────────────────

function startHeartbeat() {
  if (heartbeatTimer) return;
  lastHeartbeatTime = Date.now();
  heartbeatTimer = setInterval(onHeartbeatTick, settings.heartbeatIntervalSeconds * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    if (lastHeartbeatTime && trackedDomain) {
      const elapsed = (Date.now() - lastHeartbeatTime) / 1000;
      if (elapsed >= 1) {
        recordUsage(trackedDomain, Math.round(elapsed));
      }
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    lastHeartbeatTime = null;
  }
}

async function onHeartbeatTick() {
  if (!trackedDomain || idleState !== 'active') {
    stopHeartbeat();
    return;
  }

  const now = Date.now();
  const elapsed = lastHeartbeatTime ? (now - lastHeartbeatTime) / 1000 : settings.heartbeatIntervalSeconds;
  lastHeartbeatTime = now;

  // Detect gaps (e.g., Android suspension) — cap at 2x interval
  const maxExpected = settings.heartbeatIntervalSeconds * 2;
  const secondsToRecord = elapsed > maxExpected ? settings.heartbeatIntervalSeconds : Math.round(elapsed);

  await recordUsage(trackedDomain, secondsToRecord);

  const rule = currentRules.find(r => r.domain === trackedDomain);
  if (rule) {
    const blocked = await isDomainBlocked(trackedDomain, rule);
    if (blocked) {
      stopHeartbeat();
      redirectToBlocked(trackedTabId, trackedDomain);
      await refreshBlockedDomains();
      await scrubHistoryForDomain(trackedDomain);
      trackedTabId = null;
      trackedDomain = null;
      return;
    }
  }

  await refreshBlockedDomains();
}

// ── Content Script Visibility ──────────────────────────────────

function handleVisibilityChange(tabId, isVisible) {
  if (tabId !== trackedTabId) return;

  if (isVisible && idleState === 'active') {
    startHeartbeat();
  } else {
    stopHeartbeat();
  }
}

// ── History Scrubbing ──────────────────────────────────────────

async function scrubHistoryForDomain(domain) {
  try {
    const results = await browser.history.search({
      text: domain,
      startTime: 0,
      maxResults: 1000,
    });
    for (const item of results) {
      const itemDomain = getDomainFromUrl(item.url);
      if (itemDomain === domain) {
        await browser.history.deleteUrl({ url: item.url });
      }
    }
  } catch {
    // history API may not be available in all contexts
  }
}

async function scrubAllBlockedHistory() {
  await refreshBlockedDomains();
  for (const domain of blockedDomains) {
    await scrubHistoryForDomain(domain);
  }
}

// ── Message Handler ────────────────────────────────────────────

function onMessage(message, sender) {
  switch (message.type) {
    case 'visibility-change':
      handleVisibilityChange(sender.tab?.id, message.isVisible);
      return;

    case 'get-status': {
      return (async () => {
        await ensureInitialized();
        const allUsage = await getAllUsage();
        const statuses = [];
        for (const rule of currentRules) {
          const usedSeconds = getUsageInWindow(allUsage, rule.domain, rule.windowMinutes);
          const allowedSeconds = rule.allowedMinutes * 60;
          const blocked = usedSeconds >= allowedSeconds;
          const timeUntilUnblock = blocked
            ? getTimeUntilUnblock(allUsage, rule.domain, rule.allowedMinutes, rule.windowMinutes)
            : 0;
          const stats = getUsageStats(allUsage, rule.domain);

          statuses.push({
            domain: rule.domain,
            allowedMinutes: rule.allowedMinutes,
            windowMinutes: rule.windowMinutes,
            usedSeconds: Math.round(usedSeconds),
            allowedSeconds,
            blocked,
            timeUntilUnblock,
            stats,
          });
        }
        return { rules: currentRules, settings, statuses };
      })();
    }

    case 'get-block-info': {
      return (async () => {
        await ensureInitialized();
        const domain = message.domain;
        const allUsage = await getAllUsage();
        const rule = currentRules.find(r => r.domain === domain);
        if (!rule) return null;

        const usedSeconds = getUsageInWindow(allUsage, domain, rule.windowMinutes);
        const timeUntilUnblock = getTimeUntilUnblock(
          allUsage, domain, rule.allowedMinutes, rule.windowMinutes
        );
        const stats = getUsageStats(allUsage, domain);

        return {
          domain,
          allowedMinutes: rule.allowedMinutes,
          windowMinutes: rule.windowMinutes,
          usedSeconds: Math.round(usedSeconds),
          timeUntilUnblock,
          stats,
        };
      })();
    }

    case 'add-rule':
      return (async () => {
        await ensureInitialized();
        const result = await addRule(message.rule);
        if (result.error) {
          return { success: false, error: result.error };
        }
        currentRules = result.rules;
        await refreshBlockedDomains();
        return { success: true, rules: result.rules };
      })();

    case 'remove-rule':
      return (async () => {
        await ensureInitialized();
        const updated = await removeRule(message.domain);
        currentRules = updated;
        await refreshBlockedDomains();
        return { success: true, rules: updated };
      })();

    case 'update-settings':
      return (async () => {
        await ensureInitialized();
        await saveSettings(message.settings);
        settings = { ...settings, ...message.settings };
        return { success: true, settings };
      })();
  }
}
