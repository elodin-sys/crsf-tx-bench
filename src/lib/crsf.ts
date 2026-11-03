/** CRSF frames for an ExpressLRS handset port. */

export const CRSF_SYNC = 0xc8;
export const CRSF_ADDRESS_BROADCAST = 0x00;
export const CRSF_ADDRESS_RADIO = 0xea;
export const CRSF_ADDRESS_MODULE = 0xee;

export const CRSF_FRAMETYPE_GPS = 0x02;
export const CRSF_FRAMETYPE_BATTERY = 0x08;
export const CRSF_FRAMETYPE_LINK_STATISTICS = 0x14;
export const CRSF_FRAMETYPE_RC_CHANNELS = 0x16;
export const CRSF_FRAMETYPE_ATTITUDE = 0x1e;
export const CRSF_FRAMETYPE_FLIGHT_MODE = 0x21;
export const CRSF_FRAMETYPE_DEVICE_PING = 0x28;
export const CRSF_FRAMETYPE_DEVICE_INFO = 0x29;
export const CRSF_FRAMETYPE_COMMAND = 0x32;

export const CHANNEL_COUNT = 16;
export const CRSF_CHANNEL_MIN = 172;
export const CRSF_CHANNEL_MID = 992;
export const CRSF_CHANNEL_MAX = 1811;

/** EdgeTX 100% endpoints, in microseconds. */
export const US_MIN = 988;
export const US_MID = 1500;
export const US_MAX = 2012;

/** Baud rates the ExpressLRS handset UART will lock to. 400000 is the usual one. */
export const HANDSET_BAUDS = [115200, 400000, 921600, 1870000, 2250000] as const;
export const DEFAULT_BAUD = 400000;

const TX_POWER_MW = [0, 10, 25, 100, 500, 1000, 2000, 250, 50] as const;

export function crc8(data: Uint8Array, poly = 0xd5): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc =
        crc & 0x80 ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** Map a stick microsecond value into an 11-bit CRSF channel. */
export function usToCrsf(us: number): number {
  const clamped = Math.min(US_MAX, Math.max(US_MIN, us));
  const pulses = Math.round((clamped - US_MID) * 2);
  const value = CRSF_CHANNEL_MID + Math.trunc((pulses * 4) / 5);
  return Math.min(CRSF_CHANNEL_MAX, Math.max(CRSF_CHANNEL_MIN, value));
}

export function crsfToUs(value: number): number {
  const pulses = Math.round(((value - CRSF_CHANNEL_MID) * 5) / 4);
  return Math.round(US_MID + pulses / 2);
}

export function packChannels(values: readonly number[]): Uint8Array {
  if (values.length !== CHANNEL_COUNT) {
    throw new Error(`Expected ${CHANNEL_COUNT} channels`);
  }
  const payload = new Uint8Array(22);
  let bits = 0;
  let available = 0;
  let index = 0;
  for (const raw of values) {
    bits |= (raw & 0x7ff) << available;
    available += 11;
    while (available >= 8) {
      payload[index++] = bits & 0xff;
      bits >>>= 8;
      available -= 8;
    }
  }
  return payload;
}

export function unpackChannels(payload: Uint8Array): number[] {
  const channels: number[] = [];
  let bits = 0;
  let available = 0;
  let index = 0;
  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    while (available < 11) {
      bits |= (payload[index++] ?? 0) << available;
      available += 8;
    }
    channels.push(bits & 0x7ff);
    bits >>>= 11;
    available -= 11;
  }
  return channels;
}

export function buildFrame(
  type: number,
  payload: Uint8Array,
  sync = CRSF_ADDRESS_MODULE,
): Uint8Array {
  const frame = new Uint8Array(payload.length + 4);
  frame[0] = sync;
  frame[1] = payload.length + 2;
  frame[2] = type;
  frame.set(payload, 3);
  frame[frame.length - 1] = crc8(frame.subarray(2, frame.length - 1));
  return frame;
}

/** Classic 26-byte RC frame. Length 24 tells ExpressLRS to read arming from channel 5. */
export function buildRcFrame(channels: readonly number[]): Uint8Array {
  return buildFrame(CRSF_FRAMETYPE_RC_CHANNELS, packChannels(channels));
}

/** Extended command, sync 0xC8, same bytes EdgeTX sends for the model id. */
export function buildModelIdFrame(modelId: number): Uint8Array {
  const id = Math.max(0, Math.min(63, Math.round(modelId)));
  const body = new Uint8Array([
    CRSF_FRAMETYPE_COMMAND,
    CRSF_ADDRESS_MODULE,
    CRSF_ADDRESS_RADIO,
    0x10,
    0x05,
    id,
  ]);
  const payload = new Uint8Array(body.length);
  payload.set(body.subarray(1), 0);
  payload[payload.length - 1] = crc8(body, 0xba);
  return buildFrame(CRSF_FRAMETYPE_COMMAND, payload, CRSF_SYNC);
}

export function buildPingFrame(): Uint8Array {
  return buildFrame(
    CRSF_FRAMETYPE_DEVICE_PING,
    Uint8Array.of(CRSF_ADDRESS_BROADCAST, CRSF_ADDRESS_RADIO),
    CRSF_SYNC,
  );
}

export type ParsedFrame = {
  sync: number;
  type: number;
  payload: Uint8Array;
};

const SYNC_BYTES = new Set([
  CRSF_SYNC,
  CRSF_ADDRESS_RADIO,
  CRSF_ADDRESS_MODULE,
  0xec,
]);

export class CrsfParser {
  private readonly buffer = new Uint8Array(64);
  private state: "sync" | "length" | "body" = "sync";
  private expected = 0;
  private filled = 0;

  reset(): void {
    this.state = "sync";
    this.expected = 0;
    this.filled = 0;
  }

  push(chunk: Uint8Array, onFrame: (frame: ParsedFrame) => void): void {
    for (const byte of chunk) this.pushByte(byte, onFrame);
  }

  private pushByte(byte: number, onFrame: (frame: ParsedFrame) => void): void {
    if (this.state === "sync") {
      if (SYNC_BYTES.has(byte)) {
        this.buffer[0] = byte;
        this.state = "length";
      }
      return;
    }

    if (this.state === "length") {
      if (byte < 2 || byte > 62) {
        this.state = "sync";
        if (SYNC_BYTES.has(byte)) {
          this.buffer[0] = byte;
          this.state = "length";
        }
        return;
      }
      this.buffer[1] = byte;
      this.expected = byte;
      this.filled = 0;
      this.state = "body";
      return;
    }

    this.buffer[2 + this.filled] = byte;
    this.filled += 1;
    if (this.filled < this.expected) return;

    const total = this.expected + 2;
    const crc = crc8(this.buffer.subarray(2, total - 1));
    const ok = crc === this.buffer[total - 1];
    const sync = this.buffer[0] ?? 0;
    const type = this.buffer[2] ?? 0;
    const payload = this.buffer.slice(3, total - 1);
    this.state = "sync";
    if (ok) onFrame({ sync, type, payload });
  }
}

export type LinkStats = {
  uplinkRssiDbm: number;
  uplinkLq: number;
  uplinkSnr: number;
  downlinkRssiDbm: number;
  downlinkLq: number;
  downlinkSnr: number;
  txPowerMw: number | null;
  antenna: number;
  rfMode: number;
};

export type BatteryStats = {
  volts: number;
  amps: number;
  mah: number;
  remaining: number;
};

export type AttitudeStats = {
  pitch: number;
  roll: number;
  yaw: number;
};

export type GpsStats = {
  lat: number;
  lon: number;
  sats: number;
};

export type ModuleTelemetry = {
  link: LinkStats | null;
  battery: BatteryStats | null;
  attitude: AttitudeStats | null;
  flightMode: string | null;
  deviceName: string | null;
  gps: GpsStats | null;
  lastType: number | null;
  moduleFrames: number;
};

export function emptyTelemetry(): ModuleTelemetry {
  return {
    link: null,
    battery: null,
    attitude: null,
    flightMode: null,
    deviceName: null,
    gps: null,
    lastType: null,
    moduleFrames: 0,
  };
}

export function frameTypeName(type: number): string {
  switch (type) {
    case CRSF_FRAMETYPE_GPS:
      return "GPS";
    case CRSF_FRAMETYPE_BATTERY:
      return "Battery";
    case CRSF_FRAMETYPE_LINK_STATISTICS:
      return "Link statistics";
    case CRSF_FRAMETYPE_RC_CHANNELS:
      return "RC channels";
    case CRSF_FRAMETYPE_ATTITUDE:
      return "Attitude";
    case CRSF_FRAMETYPE_FLIGHT_MODE:
      return "Flight mode";
    case CRSF_FRAMETYPE_DEVICE_PING:
      return "Ping";
    case CRSF_FRAMETYPE_DEVICE_INFO:
      return "Device info";
    case CRSF_FRAMETYPE_COMMAND:
      return "Command";
    case 0x3a:
      return "Radio ID";
    default:
      return `Frame 0x${type.toString(16).padStart(2, "0")}`;
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    " ",
  );
}

function signed8(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}

function signed16(payload: Uint8Array, offset: number): number {
  const value = ((payload[offset] ?? 0) << 8) | (payload[offset + 1] ?? 0);
  return value > 32767 ? value - 65536 : value;
}

function unsigned16(payload: Uint8Array, offset: number): number {
  return ((payload[offset] ?? 0) << 8) | (payload[offset + 1] ?? 0);
}

function cString(payload: Uint8Array, start: number): string {
  let end = start;
  while (end < payload.length && payload[end] !== 0) end += 1;
  return new TextDecoder().decode(payload.subarray(start, end));
}

function radiansToDegrees(raw: number): number {
  return (raw / 10000) * (180 / Math.PI);
}

/** Fold one parsed frame into telemetry. RC frames are echoes of what we send. */
export function noteFrame(
  state: ModuleTelemetry,
  frame: ParsedFrame,
): ModuleTelemetry {
  if (frame.type === CRSF_FRAMETYPE_RC_CHANNELS) return state;
  const next: ModuleTelemetry = {
    ...state,
    lastType: frame.type,
    moduleFrames: state.moduleFrames + 1,
  };
  const { payload } = frame;

  if (frame.type === CRSF_FRAMETYPE_LINK_STATISTICS && payload.length >= 10) {
    const power = payload[6] ?? 0;
    next.link = {
      uplinkRssiDbm: -((payload[0] ?? 0) as number),
      uplinkLq: payload[2] ?? 0,
      uplinkSnr: signed8(payload[3] ?? 0),
      antenna: (payload[4] ?? 0) + 1,
      rfMode: payload[5] ?? 0,
      txPowerMw: power < TX_POWER_MW.length ? TX_POWER_MW[power] ?? null : null,
      downlinkRssiDbm: -((payload[7] ?? 0) as number),
      downlinkLq: payload[8] ?? 0,
      downlinkSnr: signed8(payload[9] ?? 0),
    };
  } else if (frame.type === CRSF_FRAMETYPE_BATTERY && payload.length >= 8) {
    const mah =
      ((payload[4] ?? 0) << 16) | ((payload[5] ?? 0) << 8) | (payload[6] ?? 0);
    next.battery = {
      volts: unsigned16(payload, 0) / 10,
      amps: unsigned16(payload, 2) / 10,
      mah,
      remaining: payload[7] ?? 0,
    };
  } else if (frame.type === CRSF_FRAMETYPE_ATTITUDE && payload.length >= 6) {
    next.attitude = {
      pitch: radiansToDegrees(signed16(payload, 0)),
      roll: radiansToDegrees(signed16(payload, 2)),
      yaw: radiansToDegrees(signed16(payload, 4)),
    };
  } else if (frame.type === CRSF_FRAMETYPE_FLIGHT_MODE) {
    const mode = cString(payload, 0).trim();
    next.flightMode = mode || null;
  } else if (frame.type === CRSF_FRAMETYPE_DEVICE_INFO && payload.length > 2) {
    const name = cString(payload, 2).trim();
    if (name) next.deviceName = name;
  } else if (frame.type === CRSF_FRAMETYPE_GPS && payload.length >= 15) {
    const lat = signed32(payload, 0) / 1e7;
    const lon = signed32(payload, 4) / 1e7;
    next.gps = { lat, lon, sats: payload[14] ?? 0 };
  }

  return next;
}

function signed32(payload: Uint8Array, offset: number): number {
  const value =
    ((payload[offset] ?? 0) << 24) |
    ((payload[offset + 1] ?? 0) << 16) |
    ((payload[offset + 2] ?? 0) << 8) |
    (payload[offset + 3] ?? 0);
  return value | 0;
}
