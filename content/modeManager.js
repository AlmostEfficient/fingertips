export const VIEW_MODES = {
  GRID: 'grid',
  ONE_UP: 'oneUp',
  UNKNOWN: 'unknown'
};

export function detectViewMode() {
  const hash = window.location.hash || '';
  if (/^#\/i,/.test(hash)) {
    return VIEW_MODES.ONE_UP;
  }
  if (document.querySelector('.OneUp')) {
    return VIEW_MODES.ONE_UP;
  }
  if (document.querySelector('.AssetGridPageContent')) {
    return VIEW_MODES.GRID;
  }
  return VIEW_MODES.UNKNOWN;
}

export function observeModeChanges(callback) {
  let lastMode = detectViewMode();

  function notifyIfChanged() {
    const next = detectViewMode();
    if (next !== lastMode) {
      lastMode = next;
      callback(next);
    }
  }

  window.addEventListener('hashchange', () => setTimeout(notifyIfChanged, 50));
  const observer = new MutationObserver(() => notifyIfChanged());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    window.removeEventListener('hashchange', notifyIfChanged);
    observer.disconnect();
  };
}
