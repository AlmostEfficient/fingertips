import {
  ACTION_ORDER,
  DEFAULT_ACTION_BINDINGS,
  DEFAULT_STATE,
  STATE_STORAGE_KEY,
  DELETE_ENDPOINT_KEY,
  HAND_OPTIONS
} from './constants.js';

function deepClone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function sanitizeBinding(binding, fallback) {
  const base = fallback || { gesture: 'None', hand: HAND_OPTIONS.ANY };
  if (!binding || typeof binding !== 'object') {
    return { ...base };
  }
  const gesture = typeof binding.gesture === 'string' ? binding.gesture : base.gesture;
  const defaultHand = gesture === 'None' ? HAND_OPTIONS.ANY : base.hand;
  const providedHandRaw = typeof binding.hand === 'string' ? binding.hand.toLowerCase() : defaultHand;
  const providedHand = providedHandRaw === HAND_OPTIONS.LEFT || providedHandRaw === HAND_OPTIONS.RIGHT
    ? providedHandRaw
    : HAND_OPTIONS.ANY;
  const hand = gesture === 'None' ? HAND_OPTIONS.ANY : providedHand;
  return { gesture, hand };
}

function migrateGestureMap(oldGestureMap = {}) {
  const migrated = {};
  for (const action of ACTION_ORDER) {
    migrated[action] = { ...DEFAULT_ACTION_BINDINGS[action] };
  }

  const entries = Object.entries(oldGestureMap || {});
  for (const [gesture, action] of entries) {
    if (!gesture || action == null) {
      continue;
    }
    const match = ACTION_ORDER.includes(action) ? action : null;
    if (!match) {
      continue;
    }
    migrated[match] = { gesture, hand: HAND_OPTIONS.ANY };
  }

  return migrated;
}

function sanitizeActionBindings(rawBindings, fallbackBindings = DEFAULT_ACTION_BINDINGS) {
  const safeBindings = {};
  const source = rawBindings && typeof rawBindings === 'object' ? rawBindings : {};
  for (const action of ACTION_ORDER) {
    const fallback = fallbackBindings[action] || DEFAULT_ACTION_BINDINGS[action];
    const binding = sanitizeBinding(source[action], fallback);
    safeBindings[action] = binding;
  }
  return safeBindings;
}

export async function getExtensionState() {
  const stored = await chrome.storage.local.get(STATE_STORAGE_KEY);
  const rawState = stored[STATE_STORAGE_KEY];
  if (!rawState) {
    return deepClone(DEFAULT_STATE);
  }

  const base = {
    ...deepClone(DEFAULT_STATE),
    ...rawState
  };

  if (rawState.gestureMap && !rawState.actionBindings) {
    base.actionBindings = sanitizeActionBindings(migrateGestureMap(rawState.gestureMap));
  } else {
    base.actionBindings = sanitizeActionBindings(rawState.actionBindings);
  }

  delete base.gestureMap;

  if (typeof base.repeatDelayMs !== 'number' || base.repeatDelayMs <= 0 || base.repeatDelayMs === 700) {
    base.repeatDelayMs = DEFAULT_STATE.repeatDelayMs;
  }
  if (typeof base.repeatIntervalMs !== 'number' || base.repeatIntervalMs <= 0 || base.repeatIntervalMs === 650) {
    base.repeatIntervalMs = DEFAULT_STATE.repeatIntervalMs;
  }

  return base;
}

export async function setExtensionState(partialState) {
  const current = await getExtensionState();
  const desiredBindings = partialState?.actionBindings || null;
  const nextState = {
    ...current,
    ...partialState,
    actionBindings: sanitizeActionBindings(desiredBindings, current.actionBindings)
  };
  await chrome.storage.local.set({ [STATE_STORAGE_KEY]: nextState });
  return nextState;
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
