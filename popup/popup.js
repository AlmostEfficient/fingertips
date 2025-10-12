import {
  ACTION_LABELS,
  ACTION_ORDER,
  DEFAULT_ACTION_BINDINGS,
  GESTURE_NAMES,
  HAND_LABELS,
  HAND_OPTIONS
} from '../shared/constants.js';

let currentState = null;

const statusEl = document.getElementById('status');
const mappingsContainer = document.getElementById('mappings');
const activationToggle = document.getElementById('activation-toggle');
const requestCameraButton = document.getElementById('request-camera');
const startEngineButton = document.getElementById('start-engine');
const stopEngineButton = document.getElementById('stop-engine');
const grantCameraButton = document.getElementById('grant-camera');
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
    if (!currentState.actionBindings) {
      currentState.actionBindings = cloneDefaultBindings();
    }
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
  for (const action of ACTION_ORDER) {
    const binding = currentState.actionBindings?.[action] || DEFAULT_ACTION_BINDINGS[action];
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector('.action-label').textContent = ACTION_LABELS[action];

    const gestureSelect = row.querySelector('.gesture-select');
    GESTURE_NAMES.forEach((gestureName) => {
      const option = document.createElement('option');
      option.value = gestureName;
      option.textContent = gestureName.replace(/_/g, ' ');
      if (binding?.gesture === gestureName) {
        option.selected = true;
      }
      gestureSelect.appendChild(option);
    });

    const handSelect = row.querySelector('.hand-select');
    Object.values(HAND_OPTIONS).forEach((handOption) => {
      const option = document.createElement('option');
      option.value = handOption;
      option.textContent = HAND_LABELS[handOption];
      if ((binding?.hand || HAND_OPTIONS.ANY) === handOption) {
        option.selected = true;
      }
      handSelect.appendChild(option);
    });

    const updateHandState = () => {
      const disabled = gestureSelect.value === 'None';
      handSelect.disabled = disabled;
      if (disabled) {
        handSelect.value = HAND_OPTIONS.ANY;
      }
    };

    updateHandState();

    gestureSelect.addEventListener('change', () => {
      updateHandState();
      persistBinding(action, {
        gesture: gestureSelect.value,
        hand: handSelect.value
      });
    });

    handSelect.addEventListener('change', () => {
      persistBinding(action, {
        gesture: gestureSelect.value,
        hand: handSelect.value
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

function persistBinding(action, binding) {
  if (!currentState) {
    return;
  }

  const gesture = binding.gesture;
  const hand = gesture === 'None' ? HAND_OPTIONS.ANY : binding.hand;

  const nextBinding = {
    gesture,
    hand
  };

  currentState.actionBindings = {
    ...(currentState.actionBindings || {}),
    [action]: nextBinding
  };

  updateState({
    actionBindings: {
      ...currentState.actionBindings,
      [action]: nextBinding
    }
  });
}

function cloneDefaultBindings() {
  const bindings = {};
  for (const action of ACTION_ORDER) {
    bindings[action] = { ...DEFAULT_ACTION_BINDINGS[action] };
  }
  return bindings;
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
          setStatus('Camera access granted. Preview running.');
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

startEngineButton.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs?.length) {
      setStatus('Open your iCloud Photos tab first.', true);
      return;
    }

    chrome.tabs.sendMessage(
      tabs[0].id,
      { type: 'fingertips:startGestureEngine' },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.error('Gesture engine start dispatch failed', err);
          setStatus('Unable to reach the tab. Make sure iCloud Photos is open.', true);
          return;
        }

        if (response?.ok) {
          setStatus('Gesture engine started.');
        } else {
          const errorMsg = response?.error ?? 'Unknown error';
          const normalizedError = typeof errorMsg === 'string'
            ? errorMsg
            : JSON.stringify(errorMsg, Object.getOwnPropertyNames(errorMsg));
          setStatus(`Gesture engine failed to start: ${normalizedError}`, true);
        }
      }
    );
  });
});

stopEngineButton.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs?.length) {
      setStatus('Open your iCloud Photos tab first.', true);
      return;
    }

    chrome.tabs.sendMessage(
      tabs[0].id,
      { type: 'fingertips:stopGestureEngine' },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.error('Gesture engine stop dispatch failed', err);
          setStatus('Unable to reach the tab. Make sure iCloud Photos is open.', true);
          return;
        }

        setStatus('Gesture engine stop requested.');
      }
    );
  });
});

grantCameraButton.addEventListener('click', () => {
  setStatus('Opening camera permission window…');
  chrome.runtime.sendMessage({ type: 'fingertips:requestCameraConsent' }, (response) => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.error('Camera consent request failed', err);
      setStatus('Unable to request camera permission.', true);
      return;
    }

    if (response?.ok) {
      setStatus('Camera permission granted. Warming up gesture engine…');
      warmupGestureEngine();
    } else {
      const errorMsg = response?.error ?? 'Unknown error';
      const normalizedError = typeof errorMsg === 'string'
        ? errorMsg
        : JSON.stringify(errorMsg, Object.getOwnPropertyNames(errorMsg));
      setStatus(`Camera permission failed: ${normalizedError}`, true);
    }
  });
});

function warmupGestureEngine() {
  chrome.runtime.sendMessage({ type: 'fingertips:requestCamera' }, (response) => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.error('Gesture engine warmup request failed', err);
      setStatus('Gesture engine unreachable. Reload the extension.', true);
      return;
    }

    if (response?.ok) {
      setStatus('Gesture engine warmed up.');
    } else {
      const errorMsg = response?.error ?? 'Unknown error';
      const normalizedError = typeof errorMsg === 'string'
        ? errorMsg
        : JSON.stringify(errorMsg, Object.getOwnPropertyNames(errorMsg));
      const message = `Gesture engine warmup failed: ${normalizedError}`;
      console.error('Gesture engine warmup failed', {
        response,
        error: errorMsg,
        errorType: typeof errorMsg
      });
      setStatus(message, true);
    }
  });
}

restoreButton.addEventListener('click', async () => {
  await updateState({ actionBindings: cloneDefaultBindings() });
  await fetchState();
  renderState();
  setStatus('Defaults restored.');
});

init();
