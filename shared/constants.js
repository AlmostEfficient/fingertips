export const GESTURE_NAMES = [
  'None',
  'Closed_Fist',
  'Open_Palm',
  'Pointing_Up',
  'Thumb_Down',
  'Thumb_Up',
  'Victory',
  'ILoveYou'
];

export const ACTIONS = {
  MOVE_UP: 'moveUp',
  MOVE_RIGHT: 'moveRight',
  MOVE_DOWN: 'moveDown',
  MOVE_LEFT: 'moveLeft',
  DELETE: 'deletePhoto',
  FAVORITE: 'favoritePhoto',
  ENTER: 'enterDetail',
  EXIT: 'exitDetail'
};

export const ACTION_ORDER = [
  ACTIONS.MOVE_UP,
  ACTIONS.MOVE_RIGHT,
  ACTIONS.MOVE_DOWN,
  ACTIONS.MOVE_LEFT,
  ACTIONS.DELETE,
  ACTIONS.FAVORITE,
  ACTIONS.ENTER,
  ACTIONS.EXIT
];

export const ACTION_LABELS = {
  [ACTIONS.MOVE_UP]: 'Up',
  [ACTIONS.MOVE_RIGHT]: 'Right',
  [ACTIONS.MOVE_DOWN]: 'Down',
  [ACTIONS.MOVE_LEFT]: 'Left',
  [ACTIONS.DELETE]: 'Delete',
  [ACTIONS.FAVORITE]: 'Favorite',
  [ACTIONS.ENTER]: 'Enter (open photo)',
  [ACTIONS.EXIT]: 'Exit (back to grid)'
};

export const HAND_OPTIONS = {
  ANY: 'any',
  LEFT: 'left',
  RIGHT: 'right'
};

export const HAND_LABELS = {
  [HAND_OPTIONS.ANY]: 'Any hand',
  [HAND_OPTIONS.LEFT]: 'Left hand only',
  [HAND_OPTIONS.RIGHT]: 'Right hand only'
};

export const DEFAULT_ACTION_BINDINGS = {
  [ACTIONS.MOVE_UP]: { gesture: 'Open_Palm', hand: HAND_OPTIONS.ANY },
  [ACTIONS.MOVE_RIGHT]: { gesture: 'Pointing_Up', hand: HAND_OPTIONS.RIGHT },
  [ACTIONS.MOVE_DOWN]: { gesture: 'Closed_Fist', hand: HAND_OPTIONS.ANY },
  [ACTIONS.MOVE_LEFT]: { gesture: 'Pointing_Up', hand: HAND_OPTIONS.LEFT },
  [ACTIONS.DELETE]: { gesture: 'Thumb_Down', hand: HAND_OPTIONS.ANY },
  [ACTIONS.FAVORITE]: { gesture: 'Thumb_Up', hand: HAND_OPTIONS.ANY },
  [ACTIONS.ENTER]: { gesture: 'Victory', hand: HAND_OPTIONS.ANY },
  [ACTIONS.EXIT]: { gesture: 'ILoveYou', hand: HAND_OPTIONS.ANY }
};

export const STATE_STORAGE_KEY = 'fingertips.state';
export const DELETE_ENDPOINT_KEY = 'fingertips.deleteEndpoint';

export const DEFAULT_STATE = {
  isActive: false,
  repeatDelayMs: 120,
  repeatIntervalMs: 120,
  actionBindings: Object.fromEntries(
    ACTION_ORDER.map((action) => [action, { ...DEFAULT_ACTION_BINDINGS[action] }])
  )
};
