import { US_MAX, US_MID, US_MIN, usToCrsf } from "./crsf";

export type Sticks = {
  roll: number;
  pitch: number;
  yaw: number;
  throttle: number;
};

export type Inverts = {
  roll: boolean;
  pitch: boolean;
  yaw: boolean;
  throttle: boolean;
};

export type SwitchPosition = -1 | 0 | 1;

export const DEFAULT_STICKS: Sticks = {
  roll: 0,
  pitch: 0,
  yaw: 0,
  throttle: 0,
};

export const DEFAULT_INVERTS: Inverts = {
  roll: false,
  pitch: false,
  yaw: false,
  throttle: false,
};

export type Outputs = {
  microseconds: number[];
  crsf: number[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function axisUs(value: number, invert: boolean): number {
  if (!Number.isFinite(value)) return US_MID;
  const signed = invert ? -value : value;
  return Math.round(US_MID + clamp(signed, -1, 1) * (US_MAX - US_MID));
}

export function throttleUs(value: number, invert: boolean): number {
  if (!Number.isFinite(value)) return US_MIN;
  const travel = invert ? 1 - value : value;
  return Math.round(US_MIN + clamp(travel, 0, 1) * (US_MAX - US_MIN));
}

export function switchUs(position: SwitchPosition): number {
  if (position < 0) return US_MIN;
  if (position > 0) return US_MAX;
  return US_MID;
}

/** AETR channel order. Channel 5 is the arm switch ExpressLRS watches. */
export function buildOutputs(
  sticks: Sticks,
  switches: readonly [SwitchPosition, SwitchPosition, SwitchPosition],
  armed: boolean,
  inverts: Inverts,
): Outputs {
  const microseconds = new Array<number>(16).fill(US_MID);
  microseconds[0] = axisUs(sticks.roll, inverts.roll);
  microseconds[1] = axisUs(sticks.pitch, inverts.pitch);
  microseconds[2] = throttleUs(sticks.throttle, inverts.throttle);
  microseconds[3] = axisUs(sticks.yaw, inverts.yaw);
  microseconds[4] = armed ? US_MAX : US_MIN;
  microseconds[5] = switchUs(switches[0]);
  microseconds[6] = switchUs(switches[1]);
  microseconds[7] = switchUs(switches[2]);
  return {
    microseconds,
    crsf: microseconds.map((us) => usToCrsf(us)),
  };
}

const GAMEPAD_DEADZONE = 0.08;

function deadzone(value: number): number {
  return Math.abs(value) < GAMEPAD_DEADZONE ? 0 : value;
}

/** Mode 2 from a standard gamepad. Left stick Y rests at half throttle. */
export function sticksFromGamepad(gamepad: Gamepad): Sticks | null {
  if (!gamepad.connected || gamepad.axes.length < 4 ||
      gamepad.axes.slice(0, 4).some((axis) => !Number.isFinite(axis))) return null;
  const leftX = deadzone(gamepad.axes[0] ?? 0);
  const leftY = deadzone(gamepad.axes[1] ?? 0);
  const rightX = deadzone(gamepad.axes[2] ?? 0);
  const rightY = deadzone(gamepad.axes[3] ?? 0);
  return {
    yaw: clamp(leftX, -1, 1),
    throttle: clamp((1 - leftY) / 2, 0, 1),
    roll: clamp(rightX, -1, 1),
    pitch: clamp(-rightY, -1, 1),
  };
}

/** Neutral axes and low output throttle, including when throttle is reversed. */
export function safeSticks(inverts: Inverts): Sticks {
  return { roll: 0, pitch: 0, yaw: 0, throttle: inverts.throttle ? 1 : 0 };
}

/** Force low throttle/arm while retaining the caller's auxiliary channels. */
export function safeChannels(channels: readonly number[]): number[] {
  const safe = [...channels];
  safe[2] = usToCrsf(US_MIN);
  safe[4] = usToCrsf(US_MIN);
  return safe;
}
