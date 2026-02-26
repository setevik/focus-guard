/**
 * FocusGuard — Blocked Page Script
 *
 * Shows countdown timer and usage statistics for a blocked domain.
 */

const params = new URLSearchParams(window.location.search);
const domain = params.get('domain');

const domainEl = document.getElementById('domain-name');
const countdownEl = document.getElementById('countdown');
const statsValueEl = document.getElementById('stats-value');
const ruleInfoEl = document.getElementById('rule-info');

let blockInfo = null;
let currentPeriod = 'today';

function formatDuration(ms) {
  if (ms <= 0) return '0s';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatSeconds(totalSeconds) {
  if (totalSeconds <= 0) return '0s';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function updateCountdown() {
  if (!blockInfo || !blockInfo.timeUntilUnblock) {
    countdownEl.textContent = '—';
    return;
  }

  const elapsed = Date.now() - blockInfo.fetchedAt;
  const remaining = Math.max(0, blockInfo.timeUntilUnblock - elapsed);

  if (remaining <= 0) {
    countdownEl.textContent = 'Available now!';
    countdownEl.classList.add('available');
    return;
  }

  countdownEl.textContent = formatDuration(remaining);
}

function updateStats() {
  if (!blockInfo || !blockInfo.stats) {
    statsValueEl.textContent = '—';
    return;
  }

  const seconds = blockInfo.stats[currentPeriod] || 0;
  statsValueEl.textContent = formatSeconds(seconds);
}

function updateRuleInfo() {
  if (!blockInfo) return;
  ruleInfoEl.textContent = `Budget: ${blockInfo.allowedMinutes} min per ${formatDuration(blockInfo.windowMinutes * 60 * 1000)} window`;
}

async function fetchBlockInfo() {
  try {
    const info = await browser.runtime.sendMessage({
      type: 'get-block-info',
      domain,
    });
    if (info) {
      blockInfo = { ...info, fetchedAt: Date.now() };
      updateCountdown();
      updateStats();
      updateRuleInfo();
    }
  } catch {
    // Extension context may be invalid
  }
}

// Set up tab buttons
document.querySelectorAll('.stats-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.stats-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentPeriod = tab.dataset.period;
    updateStats();
  });
});

// Init
if (domain) {
  domainEl.textContent = domain;
  fetchBlockInfo();

  // Update countdown every second
  setInterval(updateCountdown, 1000);

  // Refresh data every 30 seconds
  setInterval(fetchBlockInfo, 30000);
} else {
  domainEl.textContent = 'Unknown';
  countdownEl.textContent = '—';
}
