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
  const eventInit = {
    key,
    code: key,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true
  };

  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body || document.documentElement;

  target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
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
      dispatchKey('ArrowRight');
      break;
    case ACTIONS.PREVIOUS:
      dispatchKey('ArrowLeft');
      break;
    case ACTIONS.DELETE:
      await handleDelete();
      break;
    default:
      break;
  }
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
