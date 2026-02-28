/**
 * FocusGuard — Popup Script
 *
 * Displays rule statuses and allows managing rules and settings.
 */

const rulesListEl = document.getElementById('rules-list');
const emptyStateEl = document.getElementById('empty-state');
const addToggleEl = document.getElementById('add-toggle');
const addFormEl = document.getElementById('add-form');
const cancelAddEl = document.getElementById('cancel-add');
const settingsToggleEl = document.getElementById('settings-toggle');
const settingsFormEl = document.getElementById('settings-form');
const saveSettingsEl = document.getElementById('save-settings');

// ── Form toggle ────────────────────────────────────────────────

addToggleEl.addEventListener('click', () => {
  addFormEl.classList.toggle('hidden');
  addToggleEl.classList.toggle('hidden');
});

cancelAddEl.addEventListener('click', () => {
  addFormEl.classList.add('hidden');
  addToggleEl.classList.remove('hidden');
});

settingsToggleEl.addEventListener('click', () => {
  settingsFormEl.classList.toggle('hidden');
});

// ── Load status ────────────────────────────────────────────────

async function loadStatus() {
  try {
    const data = await browser.runtime.sendMessage({ type: 'get-status' });
    renderRules(data.statuses);
    renderSettings(data.settings);
  } catch {
    rulesListEl.innerHTML = '<p class="error">Could not load status.</p>';
  }
}

// ── Render rules ───────────────────────────────────────────────

function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || !parts.length) parts.push(`${s}s`);
  return parts.join(' ');
}

function formatSeconds(s) {
  return formatDuration(s * 1000);
}

function renderRules(statuses) {
  // Remove all rule cards but keep empty state
  rulesListEl.querySelectorAll('.rule-card').forEach(el => el.remove());

  if (!statuses || statuses.length === 0) {
    emptyStateEl.classList.remove('hidden');
    return;
  }

  emptyStateEl.classList.add('hidden');

  for (const status of statuses) {
    const card = document.createElement('div');
    card.className = `rule-card ${status.blocked ? 'blocked' : 'active'}`;

    const usedPct = Math.min(100, (status.usedSeconds / status.allowedSeconds) * 100);

    card.innerHTML = `
      <div class="rule-header">
        <span class="rule-domain">${escapeHtml(status.domain)}</span>
        <button class="rule-remove" data-domain="${escapeHtml(status.domain)}" title="Remove rule">&times;</button>
      </div>
      <div class="rule-budget">
        <div class="progress-bar">
          <div class="progress-fill ${status.blocked ? 'exhausted' : ''}" style="width: ${usedPct}%"></div>
        </div>
        <span class="budget-text">
          ${formatSeconds(status.usedSeconds)} / ${status.allowedMinutes}m
          (per ${formatDuration(status.windowMinutes * 60 * 1000)})
        </span>
      </div>
      ${status.blocked
        ? `<div class="rule-blocked">Blocked — available in ${formatDuration(status.timeUntilUnblock)}</div>`
        : `<div class="rule-remaining">${formatSeconds(status.allowedSeconds - status.usedSeconds)} remaining</div>`
      }
      <div class="rule-stats">
        Today: ${formatSeconds(status.stats.today)}
        · Week: ${formatSeconds(status.stats.week)}
        · Month: ${formatSeconds(status.stats.month)}
      </div>
    `;

    rulesListEl.appendChild(card);
  }

  // Attach remove handlers
  rulesListEl.querySelectorAll('.rule-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const domain = e.target.dataset.domain;
      await browser.runtime.sendMessage({ type: 'remove-rule', domain });
      loadStatus();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Render settings ────────────────────────────────────────────

function renderSettings(settings) {
  document.getElementById('input-idle').value = settings.idleThresholdSeconds;
  document.getElementById('input-heartbeat').value = settings.heartbeatIntervalSeconds;
}

// ── Add rule ───────────────────────────────────────────────────

addFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();

  const domainInput = document.getElementById('input-domain');
  const domain = domainInput.value.trim();
  const allowedMinutes = parseInt(document.getElementById('input-minutes').value, 10);
  const windowMinutes = parseInt(document.getElementById('input-window').value, 10);
  const matchSubdomains = document.getElementById('input-subdomains').checked;

  if (!domain || !allowedMinutes || !windowMinutes) return;

  // Clear previous error
  const existingError = addFormEl.querySelector('.form-error');
  if (existingError) existingError.remove();

  const result = await browser.runtime.sendMessage({
    type: 'add-rule',
    rule: { domain, allowedMinutes, windowMinutes, matchSubdomains },
  });

  if (result && !result.success) {
    const errorEl = document.createElement('p');
    errorEl.className = 'form-error';
    errorEl.textContent = result.error || 'Invalid domain';
    addFormEl.prepend(errorEl);
    return;
  }

  // Reset form
  domainInput.value = '';
  document.getElementById('input-minutes').value = '5';
  document.getElementById('input-window').value = '180';
  document.getElementById('input-subdomains').checked = true;
  addFormEl.classList.add('hidden');
  addToggleEl.classList.remove('hidden');

  loadStatus();
});

// ── Save settings ──────────────────────────────────────────────

saveSettingsEl.addEventListener('click', async () => {
  const idleThresholdSeconds = parseInt(document.getElementById('input-idle').value, 10);
  const heartbeatIntervalSeconds = parseInt(document.getElementById('input-heartbeat').value, 10);

  await browser.runtime.sendMessage({
    type: 'update-settings',
    settings: { idleThresholdSeconds, heartbeatIntervalSeconds },
  });

  settingsFormEl.classList.add('hidden');
});

// ── Init ───────────────────────────────────────────────────────

loadStatus();

// Refresh every 5 seconds while popup is open
setInterval(loadStatus, 5000);
