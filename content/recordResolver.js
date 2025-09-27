import { VIEW_MODES, detectViewMode } from './modeManager.js';
import { showToast } from './overlay.js';

const FIBER_PREFIX = '__reactFiber$';
const PROP_PREFIX = '__reactProps$';
const MAX_DEPTH = 5;

export function getActiveRecord() {
  const mode = detectViewMode();
  if (mode === VIEW_MODES.ONE_UP) {
    const target = document.querySelector('.OneUpCarouselItem.is-center, .OneUpCarouselItem.is-onscreen');
    if (target) {
      return extractRecordFromElement(target) || extractFromLocationHash();
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
      return record;
    }
  }
  return null;
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

export function ensureRecordHasChangeTag(record) {
  if (record && record.recordName && record.recordChangeTag) {
    return record;
  }
  if (record && record.recordName) {
    showToast('Missing change tag for asset. Delete will fallback to UI flow.', { tone: 'error', duration: 2200 });
  }
  return null;
}
