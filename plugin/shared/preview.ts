// Preview and confirm helpers for the write RPCs. A mutating call must quote
// the fingerprint of the preview the user confirmed; the server recomputes it
// from fresh state and refuses stale previews. Pure module: no imports.

export function isPlanHash(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value);
}

/** cyrb53 hash in hex. An accident guard, not a secret. */
export function shortHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprintOf(value: unknown): string {
  return shortHash(stable(value));
}

export interface SwitchPreviewIdentity {
  repo: string;
  workspaceId: string | null;
  from: string;
  to: string;
  fromId: string | null;
  toId: string | null;
  epoch: number;
  checkpointAt: string | null;
}

export function switchFingerprint(identity: SwitchPreviewIdentity): string {
  return fingerprintOf({ kind: "factory.switch", ...identity });
}

export interface CheckpointPreviewIdentity {
  agentId?: string | null;
  holderId?: string | null;
  repo: string;
  workspaceId: string;
  epoch: number | null;
  task: string;
  tests: string[];
  blockers: string[];
  next: string | null;
}

export function checkpointFingerprint(identity: CheckpointPreviewIdentity): string {
  return fingerprintOf({ kind: "factory.checkpoint", ...identity });
}

export interface FreshPreviewIdentity {
  repo: string;
  workspaceId: string | null;
  slot: string;
  /** Source holder agent id (new-agent) or the kept tab (rewind). */
  from: string | null;
  epoch: number;
  refreshMode: string | null;
  provider: string | null;
  model: string | null;
  checkpointAt: string | null;
}

export function freshFingerprint(identity: FreshPreviewIdentity): string {
  return fingerprintOf({ kind: "factory.fresh", ...identity });
}

export interface ResumePreviewIdentity {
  agentId: string;
  status: string | null;
  sessionId: string | null;
  checkpointAt: string | null;
}

export function resumeFingerprint(identity: ResumePreviewIdentity): string {
  return fingerprintOf({ kind: "factory.resume.apply", ...identity });
}

export interface AssignPreviewIdentity {
  scope: string;
  epoch: number;
  steerId?: string;
  task: string;
  tests: string[];
  blockers: string[];
  next: string | null;
}

export function assignFingerprint(identity: AssignPreviewIdentity): string {
  return fingerprintOf({ kind: "factory.assign", ...identity });
}

export interface RelocatePreviewIdentity {
  scope: string;
  fromWorkspace: string;
  toDir: string;
  steers: string[];
  checkpoint: boolean;
}

export function relocateFingerprint(identity: RelocatePreviewIdentity): string {
  return fingerprintOf({ kind: "factory.relocate", ...identity });
}

export interface LabelsPreviewIdentity {
  address: string | null;
  rows: unknown;
}

export function labelsFingerprint(identity: LabelsPreviewIdentity): string {
  return fingerprintOf({ kind: "factory.labels", ...identity });
}

export interface SteerAddPreviewIdentity {
  scope: string | null;
  repo: string | null;
  workspaceId: string | null;
  slot: string;
  profile: string;
  provider: string;
  model: string;
  thinking: string | null;
  mode: string | null;
  account: string | null;
  advisor: boolean;
}

export function steerAddFingerprint(identity: SteerAddPreviewIdentity): string {
  return fingerprintOf({ kind: "factory.steer.add", ...identity });
}

export interface SettingsPreviewIdentity {
  workspaceId: string;
  agentId: string;
  epoch: number | null;
  sessionId: string | null;
  current: { provider: string | null; model: string | null; thinking: string | null; speed: string | null };
  requested: { provider: string | null; model: string | null; thinking: string | null; speed: string | null };
  route: string;
}

export function settingsFingerprint(identity: SettingsPreviewIdentity): string {
  return fingerprintOf({ kind: "factory.steer.settings", ...identity });
}
