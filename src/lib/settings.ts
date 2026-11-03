import { DEFAULT_INVERTS, type Inverts } from "./controls";
import { DEFAULT_BAUD, HANDSET_BAUDS } from "./crsf";

export type Settings = {
  v: 1;
  baud: number;
  hz: 50 | 100 | 200;
  modelId: number;
  sendModelId: boolean;
  inverts: Inverts;
  gamepad: boolean;
  armWithoutReply: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  baud: DEFAULT_BAUD,
  hz: 100,
  modelId: 0,
  sendModelId: false,
  inverts: DEFAULT_INVERTS,
  gamepad: false,
  armWithoutReply: false,
};

const STORAGE_KEY = "nomad-desk-settings";
const listeners = new Set<() => void>();
let fallbackSnapshot = "";
let memoryOnly = false;

export function settingsFromSnapshot(raw: string): Settings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings> | null;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return DEFAULT_SETTINGS;
    const hz = parsed.hz === 50 || parsed.hz === 100 || parsed.hz === 200 ? parsed.hz : 100;
    const validModel = typeof parsed.modelId === "number" && Number.isFinite(parsed.modelId);
    return {
      v: 1,
      baud: typeof parsed.baud === "number" && (HANDSET_BAUDS as readonly number[]).includes(parsed.baud) ? parsed.baud : DEFAULT_BAUD,
      hz,
      modelId: validModel ? Math.min(63, Math.max(0, Math.round(parsed.modelId!))) : 0,
      sendModelId: parsed.sendModelId === true && validModel,
      inverts: {
        roll: parsed.inverts?.roll === true,
        pitch: parsed.inverts?.pitch === true,
        yaw: parsed.inverts?.yaw === true,
        throttle: parsed.inverts?.throttle === true,
      },
      gamepad: parsed.gamepad === true,
      armWithoutReply: parsed.armWithoutReply === true,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readSettingsSnapshot(): string {
  if (memoryOnly) return fallbackSnapshot;
  try {
    return localStorage.getItem(STORAGE_KEY) ?? fallbackSnapshot;
  } catch {
    return fallbackSnapshot;
  }
}

export function updateSettings(patch: Partial<Settings>): void {
  const next = settingsFromSnapshot(JSON.stringify({
    ...settingsFromSnapshot(readSettingsSnapshot()),
    ...patch,
    v: 1,
  }));
  fallbackSnapshot = JSON.stringify(next);
  try {
    localStorage.setItem(STORAGE_KEY, fallbackSnapshot);
  } catch {
    // Private/restricted browser storage may be unavailable; keep this tab usable.
    memoryOnly = true;
  }
  for (const listener of listeners) listener();
}
