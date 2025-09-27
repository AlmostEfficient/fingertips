import { ACTIONS } from '../shared/constants.js';
import { detectViewMode, VIEW_MODES } from './modeManager.js';
import { getActiveRecord, ensureRecordHasChangeTag } from './recordResolver.js';
import { showToast } from './overlay.js';

function dispatchKey(key) {
  const keyCodeMap = {
    ArrowLeft: 37,
    ArrowRight: 39,
    Delete: 46
  };
  const keyCode = keyCodeMap[key] || 0;
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body || document.documentElement;

  const eventInit = {
    key,
    code: key,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true
  };

  try {
    target.focus?.();
  } catch (err) {
    // ignore focus issues
  }

  ['keydown', 'keyup'].forEach((type) => {
    const toTarget = new KeyboardEvent(type, eventInit);
    defineReadonly(toTarget, 'keyCode', keyCode);
    defineReadonly(toTarget, 'which', keyCode);
    defineReadonly(toTarget, 'key', key);
    defineReadonly(toTarget, 'code', key);
    target.dispatchEvent(toTarget);

    const toWindow = new KeyboardEvent(type, eventInit);
    defineReadonly(toWindow, 'keyCode', keyCode);
    defineReadonly(toWindow, 'which', keyCode);
    defineReadonly(toWindow, 'key', key);
    defineReadonly(toWindow, 'code', key);
    window.dispatchEvent(toWindow);

    propagateToFrames(type, eventInit, keyCode, key);
  });
}

function propagateToFrames(type, eventInit, keyCode, key) {
  const frames = document.querySelectorAll('iframe');
  frames.forEach((frame) => {
    try {
      const frameWindow = frame.contentWindow;
      const frameDocument = frameWindow?.document;
      if (!frameWindow || !frameDocument) {
        return;
      }

      const frameTarget = frameDocument.activeElement && frameDocument.activeElement !== frameDocument.body
        ? frameDocument.activeElement
        : frameDocument.body || frameDocument.documentElement;

      const toFrameTarget = new frameWindow.KeyboardEvent(type, eventInit);
      defineReadonly(toFrameTarget, 'keyCode', keyCode);
      defineReadonly(toFrameTarget, 'which', keyCode);
      defineReadonly(toFrameTarget, 'key', key);
      defineReadonly(toFrameTarget, 'code', key);
      frameTarget?.dispatchEvent?.(toFrameTarget);

      const toFrameWindow = new frameWindow.KeyboardEvent(type, eventInit);
      defineReadonly(toFrameWindow, 'keyCode', keyCode);
      defineReadonly(toFrameWindow, 'which', keyCode);
      defineReadonly(toFrameWindow, 'key', key);
      defineReadonly(toFrameWindow, 'code', key);
      frameWindow.dispatchEvent(toFrameWindow);
    } catch (err) {
      // likely cross-origin; skip
    }
  });
}

function defineReadonly(event, prop, value) {
  if (prop in event && event[prop] === value) {
    return;
  }
  try {
    Object.defineProperty(event, prop, {
      get: () => value
    });
  } catch (err) {
    // Readonly property; ignore.
  }
}

async function deleteViaUiFlow() {
  const mode = detectViewMode();
  if (mode === VIEW_MODES.ONE_UP) {
    const deleteButton = document.querySelector('.OneUp .Toolbar-trailing .DeleteButton, .OneUp .DeleteButton');
    if (deleteButton) {
      deleteButton.click();
      await confirmDeleteModal();
      return true;
    }
  }

  if (mode === VIEW_MODES.GRID) {
    const toolbarDelete = document.querySelector('.Toolbar .DeleteButton');
    if (toolbarDelete) {
      toolbarDelete.click();
      await confirmDeleteModal();
      return true;
    }
  }

  dispatchKey('Delete');
  await confirmDeleteModal();
  return true;
}

async function confirmDeleteModal() {
  await waitFor(() => document.querySelector('ui-dialog, [role="dialog"]'), 800);
  const candidates = Array.from(document.querySelectorAll('ui-button, button')).filter((el) => {
    const text = (el.textContent || '').trim().toLowerCase();
    if (!text) {
      return false;
    }
    return text === 'delete' || text === 'delete photo' || text === 'delete photos' || text === 'delete items';
  });

  if (candidates.length) {
    candidates[0].click();
  }
}

function waitFor(testFn, timeout = 800) {
  return new Promise((resolve) => {
    const start = performance.now();
    const check = () => {
      const result = testFn();
      if (result || performance.now() - start > timeout) {
        resolve(result);
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
}

async function deleteViaApi() {
  const record = ensureRecordHasChangeTag(getActiveRecord());
  if (!record) {
    return { ok: false, reason: 'MISSING_METADATA' };
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'fingertips:performDelete',
      record
    });

    if (response?.ok) {
      showToast('Photo deleted', { tone: 'success', duration: 1800 });
      postDeleteUiCleanup();
      return { ok: true };
    }

    return { ok: false, reason: response?.error || 'UNKNOWN' };
  } catch (err) {
    console.error('Fingertips: background delete failed', err);
    return { ok: false, reason: 'REQUEST_FAILED' };
  }
}

function postDeleteUiCleanup() {
  const mode = detectViewMode();
  if (mode === VIEW_MODES.ONE_UP) {
    setTimeout(() => dispatchKey('ArrowRight'), 50);
  } else if (mode === VIEW_MODES.GRID) {
    const selected = document.querySelector('.PhotoItemView.is-selected');
    if (selected) {
      const next = selected.parentElement?.nextElementSibling?.querySelector('.PhotoItemView');
      selected.remove();
      if (next) {
        next.classList.add('is-selected');
      }
    }
  }
}

export async function performAction(action) {
  switch (action) {
    case ACTIONS.NEXT:
      if (!navigateOneUp('next')) {
        dispatchKey('ArrowRight');
      }
      break;
    case ACTIONS.PREVIOUS:
      if (!navigateOneUp('previous')) {
        dispatchKey('ArrowLeft');
      }
      break;
    case ACTIONS.DELETE:
      await handleDelete();
      break;
    default:
      break;
  }
}

function navigateOneUp(direction) {
  const mode = detectViewMode();
  if (mode !== VIEW_MODES.ONE_UP) {
    return false;
  }

  const selectors = direction === 'next' ? NEXT_BUTTON_SELECTORS : PREV_BUTTON_SELECTORS;
  const button = findFirst(selectors);
  if (button) {
    button.click();
    return true;
  }

  return false;
}

const NEXT_BUTTON_SELECTORS = [
  '.OneUp button[aria-label="Next"], .OneUp button[aria-label="Next Photo"]',
  '.OneUp .OneUpNav button[aria-label="Next"]',
  '.OneUp button[aria-label="Next item"]',
  '.OneUp button[title="Next"]',
  '.OneUp button[aria-label*="Next"]'
];

const PREV_BUTTON_SELECTORS = [
  '.OneUp button[aria-label="Previous"], .OneUp button[aria-label="Previous Photo"]',
  '.OneUp .OneUpNav button[aria-label="Previous"]',
  '.OneUp button[aria-label="Previous item"]',
  '.OneUp button[title="Previous"]',
  '.OneUp button[aria-label*="Previous"]'
];

function findFirst(selectors) {
  const visited = new Set();
  const queue = [document];
  let guard = 0;

  while (queue.length && guard < 2000) {
    guard += 1;
    const root = queue.shift();
    if (!root || visited.has(root)) {
      continue;
    }
    visited.add(root);

    for (const selector of selectors) {
      try {
        const found = root.querySelector?.(selector);
        if (found) {
          return found;
        }
      } catch (err) {
        // ignore selector errors in this root context
      }
    }

    const scope = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const node of scope) {
      if (node.shadowRoot && !visited.has(node.shadowRoot)) {
        queue.push(node.shadowRoot);
      }
      if (node instanceof HTMLIFrameElement) {
        try {
          const doc = node.contentDocument;
          if (doc && !visited.has(doc)) {
            queue.push(doc);
          }
        } catch (err) {
          // cross-origin iframe, skip
        }
      }
    }
  }

  return null;
}

async function handleDelete() {
  const endpointInfo = await chrome.runtime.sendMessage({ type: 'fingertips:getDeleteEndpoint' });
  const hasEndpoint = Boolean(endpointInfo?.details);

  if (hasEndpoint) {
    const result = await deleteViaApi();
    if (result.ok) {
      return;
    }
    if (result.reason === 'NO_ENDPOINT_CAPTURED') {
      showToast('Delete endpoint not captured yet. Using UI flow.', { tone: 'neutral' });
    } else if (result.reason === 'MISSING_METADATA') {
      showToast('Need full photo metadata. Using UI delete.', { tone: 'error' });
    } else {
      showToast('Delete via API failed. Falling back to UI.', { tone: 'error' });
    }
  }

  await deleteViaUiFlow();
}
