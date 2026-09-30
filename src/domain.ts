// 东塔桁架夜间工况复算：领域模型与参数依赖定义

export type ParamKey = 'loadRate' | 'clearance' | 'wind' | 'radius' | 'boom';
export type StepStatus = 'pending' | 'passed' | 'blocked';

export const PARAM_LABELS: Record<ParamKey, string> = {
  loadRate: '荷载率',
  clearance: '最小净空',
  wind: '风速',
  radius: '作业半径',
  boom: '臂长'
};

export const PARAM_UNITS: Record<ParamKey, string> = {
  loadRate: '%',
  clearance: 'm',
  wind: 'm/s',
  radius: 'm',
  boom: 'm'
};

export const NUMERIC_PARAMS: ParamKey[] = ['loadRate', 'clearance', 'wind', 'radius', 'boom'];

export interface LiftStep {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  status: StepStatus;
  note: string;
}

export type CommentStatus = 'open' | 'resolved' | 'invalidated';

export interface CommentInvalidReason {
  param: ParamKey;
  from: number;
  to: number;
  at: number;
}

export interface LiftComment {
  id: string;
  author: string;
  role: string;
  reviewerId: string;
  content: string;
  status: CommentStatus;
  stepId: string;
  /** 意见所挂的工况参数；为空表示一般性意见，参数变更不使其失效 */
  deps: ParamKey[];
  invalidReason?: CommentInvalidReason;
  createdAt: number;
}

export interface ConflictHandling {
  note: string;
  by: string;
  at: number;
}

/** 复核人签署：记录签署时其职责范围内各步骤参数的取值依据 */
export interface Signoff {
  reviewerId: string;
  revision: number;
  batchId: string;
  basis: Record<string, Partial<Record<ParamKey, number>>>;
  at: number;
}

export interface SignoffDiff {
  stepId: string;
  param: ParamKey;
  from: number;
  to: number;
}

export interface PacketRecord {
  batchId: string;
  reviewerId: string;
  reviewerName: string;
  revision: number;
  summary: string;
  at: number;
  /** 后到被判重的记录 */
  deduped: boolean;
  acceptedBy?: string;
}

export type RequestStatus = 'pending' | 'syncing' | 'failed' | 'done';

export interface MergeConflict {
  param: ParamKey;
  base: number;
  server: number;
  local: number;
}

export interface QueuedRequest {
  id: string;
  kind: 'stepPatch' | 'signoff';
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  // stepPatch
  stepId?: string;
  patch?: Partial<LiftStep>;
  baseParams?: Partial<Record<ParamKey, number>>;
  conflicts?: MergeConflict[];
  // signoff
  reviewerId?: string;
  signoff?: Signoff;
}

/** 对一组取值做稳定指纹，用作复核批次判重键 */
export function fingerprint(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function paramsOf(step: LiftStep): Record<ParamKey, number> {
  return {
    loadRate: step.loadRate,
    clearance: step.clearance,
    wind: step.wind,
    radius: step.radius,
    boom: step.boom
  };
}
