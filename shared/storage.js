import { DEFAULT_STATE, STATE_STORAGE_KEY, DELETE_ENDPOINT_KEY } from './constants.js';

function deepClone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export async function getExtensionState() {
  const stored = await chrome.storage.local.get(STATE_STORAGE_KEY);
  const rawState = stored[STATE_STORAGE_KEY];
  if (!rawState) {
    return deepClone(DEFAULT_STATE);
  }
  return {
    ...deepClone(DEFAULT_STATE),
    ...rawState,
    gestureMap: {
      ...DEFAULT_STATE.gestureMap,
      ...rawState.gestureMap
    }
  };
}

export async function setExtensionState(partialState) {
  const current = await getExtensionState();
  const nextState = {
    ...current,
    ...partialState,
    gestureMap: {
      ...current.gestureMap,
      ...(partialState?.gestureMap || {})
    }
  };
  await chrome.storage.local.set({ [STATE_STORAGE_KEY]: nextState });
  return nextState;
}

export function observeStateChanges(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STATE_STORAGE_KEY]) {
      return;
    }
    callback(changes[STATE_STORAGE_KEY].newValue, changes[STATE_STORAGE_KEY].oldValue);
  });
}

export async function getDeleteEndpoint() {
  const stored = await chrome.storage.local.get(DELETE_ENDPOINT_KEY);
  return stored[DELETE_ENDPOINT_KEY] || null;
}

export async function setDeleteEndpoint(details) {
  await chrome.storage.local.set({ [DELETE_ENDPOINT_KEY]: details });
}

export function observeDeleteEndpoint(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[DELETE_ENDPOINT_KEY]) {
      return;
    }
    callback(changes[DELETE_ENDPOINT_KEY].newValue, changes[DELETE_ENDPOINT_KEY].oldValue);
  });
}
