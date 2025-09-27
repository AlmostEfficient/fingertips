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
  NONE: 'none',
  NEXT: 'nextPhoto',
  PREVIOUS: 'previousPhoto',
  DELETE: 'deletePhoto'
};

export const ACTION_LABELS = {
  [ACTIONS.NONE]: 'Do nothing',
  [ACTIONS.NEXT]: 'Next photo',
  [ACTIONS.PREVIOUS]: 'Previous photo',
  [ACTIONS.DELETE]: 'Delete photo'
};

export const DEFAULT_GESTURE_MAP = {
  None: ACTIONS.NONE,
  Open_Palm: ACTIONS.NEXT,
  Closed_Fist: ACTIONS.PREVIOUS,
  Pointing_Up: ACTIONS.NONE,
  Thumb_Down: ACTIONS.DELETE,
  Thumb_Up: ACTIONS.NONE,
  Victory: ACTIONS.NONE,
  ILoveYou: ACTIONS.NONE
};

export const STATE_STORAGE_KEY = 'fingertips.state';
export const DELETE_ENDPOINT_KEY = 'fingertips.deleteEndpoint';

export const DEFAULT_STATE = {
  isActive: false,
  repeatDelayMs: 700,
  repeatIntervalMs: 650,
  gestureMap: DEFAULT_GESTURE_MAP
};
