import { ACTIONS } from '../shared/constants.js';
import { detectViewMode, VIEW_MODES } from './modeManager.js';
import {
  getActiveRecord,
  ensureRecordHasChangeTag,
  getDeleteEndpointDetails
} from './recordResolver.js';
import { showToast } from './overlay.js';

const CLOUDKIT_MODIFY_HEADERS = {
  'Content-Type': 'text/plain;charset=UTF-8'
};
const MAX_DELETE_ATTEMPTS = 3;
const DELETE_RETRY_BASE_DELAY_MS = 220;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCloudKitErrorPayload(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return { raw: text };
  }
}

function extractCloudKitErrorCode(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidates = [
    payload.serverErrorCode,
    payload.serverCode,
    payload.reason,
    payload.error,
    payload.errorCode
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().toUpperCase();
    }
  }
  return null;
}

function isZoneBusyCode(code) {
  if (!code) {
    return false;
  }
  return code === 'ZONE_BUSY' || code === 'TRY_AGAIN_LATER';
}

function shouldRetryDelete(status, code, attempt) {
  if (attempt >= MAX_DELETE_ATTEMPTS) {
    return false;
  }

  if (status === 409 && isZoneBusyCode(code)) {
    return true;
  }

  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  return false;
}

function dispatchKey(key, options = {}) {
  const keyCodeMap = {
    ArrowLeft: 37,
    ArrowRight: 39,
    ArrowUp: 38,
    ArrowDown: 40,
    Delete: 46,
    Enter: 13,
    Escape: 27,
    f: 70,
    F: 70
  };
  const keyCode = typeof options.keyCode === 'number' ? options.keyCode : (keyCodeMap[key] || 0);
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body || document.documentElement;

  const eventInit = {
    key,
    code: options.code || key,
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
  const rawRecord = getActiveRecord();
  const record = await ensureRecordHasChangeTag(rawRecord);
  if (!record) {
    return { ok: false, reason: 'MISSING_METADATA' };
  }

  const endpointDetails = await getDeleteEndpointDetails();
  if (!endpointDetails?.url || !endpointDetails?.payloadTemplate) {
    return { ok: false, reason: 'NO_ENDPOINT_CAPTURED' };
  }

  const baseFields = endpointDetails.payloadTemplate.fields || {};
  const recordType = record.recordType || endpointDetails.payloadTemplate.recordType;
  const body = {
    atomic: endpointDetails.payloadTemplate.atomic,
    operations: [
      {
        operationType: 'update',
        record: {
          recordName: record.recordName,
          recordChangeTag: record.recordChangeTag,
          recordType,
          fields: {
            ...baseFields,
            isDeleted: { value: 1 }
          }
        }
      }
    ],
    zoneID: endpointDetails.payloadTemplate.zoneID
  };

  let lastStatus = null;
  let lastCode = null;
  let lastText = '';

  for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS; attempt += 1) {
    try {
      const response = await window.fetch(endpointDetails.url, {
        method: 'POST',
        credentials: 'include',
        headers: { ...CLOUDKIT_MODIFY_HEADERS },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        await response.json().catch(() => null);
        showToast('Photo deleted', { tone: 'success', duration: 1800 });
        postDeleteUiCleanup();
        return { ok: true };
      }

      lastStatus = response.status;
      lastText = await response.text().catch(() => '');
      const payload = parseCloudKitErrorPayload(lastText);
      lastCode = extractCloudKitErrorCode(payload);

      console.warn('Fingertips delete: API HTTP error', {
        recordName: record.recordName,
        status: response.status,
        code: lastCode,
        attempt,
        body: lastText
      });

      if (shouldRetryDelete(response.status, lastCode, attempt)) {
        await sleep(DELETE_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      if (response.status === 409 && isZoneBusyCode(lastCode)) {
        return { ok: false, reason: 'ZONE_BUSY', status: response.status };
      }

      return {
        ok: false,
        reason: 'DELETE_HTTP_ERROR',
        status: response.status,
        code: lastCode
      };
    } catch (err) {
      console.error('Fingertips delete: request failed', err);
      if (attempt < MAX_DELETE_ATTEMPTS) {
        await sleep(DELETE_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      return { ok: false, reason: 'REQUEST_FAILED' };
    }
  }

  return {
    ok: false,
    reason: lastStatus ? 'DELETE_HTTP_ERROR' : 'REQUEST_FAILED',
    status: lastStatus || null,
    code: lastCode,
    body: lastText
  };
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
    case ACTIONS.MOVE_RIGHT:
      if (!navigateOneUp('next')) {
        dispatchKey('ArrowRight');
      }
      break;
    case ACTIONS.MOVE_LEFT:
      if (!navigateOneUp('previous')) {
        dispatchKey('ArrowLeft');
      }
      break;
    case ACTIONS.MOVE_UP:
      dispatchKey('ArrowUp');
      break;
    case ACTIONS.MOVE_DOWN:
      dispatchKey('ArrowDown');
      break;
    case ACTIONS.DELETE:
      await handleDelete();
      break;
    case ACTIONS.FAVORITE:
      await handleFavorite();
      break;
    case ACTIONS.ENTER:
      await handleEnterDetail();
      break;
    case ACTIONS.EXIT:
      dispatchKey('Escape');
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

const FAVORITE_ONE_UP_SELECTORS = [
  '.OneUp button[aria-label="Favorite"]',
  '.OneUp button[aria-label="Add to Favorites"]',
  '.OneUp button[aria-label="Remove from Favorites"]',
  '.OneUp button[aria-label*="Favourite"]'
];

const FAVORITE_GRID_SELECTORS = [
  '.Toolbar button[aria-label="Favorite"]',
  '.Toolbar button[aria-label="Add to Favorites"]',
  '.Toolbar button[aria-label="Remove from Favorites"]',
  '.Toolbar button[aria-label*="Favourite"]'
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

async function handleFavorite() {
  const mode = detectViewMode();

  if (mode === VIEW_MODES.ONE_UP) {
    const button = findFirst(FAVORITE_ONE_UP_SELECTORS);
    if (button) {
      button.click();
      return;
    }
  }

  if (mode === VIEW_MODES.GRID) {
    const button = findFirst(FAVORITE_GRID_SELECTORS);
    if (button) {
      button.click();
      return;
    }
  }

  dispatchKey('f', { code: 'KeyF', keyCode: 70 });
}

async function handleEnterDetail() {
  const mode = detectViewMode();
  if (mode === VIEW_MODES.ONE_UP) {
    return;
  }

  if (mode === VIEW_MODES.GRID) {
    const selected = document.querySelector('.PhotoItemView.is-selected');
    if (selected) {
      selected.focus?.();
      simulateDoubleClick(selected);
      return;
    }
  }

  dispatchKey('Enter');
}

function simulateDoubleClick(element) {
  if (!element) {
    return;
  }

  const events = ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click', 'dblclick'];

  events.forEach((type) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: type === 'dblclick' ? 2 : 1
    });
    element.dispatchEvent(event);
  });
}

async function handleDelete() {
  const result = await deleteViaApi();
  console.info('Fingertips delete: API attempt finished', result);
  if (result.ok) {
    return;
  }

  let fallbackToUi = false;

  switch (result.reason) {
    case 'NO_ENDPOINT_CAPTURED':
      showToast('Delete endpoint not captured yet. Using UI flow.', { tone: 'neutral' });
      fallbackToUi = true;
      break;
    case 'MISSING_METADATA':
      showToast('Need full photo metadata. Using UI delete.', { tone: 'error' });
      fallbackToUi = true;
      break;
    case 'ZONE_BUSY':
      showToast('iCloud Photos is busy. Try again in a moment.', { tone: 'warning' });
      return;
    case 'REQUEST_FAILED':
      showToast('Delete request failed. Try again shortly.', { tone: 'error' });
      return;
    default:
      showToast('Delete via API failed. Falling back to UI.', { tone: 'error' });
      fallbackToUi = true;
      break;
  }

  if (fallbackToUi) {
    console.info('Fingertips delete: falling back to UI flow');
    await deleteViaUiFlow();
  }
}
