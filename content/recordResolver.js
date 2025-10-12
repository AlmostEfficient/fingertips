import { VIEW_MODES, detectViewMode } from './modeManager.js';
import { showToast } from './overlay.js';

const FIBER_PREFIX = '__reactFiber$';
const PROP_PREFIX = '__reactProps$';
const MAX_DEPTH = 5;
const METADATA_FAILURE_COOLDOWN_MS = 2500;
const CLOUDKIT_LOOKUP_HEADERS = {
  'Content-Type': 'text/plain;charset=UTF-8'
};

const metadataCache = new Map();
const pendingLookups = new Map();
let lastMetadataErrorAt = 0;
let cachedEndpointDetails = null;
let cachedEndpointTimestamp = 0;
const ENDPOINT_CACHE_TTL_MS = 8000;

export function getActiveRecord() {
  const mode = detectViewMode();
  if (mode === VIEW_MODES.ONE_UP) {
    // Try multiple selectors for different OneUp DOM structures
    const selectors = [
      '.OneUpCarouselItem.is-center, .OneUpCarouselItem.is-onscreen',
      '.OneUp-itemWrapper',
      '.ProgressiveImageElement'
    ];
    
    let target = null;
    for (const selector of selectors) {
      target = document.querySelector(selector);
      if (target) break;
    }
    
    if (target) {
      return extractRecordFromElement(target) || extractFromDomAttributes(target) || extractFromLocationHash();
    }
    return extractFromLocationHash();
  }

  if (mode === VIEW_MODES.GRID) {
    const selected = document.querySelector('.PhotoItemView.is-selected');
    if (selected) {
      return (
        extractRecordFromElement(selected) ||
        extractFromNearestParent(selected) ||
        null
      );
    }

    const focused = document.querySelector('.PhotoItemView:focus-within, .PhotoItemView:focus');
    if (focused) {
      return extractRecordFromElement(focused);
    }
  }

  return extractFromLocationHash();
}

function extractFromLocationHash() {
  const hash = window.location.hash || '';
  const match = hash.match(/#\/i,[^,]*,([^,]+),/);
  if (!match) {
    return null;
  }
  return {
    recordName: match[1],
    recordChangeTag: null
  };
}

function extractFromNearestParent(element) {
  if (!element) {
    return null;
  }
  let parent = element.parentElement;
  while (parent) {
    const record = extractRecordFromElement(parent);
    if (record) {
      return record;
    }
    parent = parent.parentElement;
  }
  return null;
}

function extractRecordFromElement(element) {
  if (!element) {
    return null;
  }

  const fiberKey = Object.keys(element).find((key) => key.startsWith(FIBER_PREFIX));
  const propKey = Object.keys(element).find((key) => key.startsWith(PROP_PREFIX));

  const candidates = [];
  if (fiberKey) {
    candidates.push(element[fiberKey]);
  }
  if (propKey) {
    candidates.push(element[propKey]);
  }

  for (const candidate of candidates) {
    const record = searchForRecord(candidate, 0);
    if (record) {
      memoizeRecordMetadata(record);
      return record;
    }
  }
  return null;
}

function extractFromDomAttributes(element) {
  if (!element) {
    return null;
  }

  const dataset = element.dataset || {};
  const recordName =
    dataset.recordName ||
    dataset.recordname ||
    dataset.assetRecordName ||
    element.getAttribute?.('data-record-name') ||
    element.getAttribute?.('data-asset-record-name') ||
    null;
  const recordChangeTag =
    dataset.recordChangeTag ||
    dataset.recordchangetag ||
    element.getAttribute?.('data-record-change-tag') ||
    null;

  if (!recordName) {
    return null;
  }

  const record = {
    recordName,
    recordChangeTag: recordChangeTag || null,
    recordType: dataset.recordType || element.getAttribute?.('data-record-type') || null
  };

  if (record.recordChangeTag) {
    memoizeRecordMetadata(record);
  }

  return record;
}

function searchForRecord(node, depth) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) {
    return null;
  }

  if (node.recordName && node.recordChangeTag) {
    return {
      recordName: node.recordName,
      recordChangeTag: node.recordChangeTag,
      recordType: node.recordType || 'CPLAsset'
    };
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const result = searchForRecord(item, depth + 1);
      if (result) {
        return result;
      }
    }
    return null;
  }

  if (node.memoizedProps || node.memoizedState) {
    const fromProps = searchForRecord(node.memoizedProps, depth + 1);
    if (fromProps) {
      return fromProps;
    }
    const fromState = searchForRecord(node.memoizedState, depth + 1);
    if (fromState) {
      return fromState;
    }
  }

  for (const value of Object.values(node)) {
    if (typeof value === 'object' && value !== null) {
      const result = searchForRecord(value, depth + 1);
      if (result) {
        return result;
      }
    }
  }
  return null;
}

function memoizeRecordMetadata(record) {
  if (!record || !record.recordName || !record.recordChangeTag) {
    return;
  }

  const existing = metadataCache.get(record.recordName) || {};
  metadataCache.set(record.recordName, {
    recordName: record.recordName,
    recordChangeTag: record.recordChangeTag,
    recordType: record.recordType || existing.recordType || null
  });
  console.debug('Fingertips metadata: cached change tag', {
    recordName: record.recordName
  });
}

function mergeRecord(baseRecord, metadata) {
  if (!baseRecord) {
    return null;
  }

  return {
    recordName: baseRecord.recordName,
    recordChangeTag: metadata?.recordChangeTag || baseRecord.recordChangeTag || null,
    recordType: metadata?.recordType || baseRecord.recordType || 'CPLAsset'
  };
}

export async function getDeleteEndpointDetails({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedEndpointDetails && now - cachedEndpointTimestamp < ENDPOINT_CACHE_TTL_MS) {
    return cachedEndpointDetails;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'fingertips:getDeleteEndpoint' });
    if (response?.details?.url && response.details.payloadTemplate) {
      cachedEndpointDetails = response.details;
      cachedEndpointTimestamp = response.details.timestamp || now;
      return cachedEndpointDetails;
    }
    if (response?.details) {
      cachedEndpointDetails = response.details;
      cachedEndpointTimestamp = response.details.timestamp || now;
    }
  } catch (err) {
    console.warn('Fingertips metadata: failed to fetch delete endpoint template', err);
  }

  return cachedEndpointDetails;
}

function deriveLookupUrl(modifyUrl) {
  if (!modifyUrl) {
    return null;
  }
  try {
    const url = new URL(modifyUrl);
    if (!url.pathname.includes('/records/modify')) {
      return null;
    }
    url.pathname = url.pathname.replace('/records/modify', '/records/lookup');
    return url.toString();
  } catch (err) {
    console.warn('Fingertips metadata: unable to derive lookup URL', err);
    return null;
  }
}

async function lookupRecordMetadata(recordName) {
  if (!recordName) {
    return null;
  }

  if (pendingLookups.has(recordName)) {
    return pendingLookups.get(recordName);
  }

  const cached = metadataCache.get(recordName);
  if (cached?.recordChangeTag) {
    return cached;
  }

  const promise = (async () => {
    try {
      const endpointDetails = await getDeleteEndpointDetails();
      if (!endpointDetails) {
        console.warn('Fingertips metadata: lookup skipped, no endpoint template available', {
          recordName
        });
        return null;
      }

      const lookupUrl = deriveLookupUrl(endpointDetails.url);
      if (!lookupUrl) {
        console.warn('Fingertips metadata: lookup skipped, unable to derive lookup URL', {
          recordName
        });
        return null;
      }

      const body = {
        zoneID: endpointDetails.payloadTemplate.zoneID,
        records: [
          {
            recordName
          }
        ]
      };

      console.debug('Fingertips metadata: requesting change tag via page fetch', {
        recordName,
        lookupUrl
      });

      const response = await window.fetch(lookupUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { ...CLOUDKIT_LOOKUP_HEADERS },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.warn('Fingertips metadata: lookup HTTP error', {
          recordName,
          status: response.status,
          body: text
        });
        return null;
      }

      let json;
      try {
        json = await response.json();
      } catch (err) {
        console.warn('Fingertips metadata: lookup response parse failed', {
          recordName,
          error: err
        });
        return null;
      }

      const records = Array.isArray(json?.records) ? json.records : [];
      const record = records.find((item) => item?.recordName === recordName) || records[0];
      if (!record?.recordChangeTag) {
        console.warn('Fingertips metadata: lookup returned without change tag', {
          recordName,
          response: json
        });
        return null;
      }

      const normalized = {
        recordName: record.recordName,
        recordChangeTag: record.recordChangeTag,
        recordType: record.recordType || endpointDetails.payloadTemplate.recordType || null
      };

      console.debug('Fingertips metadata: lookup succeeded', {
        recordName
      });

      metadataCache.set(recordName, normalized);
      return normalized;
    } catch (err) {
      console.warn('Fingertips metadata: lookup failed', err);
    }
    return null;
  })();

  pendingLookups.set(recordName, promise);
  try {
    return await promise;
  } finally {
    pendingLookups.delete(recordName);
  }
}

export async function ensureRecordHasChangeTag(record) {
  if (!record || !record.recordName) {
    return null;
  }

  if (record.recordChangeTag) {
    console.info('Fingertips metadata: using record-supplied change tag', {
      recordName: record.recordName,
      source: 'direct'
    });
    memoizeRecordMetadata(record);
    return record;
  }

  const cached = metadataCache.get(record.recordName);
  if (cached?.recordChangeTag) {
    console.info('Fingertips metadata: using cached change tag', {
      recordName: record.recordName
    });
    return mergeRecord(record, cached);
  }

  console.info('Fingertips metadata: attempting background lookup', {
    recordName: record.recordName
  });
  const resolved = await lookupRecordMetadata(record.recordName);
  if (resolved?.recordChangeTag) {
    console.info('Fingertips metadata: lookup resolved change tag', {
      recordName: record.recordName
    });
    memoizeRecordMetadata(resolved);
    return mergeRecord(record, resolved);
  }

  const now = Date.now();
  if (now - lastMetadataErrorAt > METADATA_FAILURE_COOLDOWN_MS) {
    lastMetadataErrorAt = now;
    showToast('Missing change tag for asset. Delete will fallback to UI flow.', {
      tone: 'error',
      duration: 2200
    });
  }
  console.warn('Fingertips metadata: lookup failed, falling back to UI', {
    recordName: record.recordName
  });

  return null;
}
