import {
  ACTIONS,
  ACTION_LABELS,
  DEFAULT_GESTURE_MAP,
  GESTURE_NAMES
} from '../shared/constants.js';

let currentState = null;

const statusEl = document.getElementById('status');
const mappingsContainer = document.getElementById('mappings');
const activationToggle = document.getElementById('activation-toggle');
const requestCameraButton = document.getElementById('request-camera');
const restoreButton = document.getElementById('restore-defaults');
const rowTemplate = document.getElementById('mapping-row');

function setStatus(message, isError = false) {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
}

async function fetchState() {
  const response = await chrome.runtime.sendMessage({ type: 'fingertips:getState' });
  if (response?.state) {
    currentState = response.state;
  }
}

async function fetchDeleteEndpointStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'fingertips:getDeleteEndpoint' });
  if (response?.details) {
    setStatus('Delete endpoint captured. Subsequent deletes will be direct.');
  } else {
    setStatus('Delete endpoint not captured yet. First delete will use the UI flow.');
  }
}

function renderState() {
  if (!currentState) {
    return;
  }

  activationToggle.checked = Boolean(currentState.isActive);

  mappingsContainer.innerHTML = '';
  for (const gesture of GESTURE_NAMES) {
    if (gesture === 'None') {
      continue;
    }

    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector('.gesture').textContent = gesture.replace('_', ' ');

    const select = row.querySelector('select');
    Object.values(ACTIONS).forEach((action) => {
      const option = document.createElement('option');
      option.value = action;
      option.textContent = ACTION_LABELS[action];
      if (currentState.gestureMap?.[gesture] === action) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    select.addEventListener('change', () => {
      updateState({
        gestureMap: {
          ...currentState.gestureMap,
          [gesture]: select.value
        }
      });
    });

    mappingsContainer.appendChild(row);
  }
}

async function updateState(partialState) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'fingertips:updateState',
      partialState
    });
    if (response?.state) {
      currentState = response.state;
    }
  } catch (err) {
    console.error('Fingertips popup failed to update state', err);
    setStatus('Failed to update settings');
  }
}

async function init() {
  try {
    await fetchState();
    renderState();
    await fetchDeleteEndpointStatus();
  } catch (err) {
    console.error('Fingertips popup init failed', err);
    setStatus('Unable to load state', true);
  }
}

activationToggle.addEventListener('change', async () => {
  const isActive = activationToggle.checked;
  await updateState({ isActive });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs?.length) {
      return;
    }
    chrome.tabs.sendMessage(
      tabs[0].id,
      { type: 'fingertips:activationChanged', isActive },
      () => chrome.runtime.lastError
    );
  });
});

requestCameraButton.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs?.length) {
      setStatus('Open your iCloud Photos tab first.', true);
      return;
    }

    chrome.tabs.sendMessage(
      tabs[0].id,
      { type: 'fingertips:requestCamera' },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.error('Camera request dispatch failed', err);
          setStatus('Unable to reach the tab. Make sure iCloud Photos is open.', true);
          return;
        }

        if (response?.ok) {
          setStatus('Camera access granted. Gestures ready.');
        } else {
          const errorMsg = response?.error ?? 'Unknown error';
          const normalizedError = typeof errorMsg === 'string'
            ? errorMsg
            : JSON.stringify(errorMsg, Object.getOwnPropertyNames(errorMsg));
          const message = `Camera access denied: ${normalizedError}`;
          console.error('Camera request failed', {
            response,
            error: errorMsg,
            errorType: typeof errorMsg
          });
          setStatus(message, true);
        }
      }
    );
  });
});

restoreButton.addEventListener('click', async () => {
  await updateState({ gestureMap: { ...DEFAULT_GESTURE_MAP } });
  await fetchState();
  renderState();
  setStatus('Defaults restored.');
});

init();
