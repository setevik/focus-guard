/**
 * FocusGuard — Content Script
 *
 * Reports page visibility changes to the background script.
 * Runs on all pages to detect when a tracked tab becomes hidden/visible.
 */

(function () {
  // Report initial visibility state
  browser.runtime.sendMessage({
    type: 'visibility-change',
    isVisible: document.visibilityState === 'visible',
  }).catch(() => {});

  // Listen for visibility changes
  document.addEventListener('visibilitychange', () => {
    browser.runtime.sendMessage({
      type: 'visibility-change',
      isVisible: document.visibilityState === 'visible',
    }).catch(() => {});
  });
})();
