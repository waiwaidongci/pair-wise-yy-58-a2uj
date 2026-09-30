// 模拟协同服务端：在线状态、按步骤三路合并、会签批次幂等判重
// 现场为单浏览器演示，服务端状态独立持久化在 localStorage 中
import type { LiftStep, ParamKey, Signoff } from './domain';
import { fingerprint } from './domain';

const SERVER_KEY = 'yy58-lift-server';

export class OfflineError extends Error {
  isOffline = true;
  constructor() {
    super('当前处于断网状态，请求已保留在现场');
  }
}

export class MergeError extends Error {
  conflicts: MergeConflictDetail[];
  constructor(conflicts: MergeConflictDetail[]) {
    super('同一参数已被另一现场客户端修改');
    this.conflicts = conflicts;
  }
}

export interface MergeConflictDetail {
  param: ParamKey;
  base: number;
  server: number;
  local: number;
}

interface AcceptedPacket {
  batchId: string;
  fingerprint: string;
  by: string;
  at: number;
  revision: number;
}

interface ServerState {
  revision: number;
  locked: boolean;
  steps: Record<string, LiftStep>;
  signoffs: Record<string, Signoff>;
  lastPacket?: AcceptedPacket;
}

let state: ServerState | null = null;
let online = true;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function persistServer() {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SERVER_KEY, JSON.stringify(state));
}

export function initServer(seedSteps: LiftStep[], seedSignoffs: Signoff[], revision = 4) {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(SERVER_KEY) : null;
  if (stored) {
    state = JSON.parse(stored) as ServerState;
    return;
  }
  const steps: Record<string, LiftStep> = {};
  for (const step of seedSteps) steps[step.id] = clone(step);
  const signoffs: Record<string, Signoff> = {};
  for (const item of seedSignoffs) signoffs[item.reviewerId] = clone(item);
  state = { revision, locked: false, steps, signoffs, lastPacket: undefined };
  persistServer();
}

export function reseedServer(seedSteps: LiftStep[], seedSignoffs: Signoff[], revision = 4) {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(SERVER_KEY);
  state = null;
  initServer(seedSteps, seedSignoffs, revision);
}

export function isOnline() {
  return online;
}

export function setOnline(value: boolean) {
  online = value;
}

async function network<T>(worker: () => T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 260));
  if (!online || !state) throw new OfflineError();
  return worker();
}

export interface Snapshot {
  revision: number;
  locked: boolean;
  steps: LiftStep[];
  signoffs: Signoff[];
}

export async function fetchSnapshot(): Promise<Snapshot> {
  return network(() => ({
    revision: state!.revision,
    locked: state!.locked,
    steps: Object.values(state!.steps).map(clone),
    signoffs: Object.values(state!.signoffs).map(clone)
  }));
}

export function currentRevision(): number {
  return state?.revision ?? 0;
}

function signoffFingerprint(signoffs: Signoff[]) {
  const ordered = signoffs
    .map((item) => ({ reviewerId: item.reviewerId, basis: item.basis }))
    .sort((a, b) => a.reviewerId.localeCompare(b.reviewerId));
  return fingerprint(ordered);
}

/**
 * 按步骤提交参数修改：base 为该现场最近一次同步到的参数值。
 * 仅比对同一参数：无冲突快进合并，版本号 +1；任一参数冲突整体不改服务端。
 */
export async function syncStepPatch(input: {
  stepId: string;
  patch: Partial<Pick<LiftStep, ParamKey>>;
  base: Partial<Record<ParamKey, number>>;
}): Promise<{ revision: number; step: LiftStep }> {
  return network(() => {
    if (state!.locked) throw new Error('当前版本已锁定发布，参数修改被服务端拒绝');
    const serverStep = state!.steps[input.stepId];
    if (!serverStep) throw new Error(`服务端不存在步骤 ${input.stepId}`);
    const conflicts: MergeConflictDetail[] = [];
    for (const key of Object.keys(input.patch) as ParamKey[]) {
      const baseValue = input.base[key];
      if (baseValue !== undefined && serverStep[key] !== baseValue) {
        conflicts.push({ param: key, base: baseValue, server: serverStep[key], local: input.patch[key] as number });
      }
    }
    if (conflicts.length > 0) throw new MergeError(conflicts);
    Object.assign(serverStep, input.patch);
    state!.revision += 1;
    persistServer();
    return { revision: state!.revision, step: clone(serverStep) };
  });
}

export type PacketOutcome =
  | { outcome: 'accepted'; currentRevision: number; signoffs: Signoff[] }
  | { outcome: 'duplicate'; currentRevision: number; signoffs: Signoff[]; acceptedBy: string; acceptedAt: number; batchId: string }
  | { outcome: 'stale'; currentRevision: number; signoffs: Signoff[] };

/** 会签批次提交：batchId 幂等 + 同版本同内容指纹判重；只收一次 */
export async function submitSignoffPacket(input: { batchId: string; signoffs: Signoff[] }): Promise<PacketOutcome> {
  return network(() => {
    const all = Object.values(state!.signoffs).map(clone);
    if (input.signoffs.some((item) => item.revision !== state!.revision)) {
      return { outcome: 'stale', currentRevision: state!.revision, signoffs: all };
    }
    if (state!.lastPacket && state!.lastPacket.batchId === input.batchId) {
      return {
        outcome: 'duplicate',
        currentRevision: state!.revision,
        signoffs: all,
        acceptedBy: state!.lastPacket.by,
        acceptedAt: state!.lastPacket.at,
        batchId: input.batchId
      };
    }
    const fp = signoffFingerprint(input.signoffs);
    if (state!.lastPacket && state!.lastPacket.revision === state!.revision && state!.lastPacket.fingerprint === fp) {
      return {
        outcome: 'duplicate',
        currentRevision: state!.revision,
        signoffs: all,
        acceptedBy: state!.lastPacket.by,
        acceptedAt: state!.lastPacket.at,
        batchId: state!.lastPacket.batchId
      };
    }
    const acceptedAt = Date.now();
    for (const item of input.signoffs) {
      state!.signoffs[item.reviewerId] = clone(item);
    }
    const acceptedBy = input.signoffs.map((item) => item.reviewerId).join(',');
    state!.lastPacket = { batchId: input.batchId, fingerprint: fp, by: acceptedBy, at: acceptedAt, revision: state!.revision };
    persistServer();
    return { outcome: 'accepted', currentRevision: state!.revision, signoffs: Object.values(state!.signoffs).map(clone) };
  });
}

export async function publishRevision(nextRevision: number): Promise<{ revision: number }> {
  return network(() => {
    state!.revision = nextRevision;
    state!.locked = true;
    persistServer();
    return { revision: state!.revision };
  });
}

export async function unlockRevision(): Promise<void> {
  return network(() => {
    state!.locked = false;
    persistServer();
  });
}

/** 演示注入：另一台现场客户端在线修改了同一步骤的参数，服务端版本前移 */
export async function adminRemoteChange(stepId: string, patch: Partial<Pick<LiftStep, ParamKey>>): Promise<number> {
  return network(() => {
    Object.assign(state!.steps[stepId], patch);
    state!.revision += 1;
    persistServer();
    return state!.revision;
  });
}
