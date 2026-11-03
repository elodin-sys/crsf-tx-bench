import { DEFAULT_INVERTS, type Inverts } from "./controls";
import { DEFAULT_BAUD, HANDSET_BAUDS } from "./crsf";

export type Settings = {
  v: 1;
  baud: number;
  hz: 50 | 100 | 200;
  modelId: number;
  inverts: Inverts;
  gamepad: boolean;
  armWithoutReply: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  baud: DEFAULT_BAUD,
  hz: 100,
  modelId: 0,
  inverts: DEFAULT_INVERTS,
  gamepad: false,
  armWithoutReply: false,
};

const STORAGE_KEY = "nomad-desk-settings";
const listeners = new Set<() => void>();

function isBaud(value: number): boolean {
  return (HANDSET_BAUDS as readonly number[]).includes(value);
}

export function settingsFromSnapshot(raw: string): Settings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (parsed.v !== 1) return DEFAULT_SETTINGS;
    const hz = parsed.hz === 50 || parsed.hz === 100 || parsed.hz === 200 ? parsed.hz : 100;
    return {
      v: 1,
      baud: parsed.baud && isBaud(parsed.baud) ? parsed.baud : DEFAULT_BAUD,
      hz,
      modelId: Math.min(63, Math.max(0, Math.round(parsed.modelId ?? 0))),
      inverts: { ...DEFAULT_INVERTS, ...parsed.inverts },
      gamepad: Boolean(parsed.gamepad),
      armWithoutReply: Boolean(parsed.armWithoutReply),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readSettingsSnapshot(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

export function updateSettings(patch: Partial<Settings>): void {
  const next: Settings = {
    ...settingsFromSnapshot(readSettingsSnapshot()),
    ...patch,
    v: 1,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}
