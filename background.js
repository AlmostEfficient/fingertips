import { STATE_STORAGE_KEY } from './shared/constants.js';
import {
  getExtensionState,
  setExtensionState,
  getDeleteEndpoint,
  setDeleteEndpoint
} from './shared/storage.js';

const CAPTURE_URL_PATTERN = /\/records\/modify/;
const ACTIVE_GESTURE_TABS = new Set();
const PENDING_CAMERA_REQUESTS = new Map();
let pendingConsentRequest = null;
const CONSENT_PAGE_URL = chrome.runtime.getURL('consent/consent.html');
let offscreenReady = false;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error('Offscreen documents are unavailable in this browser.');
  }

  const hasDocument = await chrome.offscreen.hasDocument();
  if (!hasDocument) {
    offscreenReady = false;
    await chrome.offscreen.createDocument({
      url: 'offscreen/gesture.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture webcam input for gesture recognition.'
    });
  }
}

async function closeOffscreenDocumentIfIdle() {
  if (!chrome.offscreen) {
    return;
  }

  if (ACTIVE_GESTURE_TABS.size > 0 || PENDING_CAMERA_REQUESTS.size > 0) {
    return;
  }

  const hasDocument = await chrome.offscreen.hasDocument();
  if (hasDocument) {
    await chrome.offscreen.closeDocument();
    offscreenReady = false;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (ACTIVE_GESTURE_TABS.delete(tabId)) {
    if (ACTIVE_GESTURE_TABS.size === 0) {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen:stop' });
      closeOffscreenDocumentIfIdle().catch(() => {});
    }
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (pendingConsentRequest?.windowId === windowId) {
    const { sendResponse } = pendingConsentRequest;
    pendingConsentRequest = null;
    try {
      sendResponse?.({ ok: false, error: 'Camera permission dismissed.' });
    } catch (err) {
      console.warn('Fingertips: failed to notify about dismissed camera consent', err);
    }
  }
});

function cloneState(state) {
  return {
    ...state,
    gestureMap: { ...state.gestureMap }
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STATE_STORAGE_KEY);
  if (!stored[STATE_STORAGE_KEY]) {
    const initialState = cloneState(await getExtensionState());
    await chrome.storage.local.set({ [STATE_STORAGE_KEY]: initialState });
  }
});

function decodeRequestBody(requestBody) {
  if (!requestBody) {
    return null;
  }

  if (requestBody.raw && requestBody.raw.length) {
    const decoder = new TextDecoder('utf-8');
    return requestBody.raw
      .map((item) => decoder.decode(item.bytes ? item.bytes : item))
      .join('');
  }

  if (requestBody.formData) {
    try {
      return JSON.stringify(requestBody.formData);
    } catch (err) {
      console.warn('Fingertips: failed to stringify formData request body', err);
    }
  }

  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    try {
      if (details.method !== 'POST' || !CAPTURE_URL_PATTERN.test(details.url)) {
        return;
      }

      const decodedBody = decodeRequestBody(details.requestBody);
      if (!decodedBody) {
        return;
      }

      const payload = JSON.parse(decodedBody);
      const operations = payload?.operations;
      if (!Array.isArray(operations) || operations.length === 0) {
        return;
      }

      const op = operations[0];
      const record = op?.record;
      if (!record?.fields?.isDeleted || record.fields.isDeleted.value !== 1) {
        return;
      }

      const captureDetails = {
        url: details.url,
        method: details.method,
        timestamp: Date.now(),
        payloadTemplate: {
          atomic: Boolean(payload.atomic),
          zoneID: payload.zoneID,
          recordType: record.recordType,
          fields: record.fields
        }
      };

      await setDeleteEndpoint(captureDetails);
      console.info('Fingertips: captured delete endpoint template');
    } catch (err) {
      console.error('Fingertips: failed to capture delete endpoint', err);
    }
  },
  { urls: ['*://*.icloud.com/*'] },
  ['requestBody']
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'fingertips:getState':
      getExtensionState()
        .then((state) => sendResponse({ state }))
        .catch((err) => {
          console.error('Fingertips: failed to get state', err);
          sendResponse({ error: 'STATE_UNAVAILABLE' });
        });
      return true;
    case 'fingertips:updateState':
      setExtensionState(message.partialState)
        .then((state) => sendResponse({ state }))
        .catch((err) => {
          console.error('Fingertips: failed to update state', err);
          sendResponse({ error: 'STATE_UPDATE_FAILED' });
        });
      return true;
    case 'fingertips:getDeleteEndpoint':
      getDeleteEndpoint()
        .then((details) => sendResponse({ details }))
        .catch((err) => {
          console.error('Fingertips: failed to get delete endpoint', err);
          sendResponse({ error: 'DELETE_ENDPOINT_UNAVAILABLE' });
        });
      return true;
    case 'fingertips:performDelete':
      performDelete(message.record)
        .then((result) => sendResponse(result))
        .catch((err) => {
          console.error('Fingertips: delete call failed', err);
          sendResponse({ error: 'DELETE_CALL_FAILED', details: String(err) });
        });
      return true;
    case 'fingertips:startRecognition':
      handleStartRecognition(sender, sendResponse);
      return true;
    case 'fingertips:stopRecognition':
      handleStopRecognition(sender);
      sendResponse?.({ ok: true });
      return false;
    case 'fingertips:requestCamera':
      handleCameraRequest(sendResponse).catch((err) => {
        console.error('Fingertips: camera warmup failed', err);
        sendResponse?.({ ok: false, error: err?.message || String(err) });
      });
      return true;
    case 'fingertips:requestCameraConsent':
      handleCameraConsentRequest(sendResponse).catch((err) => {
        console.error('Fingertips: camera consent window failed', err);
        sendResponse?.({ ok: false, error: err?.message || String(err) });
      });
      return true;
    case 'fingertips:consentResult':
      resolveCameraConsent(message.payload || { ok: false, error: 'UNKNOWN' });
      break;
    case 'offscreen:ready':
      offscreenReady = true;
      break;
    case 'offscreen:gesture':
      dispatchGestureToTabs(message.payload);
      break;
    case 'offscreen:error':
      notifyTabsOfError(message.payload);
      break;
    case 'offscreen:cameraResult':
      resolveCameraRequest(message.requestId, message.payload);
      break;
    case 'offscreen:status':
      break;
    default:
      break;
  }

  return false;
});

async function handleStartRecognition(sender, sendResponse) {
  try {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse?.({ ok: false, error: 'TAB_ID_UNAVAILABLE' });
      return;
    }

    ACTIVE_GESTURE_TABS.add(tabId);

    await ensureOffscreenDocument();
    await waitForOffscreenReady();

    try {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen:start' });
    } catch (err) {
      console.warn('Failed to send start message to offscreen:', err);
    }
    sendResponse?.({ ok: true });
  } catch (err) {
    console.error('Fingertips: failed to start offscreen recognizer', err);
    const tabId = sender?.tab?.id;
    if (typeof tabId === 'number') {
      ACTIVE_GESTURE_TABS.delete(tabId);
    }
    sendResponse?.({ ok: false, error: err?.message || String(err) });
    closeOffscreenDocumentIfIdle().catch(() => {});
  }
}

function handleStopRecognition(sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId === 'number') {
    ACTIVE_GESTURE_TABS.delete(tabId);
  }

  if (ACTIVE_GESTURE_TABS.size === 0) {
    try {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen:stop' });
    } catch (err) {
      console.warn('Failed to send stop message to offscreen:', err);
    }
    closeOffscreenDocumentIfIdle().catch((err) => {
      console.warn('Fingertips: failed closing offscreen document', err);
    });
  }
}

async function handleCameraRequest(sendResponse) {
  await ensureOffscreenDocument();
  await waitForOffscreenReady();

  const requestId = `camera-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  PENDING_CAMERA_REQUESTS.set(requestId, sendResponse);
  console.info('Fingertips: camera warmup request sent', { requestId });
  try {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'offscreen:warmup',
      requestId
    });
  } catch (err) {
    PENDING_CAMERA_REQUESTS.delete(requestId);
    console.warn('Failed to send warmup message to offscreen:', err);
    throw err;
  }
}

function resolveCameraRequest(requestId, payload) {
  if (!requestId) {
    return;
  }
  const callback = PENDING_CAMERA_REQUESTS.get(requestId);
  if (!callback) {
    return;
  }
  PENDING_CAMERA_REQUESTS.delete(requestId);
  console.info('Fingertips: camera warmup result', { requestId, payload });
  callback(payload || { ok: false, error: 'UNKNOWN' });
  closeOffscreenDocumentIfIdle().catch(() => {});
}

async function handleCameraConsentRequest(sendResponse) {
  if (pendingConsentRequest) {
    sendResponse?.({ ok: false, error: 'Camera permission prompt already open.' });
    return;
  }

  const window = await chrome.windows.create({
    url: CONSENT_PAGE_URL,
    type: 'popup',
    width: 420,
    height: 520,
    focused: true
  });

  pendingConsentRequest = {
    sendResponse,
    windowId: window?.id || null
  };
}

async function resolveCameraConsent(payload) {
  if (!pendingConsentRequest) {
    return;
  }

  const { sendResponse, windowId } = pendingConsentRequest;
  pendingConsentRequest = null;

  if (windowId) {
    try {
      await chrome.windows.remove(windowId);
    } catch (err) {
      console.warn('Fingertips: failed to close camera consent window', err);
    }
  }

  try {
    sendResponse?.(payload);
  } catch (err) {
    console.warn('Fingertips: failed to respond to camera consent request', err);
  }
}

function dispatchGestureToTabs(payload) {
  if (!payload?.gesture || ACTIVE_GESTURE_TABS.size === 0) {
    return;
  }

  for (const tabId of [...ACTIVE_GESTURE_TABS]) {
    chrome.tabs.sendMessage(tabId, { type: 'fingertips:gesture', payload }, () => {
      if (chrome.runtime.lastError) {
        ACTIVE_GESTURE_TABS.delete(tabId);
        closeOffscreenDocumentIfIdle().catch(() => {});
      }
    });
  }
}

function notifyTabsOfError(payload) {
  if (ACTIVE_GESTURE_TABS.size === 0) {
    return;
  }
  for (const tabId of ACTIVE_GESTURE_TABS) {
    chrome.tabs.sendMessage(tabId, { type: 'fingertips:gestureError', payload }, () => undefined);
  }
}

function waitForOffscreenReady(timeoutMs = 4000) {
  if (offscreenReady) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (offscreenReady) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('Offscreen gesture document did not become ready in time.'));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

async function performDelete(recordPayload) {
  const endpointDetails = await getDeleteEndpoint();
  if (!endpointDetails) {
    return { error: 'NO_ENDPOINT_CAPTURED' };
  }

  if (!recordPayload?.recordName || !recordPayload?.recordChangeTag) {
    return { error: 'MISSING_RECORD_DATA' };
  }

  const body = {
    atomic: endpointDetails.payloadTemplate.atomic,
    operations: [
      {
        operationType: 'update',
        record: {
          recordName: recordPayload.recordName,
          recordChangeTag: recordPayload.recordChangeTag,
          recordType: endpointDetails.payloadTemplate.recordType,
          fields: {
            ...endpointDetails.payloadTemplate.fields,
            isDeleted: { value: 1 }
          }
        }
      }
    ],
    zoneID: endpointDetails.payloadTemplate.zoneID
  };

  const response = await fetch(endpointDetails.url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      Origin: 'https://www.icloud.com',
      Referer: 'https://www.icloud.com/'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Delete API responded with ${response.status}: ${text}`);
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    json = null;
  }

  return {
    ok: true,
    status: response.status,
    data: json
  };
}
