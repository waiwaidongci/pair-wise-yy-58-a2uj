import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';
import { evaluateAll, RULE_DEPS } from './rules';
import {
  adminRemoteChange,
  fetchSnapshot,
  initServer,
  isOnline,
  MergeError,
  OfflineError,
  publishRevision,
  reseedServer,
  setOnline as setTransportOnline,
  submitSignoffPacket,
  syncStepPatch,
  unlockRevision,
  type MergeConflictDetail
} from './sync';
import {
  fingerprint,
  NUMERIC_PARAMS,
  PARAM_LABELS,
  paramsOf,
  type LiftComment,
  type LiftStep,
  type ParamKey,
  type QueuedRequest,
  type Signoff,
  type SignoffDiff,
  type PacketRecord
} from './domain';

export type StepStatus = 'pending' | 'passed' | 'blocked';
export type { LiftStep, ParamKey };

export interface Reviewer {
  id: string;
  name: string;
  team: string;
  scope: string;
  deps: ParamKey[];
}

interface Notice {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  title: string;
  text: string;
  at: number;
}

export const REVIEWERS: Reviewer[] = [
  { id: 'chen', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', deps: ['loadRate', 'clearance', 'radius', 'boom'] },
  { id: 'liu', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', deps: ['loadRate', 'radius', 'boom'] },
  { id: 'zhou', name: '周工', team: '安全监督', scope: '净空、风速与警戒区', deps: ['clearance', 'wind'] },
  { id: 'zhao', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数', deps: ['loadRate', 'clearance', 'wind', 'radius', 'boom'] }
];

const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

const initialComments: LiftComment[] = [
  { id: 'C-11', author: '周工', role: '安全', reviewerId: 'zhou', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02', deps: ['clearance'], createdAt: 1 },
  { id: 'C-12', author: '刘明', role: '设备', reviewerId: 'liu', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05', deps: ['loadRate'], createdAt: 2 },
  { id: 'C-13', author: '陈晓', role: '总包', reviewerId: 'chen', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03', deps: [], createdAt: 3 }
];

function buildBasis(steps: LiftStep[], reviewer: Reviewer): Signoff['basis'] {
  const basis: Signoff['basis'] = {};
  for (const step of steps) {
    const entry: Partial<Record<ParamKey, number>> = {};
    for (const dep of reviewer.deps) entry[dep] = step[dep];
    basis[step.id] = entry;
  }
  return basis;
}

const initialReviewer = REVIEWERS[0];
const seedSignoffs: Signoff[] = [
  { reviewerId: initialReviewer.id, revision: 4, batchId: 'seed-batch', basis: buildBasis(initialSteps, initialReviewer), at: Date.now() - 3600_000 }
];

initServer(initialSteps, seedSignoffs, 4);

const cacheKey = 'yy58-lift-plan-draft-v2';
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey) : null;
const saved = stored ? (JSON.parse(stored) as Record<string, unknown>) : null;

function diffParams(from: Record<ParamKey, number>, to: Record<ParamKey, number>): Partial<Record<ParamKey, number>> {
  const changed: Partial<Record<ParamKey, number>> = {};
  for (const key of NUMERIC_PARAMS) {
    if (Number.isFinite(to[key]) && from[key] !== to[key]) changed[key] = to[key];
  }
  return changed;
}

export function computeSignoffDiffs(steps: LiftStep[], signoff: Signoff): SignoffDiff[] {
  const diffs: SignoffDiff[] = [];
  for (const step of steps) {
    const basis = signoff.basis[step.id];
    if (!basis) continue;
    for (const key of Object.keys(basis) as ParamKey[]) {
      const from = basis[key];
      if (from !== undefined && from !== step[key]) {
        diffs.push({ stepId: step.id, param: key, from, to: step[key] });
      }
    }
  }
  return diffs;
}

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    steps: (saved?.steps as LiftStep[]) ?? initialSteps,
    comments: (saved?.comments as LiftComment[]) ?? initialComments,
    selectedStepId: (saved?.selectedStepId as string) ?? 'S-02',
    revision: (saved?.revision as number) ?? 4,
    locked: (saved?.locked as boolean) ?? false,
    viewBookmarks: ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (saved?.activeBookmark as string) ?? '主吊全景',
    /** 最近一次与服务端一致的各步骤参数，作为三路合并的 base */
    lastServerParams: (saved?.lastServerParams as Record<string, Record<ParamKey, number>>) ??
      Object.fromEntries(initialSteps.map((step) => [step.id, paramsOf(step)])),
    conflictHandling: (saved?.conflictHandling as Record<string, { note: string; by: string; at: number }>) ?? {},
    signoffs: (saved?.signoffs as Signoff[]) ?? seedSignoffs,
    packets: (saved?.packets as PacketRecord[]) ?? [],
    queue: (saved?.queue as QueuedRequest[]) ?? [],
    online: (saved?.online as boolean) ?? isOnline(),
    notices: [] as Notice[]
  }),
  getters: {
    reviewers: () => REVIEWERS,
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    conflicts(state) {
      return evaluateAll(state.steps, state.conflictHandling);
    },
    openConflicts(): ReturnType<typeof evaluateAll> {
      return this.conflicts.filter((item) => !item.handling);
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    invalidComments(state) {
      return state.comments.filter((comment) => comment.status === 'invalidated');
    },
    signoffById(state): Record<string, Signoff> {
      const map: Record<string, Signoff> = {};
      for (const item of state.signoffs) map[item.reviewerId] = item;
      return map;
    },
    queuedSignoffIds(state): Set<string> {
      return new Set(state.queue.filter((item) => item.kind === 'signoff' && item.status !== 'done').map((item) => item.reviewerId!));
    },
    localDirtySteps(state): Set<string> {
      const dirty = new Set<string>();
      for (const step of state.steps) {
        const base = state.lastServerParams[step.id];
        if (!base) continue;
        if (Object.keys(diffParams(base, paramsOf(step))).length > 0) dirty.add(step.id);
      }
      return dirty;
    },
    signoffDiffs(state): (signoff: Signoff) => SignoffDiff[] {
      return (signoff: Signoff) => computeSignoffDiffs(state.steps, signoff);
    },
    reviewerState(): (reviewerId: string) => 'missing' | 'valid' | 'invalid' | 'syncing' {
      return (reviewerId: string) => {
        const signoff = this.signoffById[reviewerId];
        if (!signoff) return 'missing';
        if (this.queuedSignoffIds.has(reviewerId)) return 'syncing';
        return computeSignoffDiffs(this.steps, signoff).length === 0 ? 'valid' : 'invalid';
      };
    },
    gateReasons(): string[] {
      const reasons: string[] = [];
      if (this.locked) return reasons;
      if (!this.online) reasons.push('当前处于断网状态，无法锁定发布');
      for (const conflict of this.openConflicts) reasons.push(`冲突未清零：${conflict.stepId} ${conflict.message}`);
      if (this.openComments.length > 0) reasons.push(`有 ${this.openComments.length} 条未关闭意见（${this.openComments.map((c) => c.id).join('、')}）`);
      if (this.invalidComments.length > 0) reasons.push(`有 ${this.invalidComments.length} 条意见因参数变更失效，需按新参数重新确认关闭`);
      for (const reviewer of REVIEWERS) {
        const state = this.reviewerState(reviewer.id);
        if (state === 'missing') reasons.push(`${reviewer.name}（${reviewer.team}）尚未签署`);
        else if (state === 'syncing') reasons.push(`${reviewer.name} 的会签批次仍在队列中待同步`);
        else if (state === 'invalid') reasons.push(`${reviewer.name} 的签署依据已失效，需按当前版本重签`);
      }
      if (this.queue.some((item) => item.kind === 'stepPatch' && !item.conflicts && item.status !== 'done')) {
        reasons.push('现场仍有未合并的步骤修改请求');
      }
      if (this.queue.some((item) => item.kind === 'stepPatch' && item.conflicts)) {
        reasons.push('存在合并失败待处置的步骤修改');
      }
      if (this.localDirtySteps.size > 0) reasons.push(`步骤 ${[...this.localDirtySteps].join('、')} 有参数修改尚未同步`);
      return reasons;
    },
    releaseAllowed(): boolean {
      return !this.locked && this.gateReasons.length === 0;
    },
    readiness(): number {
      let score = 20;
      score += this.steps.filter((step) => step.status === 'passed').length * 8;
      score += REVIEWERS.filter((reviewer) => this.reviewerState(reviewer.id) === 'valid').length * 10;
      score -= this.openConflicts.length * 6;
      score -= (this.openComments.length + this.invalidComments.length) * 5;
      score -= this.signoffs.filter((signoff) => this.signoffDiffs(signoff).length > 0).length * 6;
      return Math.max(0, Math.min(100, score));
    }
  },
  actions: {
    // ---------- 基础选择 / 书签 ----------
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    setStepStatus(status: StepStatus) {
      const step = this.steps.find((item) => item.id === this.selectedStepId);
      if (step) step.status = status;
      this.persist();
    },
    setStepNote(note: string) {
      const step = this.steps.find((item) => item.id === this.selectedStepId);
      if (step) step.note = note;
      this.persist();
    },

    // ---------- 通知 ----------
    pushNotice(kind: Notice['kind'], title: string, text: string) {
      this.notices.unshift({ id: `N-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind, title, text, at: Date.now() });
      this.notices = this.notices.slice(0, 12);
    },
    dismissNotice(id: string) {
      this.notices = this.notices.filter((item) => item.id !== id);
    },

    // ---------- 选择性失效 ----------
    /**
     * 参数变化的唯一入口：只让依赖变化参数的内容失效并触发重算。
     * - 冲突：规则按 deps 重新求值；已有的现场处置记录失效（冲突重新出现）
     * - 意见：仅未关闭(open)且 deps 命中的意见失效，已解决意见不动
     * - 签署：在 signoffDiffs 中按 basis 实时比对，不删除历史批次
     */
    applyParamChanges(stepId: string, changed: Partial<Record<ParamKey, number>>, source: 'local' | 'server' = 'local') {
      const keys = Object.keys(changed) as ParamKey[];
      if (keys.length === 0) return;
      const step = this.steps.find((item) => item.id === stepId);
      if (!step) return;
      for (const key of keys) step[key] = changed[key] as number;

      // 处置记录挂在 (步骤,规则) 上：只要规则依赖的参数发生变化，处置即失效需重算
      for (const key of Object.keys(this.conflictHandling)) {
        const [sid, ruleId] = key.split(':');
        const deps = RULE_DEPS[ruleId];
        if (sid === stepId && deps?.some((dep) => keys.includes(dep))) delete this.conflictHandling[key];
      }

      for (const comment of this.comments) {
        if (comment.stepId === stepId && comment.status === 'open' && comment.deps.some((dep) => keys.includes(dep))) {
          const param = comment.deps.find((dep) => keys.includes(dep))!;
          comment.status = 'invalidated';
          comment.invalidReason = { param, from: this.lastServerParams[stepId]?.[param] ?? NaN, to: changed[param] as number, at: Date.now() };
        }
      }

      const names = keys.map((key) => `${PARAM_LABELS[key]} ${source === 'server' ? '被另一现场端' : ''}`).join('、');
      const invalidSignoffs = this.signoffs.filter((item) => this.signoffDiffs(item).length > 0).length;
      this.pushNotice(
        'warn',
        `${stepId} 参数已变更，依赖内容已失效重算`,
        `${names}发生变化：相关规则冲突重新校核，未关闭意见退回确认，${invalidSignoffs} 份签署需重签；无关步骤与签署保持有效。`
      );
    },

    // ---------- 步骤保存 + 同步 ----------
    saveStep() {
      const step = this.steps.find((item) => item.id === this.selectedStepId);
      if (!step) return;
      const base = this.lastServerParams[step.id] ?? paramsOf(step);
      const current = paramsOf(step);
      const changed = diffParams(base, current);
      this.persist();
      if (Object.keys(changed).length === 0) return;

      this.applyParamChanges(step.id, changed);
      if (this.online) {
        void this.syncStepRequest(step.id, { ...changed }, { ...base });
      } else {
        this.enqueueStepPatch(step.id, changed, base);
        this.pushNotice('info', '断网中，修改已按步骤保留', `${step.id} 的修改暂存在现场队列，联网后按步骤合并，原请求可重试。`);
      }
      this.persist();
    },

    async syncStepRequest(stepId: string, patch: Partial<Record<ParamKey, number>>, base: Partial<Record<ParamKey, number>>) {
      try {
        const result = await syncStepPatch({ stepId, patch, base });
        this.adoptServerStep(result.step);
        this.revision = result.revision;
        this.removeStepQueue(stepId);
        this.pushNotice('success', `${stepId} 已合并到服务端`, `当前方案版本 V${result.revision}。`);
      } catch (error) {
        if (error instanceof OfflineError) {
          this.enqueueStepPatch(stepId, patch, base);
          this.online = false;
        } else if (error instanceof MergeError) {
          this.enqueueMergeFailure(stepId, patch, base, error.conflicts);
        } else {
          this.enqueueStepPatch(stepId, patch, base, 'failed');
          this.pushNotice('error', `${stepId} 提交失败`, error instanceof Error ? error.message : '未知错误，请求已保留，可重试。');
        }
      }
      this.persist();
    },

    adoptServerStep(serverStep: LiftStep, serverRevision?: number) {
      if (serverRevision !== undefined) this.revision = serverRevision;
      const index = this.steps.findIndex((item) => item.id === serverStep.id);
      if (index < 0) return;
      const previous = this.lastServerParams[serverStep.id] ?? paramsOf(this.steps[index]);
      const serverParams = paramsOf(serverStep);
      const drifted = diffParams(previous, serverParams);
      // 只同步工况参数；步骤结论、现场说明等非参数字段由各现场端保留
      Object.assign(this.steps[index], serverParams);
      this.lastServerParams[serverStep.id] = serverParams;
      if (Object.keys(drifted).length > 0) {
        // 来自服务端的他端改动同样只失效依赖项；本地未提交的同参数修改以合并失败处理，不在这里覆盖
        this.applyParamChanges(serverStep.id, drifted, 'server');
      }
    },

    enqueueStepPatch(stepId: string, patch: Partial<Record<ParamKey, number>>, base: Partial<Record<ParamKey, number>>, status: QueuedRequest['status'] = 'pending') {
      // 同一步骤的连续断网修改合并为一个请求，保留最早 base
      const existing = this.queue.find((item) => item.kind === 'stepPatch' && item.stepId === stepId && item.status !== 'done' && !item.conflicts);
      const now = Date.now();
      if (existing) {
        existing.patch = { ...existing.patch, ...patch };
        existing.baseParams = { ...base, ...existing.baseParams };
        existing.status = status;
        existing.updatedAt = now;
        return;
      }
      this.queue.push({
        id: `Q-${now}-${Math.random().toString(36).slice(2, 7)}`,
        kind: 'stepPatch',
        status,
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        stepId,
        patch,
        baseParams: base
      });
    },

    enqueueMergeFailure(stepId: string, patch: Partial<Record<ParamKey, number>>, base: Partial<Record<ParamKey, number>>, conflicts: MergeConflictDetail[]) {
      const existing = this.queue.find((item) => item.kind === 'stepPatch' && item.stepId === stepId && item.status !== 'done');
      const now = Date.now();
      const detail = conflicts.map((c) => `${PARAM_LABELS[c.param]}：现场 ${c.local} / 他端 ${c.server}（基准 ${c.base}）`).join('；');
      if (existing) {
        existing.status = 'failed';
        existing.conflicts = conflicts;
        existing.updatedAt = now;
      } else {
        this.queue.push({
          id: `Q-${now}-${Math.random().toString(36).slice(2, 7)}`,
          kind: 'stepPatch',
          status: 'failed',
          createdAt: now,
          updatedAt: now,
          attempts: 0,
          stepId,
          patch,
          baseParams: base,
          conflicts
        });
      }
      this.pushNotice('error', `${stepId} 合并失败，现场修改已保留`, `${detail}。请选择保留现场值重试，或采用当前版本值。`);
    },

    removeStepQueue(stepId: string) {
      this.queue = this.queue.filter((item) => !(item.kind === 'stepPatch' && item.stepId === stepId));
    },

    /** 合并冲突处置：保留现场值——以服务端当前值为新 base 重新提交原请求 */
    retryKeepingLocal(id: string) {
      const request = this.queue.find((item) => item.id === id);
      if (!request || request.kind !== 'stepPatch') return;
      const base = { ...(request.baseParams ?? {}) } as Partial<Record<ParamKey, number>>;
      for (const conflict of request.conflicts ?? []) {
        (base as Record<ParamKey, number>)[conflict.param] = conflict.server;
      }
      request.baseParams = base;
      request.conflicts = undefined;
      request.status = 'pending';
      request.attempts += 1;
      request.updatedAt = Date.now();
      if (this.online) void this.flushQueue();
      this.persist();
    },

    /** 合并冲突处置：采用当前版本——放弃本地冲突参数，拉取服务端步骤，原请求移除 */
    async acceptServerVersion(id: string) {
      const request = this.queue.find((item) => item.id === id);
      if (!request || request.kind !== 'stepPatch' || !request.stepId) return;
      try {
        const snapshot = await fetchSnapshot();
        const serverStep = snapshot.steps.find((item) => item.id === request.stepId);
        if (serverStep) this.adoptServerStep(serverStep, snapshot.revision);
        this.queue = this.queue.filter((item) => item.id !== id);
        this.pushNotice('success', `${request.stepId} 已采用当前版本`, `现场冲突参数已更新为 V${snapshot.revision} 的值。`);
      } catch (error) {
        this.pushNotice('error', '拉取当前版本失败', error instanceof Error ? error.message : '请稍后重试。');
      }
      this.persist();
    },

    retryRequest(id: string) {
      const request = this.queue.find((item) => item.id === id);
      if (!request) return;
      request.status = 'pending';
      request.attempts += 1;
      request.updatedAt = Date.now();
      if (this.online) void this.flushQueue();
      this.persist();
    },

    // ---------- 联网 / 断网 ----------
    setOnline(value: boolean) {
      this.online = value;
      setTransportOnline(value);
      this.persist();
      if (value) void this.reconnect();
      else this.pushNotice('info', '已切换为断网模式', '修改与签署会按步骤/批次保留，联网后自动合并，原请求均可重试。');
    },

    async reconnect() {
      try {
        const snapshot = await fetchSnapshot();
        this.revision = snapshot.revision;
        for (const serverStep of snapshot.steps) {
          const local = this.steps.find((item) => item.id === serverStep.id);
          if (!local) continue;
          const localDirty = Object.keys(diffParams(this.lastServerParams[serverStep.id] ?? paramsOf(local), paramsOf(local))).length > 0;
          if (localDirty) continue; // 本地有待合并修改，交给队列三路合并，不覆盖现场
          this.adoptServerStep(serverStep);
        }
        await this.flushQueue();
        this.pushNotice('success', '网络已恢复', '现场保留的请求已按步骤合并完成。');
      } catch (error) {
        this.pushNotice('error', '重连同步失败', error instanceof Error ? error.message : '请手动重试队列。');
      }
      this.persist();
    },

    async flushQueue() {
      if (!this.online) return;
      for (const request of [...this.queue]) {
        if (request.status === 'done') continue;
        if (request.kind === 'stepPatch') {
          if (request.conflicts) continue; // 等待人工选择
          const step = this.steps.find((item) => item.id === request.stepId);
          if (!step) {
            this.queue = this.queue.filter((item) => item.id !== request.id);
            continue;
          }
          const patch = { ...(request.patch ?? {}) } as Partial<Record<ParamKey, number>>;
          const base = { ...(request.baseParams ?? {}) } as Partial<Record<ParamKey, number>>;
          request.status = 'syncing';
          try {
            const result = await syncStepPatch({ stepId: request.stepId!, patch, base });
            this.adoptServerStep(result.step);
            this.revision = result.revision;
            this.queue = this.queue.filter((item) => item.id !== request.id);
          } catch (error) {
            if (error instanceof MergeError) {
              request.status = 'failed';
              request.conflicts = error.conflicts;
              const detail = error.conflicts.map((c) => `${PARAM_LABELS[c.param]}：现场 ${c.local} / 他端 ${c.server}`).join('；');
              this.pushNotice('error', `${request.stepId} 合并失败，现场修改已保留`, `${detail}。原请求可重试。`);
            } else if (error instanceof OfflineError) {
              request.status = 'pending';
              this.online = false;
              return;
            } else {
              request.status = 'failed';
            }
          }
        } else if (request.kind === 'signoff') {
          const signoff = request.signoff;
          if (!signoff) {
            this.queue = this.queue.filter((item) => item.id !== request.id);
            continue;
          }
          request.status = 'syncing';
          const outcome = await submitSignoffPacket({ batchId: signoff.batchId, signoffs: [signoff] }).catch(
            (error: unknown) => error as Error
          );
          if (outcome instanceof OfflineError) {
            request.status = 'pending';
            this.online = false;
            return;
          }
          if (outcome instanceof Error) {
            request.status = 'failed';
            continue;
          }
          if (outcome.outcome === 'stale') {
            request.status = 'failed';
            this.signoffs = this.signoffs.filter((item) => item.reviewerId !== signoff.reviewerId);
            this.pushNotice('warn', `${this.reviewerName(signoff.reviewerId)} 的签署版本已前移`, `服务端当前为 V${outcome.currentRevision}，本批内容已保留，请基于当前版本复核后重签。`);
          } else {
            this.signoffs = outcome.signoffs;
            this.queue = this.queue.filter((item) => item.id !== request.id);
            if (outcome.outcome === 'duplicate') {
              this.recordPacket(signoff, true, outcome.acceptedBy);
              this.pushNotice('info', '同版本会签只收取一次', `你与 ${outcome.acceptedBy.split(',').map((id: string) => this.reviewerName(id)).join('、')} 的批次内容一致，已保留首次提交；当前版本 V${outcome.currentRevision}。`);
            } else {
              this.recordPacket(signoff, false);
              this.pushNotice('success', `${this.reviewerName(signoff.reviewerId)} 的离线会签已同步`, `签署版本 V${outcome.currentRevision}。`);
            }
          }
        }
      }
      this.persist();
    },

    // ---------- 评论 ----------
    addComment(content: string, deps: ParamKey[], author = '王工', role = '方案', reviewerId = 'wang') {
      if (!content.trim()) return;
      this.comments.unshift({
        id: `C-${Date.now()}`,
        author,
        role,
        reviewerId,
        content,
        status: 'open',
        stepId: this.selectedStepId,
        deps,
        createdAt: Date.now()
      });
      this.persist();
    },
    resolveComment(id: string) {
      const item = this.comments.find((comment) => comment.id === id);
      if (item) {
        item.status = 'resolved';
        item.invalidReason = undefined;
      }
      this.persist();
    },
    /** 失效意见按新参数重新核对：重新打开为未关闭意见 */
    recheckComment(id: string) {
      const item = this.comments.find((comment) => comment.id === id);
      if (item) item.status = 'open';
      this.persist();
    },

    // ---------- 冲突现场处置 ----------
    handleConflict(conflictId: string, note: string) {
      const conflict = this.conflicts.find((item) => item.id === conflictId);
      if (!conflict || !note.trim()) return;
      this.conflictHandling[conflictId] = { note: note.trim(), by: '王工', at: Date.now() };
      this.persist();
    },
    reopenConflict(conflictId: string) {
      delete this.conflictHandling[conflictId];
      this.persist();
    },

    // ---------- 会签 ----------
    reviewerName(id: string): string {
      return REVIEWERS.find((item) => item.id === id)?.name ?? id;
    },
    makeSignoff(reviewerId: string, revision: number, batchId: string): Signoff {
      const reviewer = REVIEWERS.find((item) => item.id === reviewerId)!;
      return { reviewerId, revision, batchId, basis: buildBasis(this.steps, reviewer), at: Date.now() };
    },
    recordPacket(signoff: Signoff, deduped: boolean, acceptedBy?: string) {
      const reviewer = REVIEWERS.find((item) => item.id === signoff.reviewerId);
      this.packets.unshift({
        batchId: signoff.batchId,
        reviewerId: signoff.reviewerId,
        reviewerName: reviewer?.name ?? signoff.reviewerId,
        revision: signoff.revision,
        summary: `${(reviewer?.deps ?? []).map((dep) => PARAM_LABELS[dep]).join('、')} 参数核对一致`,
        at: signoff.at,
        deduped,
        acceptedBy
      });
      this.packets = this.packets.slice(0, 20);
    },
    submitSignoff(reviewerId: string) {
      if (this.locked) return;
      if (this.localDirtySteps.size > 0) {
        this.pushNotice('warn', '存在未同步的参数修改', '请先让本步骤修改合并完成后再签署，避免签署依据与当前版本不一致。');
        return;
      }
      const batchId = `B-${fingerprint({ reviewerId, revision: this.revision, basis: buildBasis(this.steps, REVIEWERS.find((r) => r.id === reviewerId)!) })}-${Date.now().toString(36)}`;
      const signoff = this.makeSignoff(reviewerId, this.revision, batchId);
      if (this.online) {
        void this.sendSignoff(signoff);
      } else {
        this.queue.push({
          id: `Q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: 'signoff',
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attempts: 0,
          reviewerId,
          signoff
        });
        this.signoffs = [...this.signoffs.filter((item) => item.reviewerId !== reviewerId), signoff];
        this.pushNotice('info', '断网中，会签已保留批次', '联网后按批次提交；若版本已前移，会提示基于当前版本重签。');
      }
      this.persist();
    },

    async sendSignoff(signoff: Signoff) {
      try {
        const outcome = await submitSignoffPacket({ batchId: signoff.batchId, signoffs: [signoff] });
        if (outcome.outcome === 'accepted') {
          this.signoffs = outcome.signoffs;
          this.recordPacket(signoff, false);
          this.pushNotice('success', `${this.reviewerName(signoff.reviewerId)} 已完成会签`, `签署版本 V${this.revision}。`);
        } else if (outcome.outcome === 'duplicate') {
          this.signoffs = outcome.signoffs;
          this.recordPacket(signoff, true, outcome.acceptedBy);
          this.pushNotice('info', '同版本会签只收取一次', `本批内容已被 ${outcome.acceptedBy.split(',').map((id) => this.reviewerName(id)).join('、')} 先行提交，你的本批内容已保留，当前显示 V${outcome.currentRevision}。`);
        } else {
          this.pushNotice('warn', '签署依据不是当前版本', `服务端当前为 V${outcome.currentRevision}，请复核变化参数后基于当前版本重签；本批内容已保留。`);
        }
      } catch (error) {
        if (error instanceof OfflineError) {
          this.online = false;
          this.queue.push({
            id: `Q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            kind: 'signoff',
            status: 'pending',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            attempts: 0,
            reviewerId: signoff.reviewerId,
            signoff
          } as QueuedRequest);
          this.signoffs = [...this.signoffs.filter((item) => item.reviewerId !== signoff.reviewerId), signoff];
        } else {
          this.pushNotice('error', '会签提交失败', error instanceof Error ? error.message : '请求已保留，可重试。');
        }
      }
      this.persist();
    },

    /** 演示：两名复核人同时提交同一版本的同一批内容，只收一次 */
    async simulateConcurrentSignoff() {
      if (this.localDirtySteps.size > 0) {
        this.pushNotice('warn', '存在未同步修改', '请先清空本地未合并参数再演示同版本会签。');
        return;
      }
      const batchId = `B-joint-${this.revision}-${Date.now().toString(36)}`;
      const a = this.makeSignoff('zhou', this.revision, batchId);
      const b = this.makeSignoff('zhao', this.revision, batchId);
      const [ra, rb] = await Promise.all([
        submitSignoffPacket({ batchId, signoffs: [a, b] }),
        submitSignoffPacket({ batchId, signoffs: [a, b] })
      ]);
      const accepted = [ra, rb].find((r) => r.outcome === 'accepted');
      const duplicate = [ra, rb].find((r) => r.outcome === 'duplicate');
      if (accepted) this.signoffs = accepted.signoffs;
      else if (duplicate) this.signoffs = duplicate.signoffs;
      this.packets.unshift({
        batchId,
        reviewerId: 'zhou+zhao',
        reviewerName: '周工 + 赵磊',
        revision: this.revision,
        summary: '同版本同批内容并发提交',
        at: Date.now(),
        deduped: Boolean(duplicate),
        acceptedBy: duplicate?.acceptedBy
      });
      if (duplicate) {
        this.pushNotice('info', '并发会签判重生效', `两批内容完全一致，服务端只收取首次提交（${duplicate.acceptedBy.split(',').map((id) => this.reviewerName(id)).join('、')}），后到者保留本批内容并已看到当前版本 V${duplicate.currentRevision}。`);
      }
      this.persist();
    },

    /** 失效签署按当前参数重建并重新提交 */
    rebaseSignoff(reviewerId: string) {
      this.queue = this.queue.filter((item) => !(item.kind === 'signoff' && item.reviewerId === reviewerId));
      const signoff = this.makeSignoff(reviewerId, this.revision, `B-${reviewerId}-${this.revision}-${Date.now().toString(36)}`);
      if (this.online) void this.sendSignoff(signoff);
      else {
        this.signoffs = [...this.signoffs.filter((item) => item.reviewerId !== reviewerId), signoff];
        this.queue.push({
          id: `Q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: 'signoff',
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          attempts: 0,
          reviewerId,
          signoff
        } as QueuedRequest);
      }
      this.persist();
    },

    // ---------- 他端改动演示 / 拉取 ----------
    async simulateRemoteChange() {
      try {
        const rev = await adminRemoteChange('S-02', { clearance: 2.1 });
        this.pushNotice('info', '已注入他端修改', `另一台现场客户端在线把 S-02 净空改为 2.1m，服务端当前 V${rev}。重试你本地的 S-02 修改将看到合并冲突。`);
      } catch (error) {
        this.pushNotice('error', '注入他端修改失败', error instanceof Error ? error.message : '');
      }
    },
    async pullCurrent() {
      try {
        const snapshot = await fetchSnapshot();
        this.revision = snapshot.revision;
        this.locked = snapshot.locked;
        for (const serverStep of snapshot.steps) this.adoptServerStep(serverStep);
        this.pushNotice('success', '已拉取当前版本', `现在显示 V${snapshot.revision}，本地未提交修改未被覆盖。`);
      } catch (error) {
        this.pushNotice('error', '拉取失败', error instanceof Error ? error.message : '当前可能处于断网状态。');
      }
      this.persist();
    },

    // ---------- 发布门禁 ----------
    async lockPlan() {
      const reasons = this.gateReasons;
      if (reasons.length > 0) {
        this.pushNotice('error', '发布入口已锁定，暂不能放行', reasons.join('；'));
        return;
      }
      try {
        const next = this.revision + 1;
        const result = await publishRevision(next);
        this.revision = result.revision;
        this.locked = true;
        graphqlClient.writeQuery({
          query: LIFT_PLAN_QUERY,
          variables: { id: 'LP-2026-0918' },
          data: {
            liftPlan: {
              __typename: 'LiftPlan',
              id: 'LP-2026-0918',
              name: '东塔转换桁架吊装',
              revision: this.revision,
              status: 'LOCKED',
              steps: this.steps.map((step) => ({
                __typename: 'LiftStep',
                id: step.id,
                name: step.title,
                loadRate: step.loadRate,
                clearance: step.clearance
              }))
            }
          }
        });
        this.pushNotice('success', `V${this.revision} 已锁定发布`, '冲突清零、意见关闭、四角色签署齐全且全部同步完成。');
      } catch (error) {
        this.pushNotice('error', '锁定发布失败', error instanceof Error ? error.message : '请重试。');
      }
      this.persist();
    },
    async unlockPlan() {
      try {
        await unlockRevision();
        this.locked = false;
        this.pushNotice('info', '版本已解锁', '可继续修改参数，相关依赖内容会重新失效重算（演示用）。');
      } catch (error) {
        this.pushNotice('error', '解锁失败', error instanceof Error ? error.message : '');
      }
      this.persist();
    },

    resetDemo() {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(cacheKey);
        reseedServer(initialSteps, seedSignoffs, 4);
      }
      if (typeof location !== 'undefined') location.reload();
    },

    persist() {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(cacheKey, JSON.stringify({ ...this.$state, draftSavedAt: new Date().toISOString() }));
      }
    }
  }
});
