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

/** Supported USB handset rates, a subset of ExpressLRS's UART search list. */
export const HANDSET_BAUDS = [115200, 400000, 921600, 1870000, 2250000] as const;
/** Verified with the Nomad's CP2102 USB bridge on macOS. */
export const DEFAULT_BAUD = 115200;

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
  if (!Number.isFinite(us)) throw new RangeError("Channel value must be finite");
  const clamped = Math.min(US_MAX, Math.max(US_MIN, us));
  const pulses = Math.round((clamped - US_MID) * 2);
  const value = CRSF_CHANNEL_MID + Math.trunc((pulses * 4) / 5);
  return Math.min(CRSF_CHANNEL_MAX, Math.max(CRSF_CHANNEL_MIN, value));
}

export function crsfToUs(value: number): number {
  requireChannel(value);
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
    requireChannel(raw);
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
  if (payload.length !== 22) throw new RangeError("Expected a 22-byte channel payload");
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
  if (payload.length > 60) throw new RangeError("CRSF payload exceeds 60 bytes");
  requireByte(type);
  requireByte(sync);
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
  if (!Number.isFinite(modelId)) throw new RangeError("Model ID must be finite");
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

function requireByte(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError("Expected an unsigned byte");
  }
}

function requireChannel(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0x7ff) {
    throw new RangeError("Expected an unsigned 11-bit channel value");
  }
}

/**
 * Incremental parser with a bounded 64-byte window. A rejected candidate drops
 * only its first byte, preserving later frames swallowed by a corrupt length.
 * An incomplete candidate is retained until its declared length arrives: a
 * valid frame's payload may itself contain bytes that look like another frame.
 */
export class CrsfParser {
  private readonly buffer = new Uint8Array(64);
  private filled = 0;

  reset(): void {
    this.filled = 0;
  }

  push(chunk: Uint8Array, onFrame: (frame: ParsedFrame) => void): void {
    for (const byte of chunk) this.pushByte(byte, onFrame);
  }

  private pushByte(byte: number, onFrame: (frame: ParsedFrame) => void): void {
    this.buffer[this.filled++] = byte;
    while (this.filled > 0) {
      if (!SYNC_BYTES.has(this.buffer[0])) {
        this.discard(1);
        continue;
      }
      if (this.filled < 2) return;
      const length = this.buffer[1];
      if (length < 2 || length > 62) {
        this.discard(1);
        continue;
      }
      const total = length + 2;
      if (this.filled < total) return;
      if (crc8(this.buffer.subarray(2, total - 1)) !== this.buffer[total - 1]) {
        this.discard(1);
        continue;
      }
      const frame = {
        sync: this.buffer[0],
        type: this.buffer[2],
        payload: this.buffer.slice(3, total - 1),
      };
      this.discard(total);
      onFrame(frame);
    }
  }

  private discard(count: number): void {
    this.buffer.copyWithin(0, count, this.filled);
    this.filled -= count;
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

function cString(payload: Uint8Array, start: number): string | null {
  const end = payload.indexOf(0, start);
  return end < 0 ? null : new TextDecoder().decode(payload.subarray(start, end));
}

function radiansToDegrees(raw: number): number {
  return (raw / 10000) * (180 / Math.PI);
}

/** Fold an inbound frame into telemetry. Outbound echoes and malformed replies do not count. */
export function noteFrame(
  state: ModuleTelemetry,
  frame: ParsedFrame,
): ModuleTelemetry {
  if (
    frame.type === CRSF_FRAMETYPE_RC_CHANNELS ||
    frame.type === CRSF_FRAMETYPE_DEVICE_PING ||
    frame.type === CRSF_FRAMETYPE_COMMAND
  ) return state;
  const { payload } = frame;
  if (
    (frame.type === CRSF_FRAMETYPE_LINK_STATISTICS && payload.length < 10) ||
    (frame.type === CRSF_FRAMETYPE_BATTERY && payload.length < 8) ||
    (frame.type === CRSF_FRAMETYPE_ATTITUDE && payload.length < 6) ||
    (frame.type === CRSF_FRAMETYPE_GPS && payload.length < 15) ||
    (frame.type === CRSF_FRAMETYPE_FLIGHT_MODE && cString(payload, 0) === null)
  ) return state;
  if (frame.type === CRSF_FRAMETYPE_DEVICE_INFO) {
    // Extended header: destination, origin; name + NUL; 14 bytes of metadata.
    const end = payload.indexOf(0, 2);
    if (
      (payload[0] !== CRSF_ADDRESS_RADIO && payload[0] !== CRSF_ADDRESS_BROADCAST) ||
      end < 3 || payload.length < end + 15
    ) return state;
  }
  const next: ModuleTelemetry = {
    ...state,
    lastType: frame.type,
    moduleFrames: state.moduleFrames + 1,
  };
  if (frame.type === CRSF_FRAMETYPE_LINK_STATISTICS && payload.length >= 10) {
    const power = payload[6] ?? 0;
    next.link = {
      // TX-to-handset RSSI is signed dBm, unlike RX-to-flight-controller magnitudes.
      uplinkRssiDbm: signed8(payload[0] ?? 0),
      uplinkLq: payload[2] ?? 0,
      uplinkSnr: signed8(payload[3] ?? 0),
      antenna: (payload[4] ?? 0) + 1,
      rfMode: payload[5] ?? 0,
      txPowerMw: power < TX_POWER_MW.length ? TX_POWER_MW[power] ?? null : null,
      downlinkRssiDbm: signed8(payload[7] ?? 0),
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
    const mode = cString(payload, 0)?.trim();
    next.flightMode = mode || null;
  } else if (frame.type === CRSF_FRAMETYPE_DEVICE_INFO && payload[1] === CRSF_ADDRESS_MODULE) {
    const name = cString(payload, 2)?.trim();
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
