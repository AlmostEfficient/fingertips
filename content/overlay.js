const TOAST_DURATION = 2500;

let container = null;

function ensureContainer() {
  if (container) {
    return container;
  }
  container = document.createElement('div');
  container.id = 'fingertips-notify';
  container.style.cssText = [
    'position: fixed',
    'top: 24px',
    'right: 24px',
    'display: flex',
    'flex-direction: column',
    'gap: 8px',
    'z-index: 2147483647',
    'pointer-events: none'
  ].join(';');
  document.body.appendChild(container);
  return container;
}

export function showToast(message, { tone = 'neutral', duration = TOAST_DURATION } = {}) {
  if (!message) {
    return;
  }
  const host = ensureContainer();
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = [
    'min-width: 200px',
    'max-width: 320px',
    'padding: 10px 14px',
    'border-radius: 12px',
    'font-size: 13px',
    'line-height: 1.4',
    'color: white',
    'background: rgba(28, 28, 30, 0.88)',
    'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45)',
    'pointer-events: auto',
    'border: 1px solid rgba(255, 255, 255, 0.08)'
  ].join(';');

  if (tone === 'success') {
    toast.style.background = 'rgba(22, 160, 133, 0.92)';
  } else if (tone === 'error') {
    toast.style.background = 'rgba(192, 57, 43, 0.92)';
  }

  host.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 180ms ease';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 220);
  }, duration);
}
