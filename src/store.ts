import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';
import {
  Comment,
  Conflict,
  LiftStep,
  OfflineBatch,
  ParamKey,
  ReviewSubmission,
  Signature,
  StepStatus,
  STEP_PARAMS,
  cloneSteps,
  detectCommentParameter,
  generateConflicts,
  initialComments,
  initialSignatures,
  initialSteps,
  CONFLICT_RULES
} from './domain';

const cacheKey = 'yy58-lift-plan-draft';

type PersistedDraft = {
  steps?: LiftStep[];
  comments?: Partial<Comment>[];
  selectedStepId?: string;
  revision?: number;
  locked?: boolean;
  viewBookmarks?: string[];
  activeBookmark?: string;
};

function loadDraft(): PersistedDraft | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey);
    return raw ? (JSON.parse(raw) as PersistedDraft) : null;
  } catch {
    return null;
  }
}

/** 迁移旧版草稿：补齐 parameter / stale 字段，冲突由步骤重新生成 */
function migrateComments(saved: Partial<Comment>[] | undefined): Comment[] {
  if (!saved) return initialComments.map((c) => ({ ...c }));
  return saved.map((c) => ({
    id: c.id ?? `C-${Math.random()}`,
    author: c.author ?? '王工',
    role: c.role ?? '方案',
    content: c.content ?? '',
    status: (c.status as Comment['status']) ?? 'open',
    stepId: c.stepId ?? 'S-01',
    parameter: c.parameter === undefined ? detectCommentParameter(c.content ?? '') : c.parameter,
    stale: c.stale ?? false
  }));
}

function now() {
  return new Date().toISOString();
}

let offlineSeq = 0;
let reviewSeq = 0;

export const useLiftStore = defineStore('lift-plan', {
  state: () => {
    const saved = loadDraft();
    const steps = saved?.steps ?? initialSteps.map((s) => ({ ...s }));
    return {
      steps,
      comments: migrateComments(saved?.comments),
      conflicts: generateConflicts(steps),
      signatures: initialSignatures(),
      selectedStepId: saved?.selectedStepId ?? 'S-02',
      revision: saved?.revision ?? 4,
      locked: saved?.locked ?? false,
      // 断网合并
      networkStatus: 'online' as 'online' | 'offline',
      offlineQueue: [] as OfflineBatch[],
      offlineStatus: 'idle' as 'idle' | 'pending' | 'syncing' | 'failed',
      conflictStepIds: [] as string[],
      serverStepVersion: Object.fromEntries(steps.map((s) => [s.id, 0])) as Record<string, number>,
      // 会签提交
      signedRevision: {} as Record<string, number>,
      rejectedBatches: [] as ReviewSubmission[],
      lastSubmitResult: null as ReviewSubmission | null,
      // 失效重算：每个步骤自上次重算后变更过的参数
      dirtyParams: {} as Record<string, ParamKey[]>,
      lastCommittedSteps: cloneSteps(steps),
      viewBookmarks: saved?.viewBookmarks ?? ['主吊全景', '东侧障碍', '安装轴线'],
      activeBookmark: saved?.activeBookmark ?? '主吊全景'
    };
  },
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    activeConflicts(state): Conflict[] {
      return state.conflicts.filter((c) => c.status === 'active');
    },
    staleConflicts(state): Conflict[] {
      return state.conflicts.filter((c) => c.status === 'stale');
    },
    openComments(state): Comment[] {
      return state.comments.filter((c) => c.status === 'open');
    },
    staleComments(state): Comment[] {
      return state.comments.filter((c) => c.status === 'open' && c.stale);
    },
    staleSignatures(state): Signature[] {
      return state.signatures.filter((s) => s.stale);
    },
    allSigned(state): boolean {
      return state.signatures.every((s) => s.status === 'signed' && !s.stale);
    },
    /** 发布门禁：冲突清零、意见全部关闭、四个角色完成签署且无失效项 */
    releaseBlocked(state): boolean {
      return (
        state.conflicts.length > 0 ||
        state.comments.some((c) => c.status === 'open') ||
        state.signatures.some((s) => s.status !== 'signed' || s.stale)
      );
    },
    /** 退回原因：逐条说明为何不能放行 */
    releaseReasons(state): string[] {
      const reasons: string[] = [];
      for (const c of state.conflicts) {
        if (c.status === 'stale') reasons.push(`步骤 ${c.stepId} 参数变更导致冲突「${c.message}」待重算`);
        else reasons.push(`步骤 ${c.stepId} 存在未处理冲突「${c.message}」`);
      }
      for (const c of state.comments) {
        if (c.status === 'open' && c.stale) reasons.push(`意见 ${c.id}（${c.author}）因参数变更待重新确认：${c.content}`);
        else if (c.status === 'open') reasons.push(`意见 ${c.id}（${c.author}）尚未关闭：${c.content}`);
      }
      for (const s of state.signatures) {
        if (s.stale) reasons.push(`${s.role}（${s.name}）签署因参数变更失效，待重新签署`);
        else if (s.status !== 'signed') reasons.push(`${s.role}（${s.name}）尚未完成会签`);
      }
      return reasons;
    },
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      return Math.max(0, Math.round((passedChecks / state.steps.length) * 100 - commentPenalty));
    },
    pendingOfflineCount(state): number {
      return state.offlineQueue.filter((b) => b.status === 'pending').length;
    },
    failedOfflineCount(state): number {
      return state.offlineQueue.filter((b) => b.status === 'failed').length;
    }
  },
  actions: {
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    /** 提交步骤修改：v-model 已直接改值，这里比对「上次提交快照」找出变更参数，触发级联失效 */
    updateStep(patch: Partial<LiftStep> = {}) {
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      if (index < 0) return;
      const committed = this.lastCommittedSteps.find((s) => s.id === this.selectedStepId);
      const before = committed ?? { ...this.steps[index] };
      if (Object.keys(patch).length > 0) {
        this.steps[index] = { ...this.steps[index], ...patch };
      }
      const after = this.steps[index];
      const changedParams = STEP_PARAMS.filter((k) => before[k] !== after[k]);
      for (const param of changedParams) {
        this.markDirty(after.id, param);
        this.invalidateDependents(after.id, param);
      }
      // 断网：把本次修改按步骤合并入队
      if (this.networkStatus === 'offline') {
        const diff: Partial<LiftStep> = {};
        for (const k of STEP_PARAMS) if (before[k] !== after[k]) (diff as Record<string, unknown>)[k] = after[k];
        if (before.status !== after.status) diff.status = after.status;
        if (Object.keys(diff).length > 0) this.queueOfflineEdit(after.id, diff);
      }
      this.lastCommittedSteps = cloneSteps(this.steps);
      this.persist();
    },
    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },
    /** 记录某步骤自上次重算后变更的参数 */
    markDirty(stepId: string, param: ParamKey) {
      const set = new Set(this.dirtyParams[stepId] ?? []);
      set.add(param);
      this.dirtyParams[stepId] = [...set];
    },
    /** 参数一变：只让依赖它的冲突、未关闭意见、对应签署失效；已签步骤与已关闭意见沿用 */
    invalidateDependents(stepId: string, param: ParamKey) {
      for (const c of this.conflicts) {
        if (c.stepId === stepId && c.rule === param && c.status === 'active') c.status = 'stale';
      }
      for (const c of this.comments) {
        if (c.stepId === stepId && c.status === 'open' && c.parameter === param) c.stale = true;
      }
      for (const s of this.signatures) {
        if (s.parameters.includes(param)) s.stale = true;
      }
    },
    /** 重算单个失效冲突：规则仍命中则保留（刷新文案/等级），否则移除 */
    recalculateConflict(conflictId: string) {
      const conflict = this.conflicts.find((c) => c.id === conflictId);
      if (!conflict || conflict.status !== 'stale') return;
      const step = this.steps.find((s) => s.id === conflict.stepId);
      const rule = CONFLICT_RULES.find((r) => r.param === conflict.rule);
      if (!step || !rule) return;
      const message = rule.evaluate(step);
      if (message) {
        conflict.message = message;
        conflict.severity = step.status === 'blocked' ? 'high' : 'medium';
        conflict.status = 'active';
      } else {
        this.conflicts = this.conflicts.filter((c) => c.id !== conflictId);
      }
      this.persist();
    },
    /** 重算某步骤全部失效项：对脏参数重新跑规则，新建/刷新/移除冲突；并重新确认未关闭意见 */
    recalculateStep(stepId: string) {
      const step = this.steps.find((s) => s.id === stepId);
      if (!step) return;
      const dirty = this.dirtyParams[stepId] ?? [];
      const staleRules = this.conflicts.filter((c) => c.stepId === stepId && c.status === 'stale').map((c) => c.rule);
      const evalParams = [...new Set([...dirty, ...staleRules])];
      for (const param of evalParams) {
        const rule = CONFLICT_RULES.find((r) => r.param === param);
        if (!rule) continue;
        const message = rule.evaluate(step);
        const existing = this.conflicts.find((c) => c.stepId === stepId && c.rule === param);
        if (message && !existing) {
          const ruleIndex = CONFLICT_RULES.indexOf(rule);
          this.conflicts.push({
            id: `${stepId}-${ruleIndex}`,
            stepId,
            rule: param,
            message,
            severity: step.status === 'blocked' ? 'high' : 'medium',
            status: 'active'
          });
        } else if (message && existing) {
          existing.message = message;
          existing.severity = step.status === 'blocked' ? 'high' : 'medium';
          existing.status = 'active';
        } else if (!message && existing) {
          this.conflicts = this.conflicts.filter((c) => c.id !== existing.id);
        }
      }
      // 未关闭意见经参数变更后重新确认（仍保留 open，由复核人决定是否关闭）
      for (const c of this.comments) {
        if (c.stepId === stepId && c.status === 'open' && c.stale) c.stale = false;
      }
      this.dirtyParams[stepId] = [];
      this.persist();
    },
    recalculateAll() {
      for (const step of this.steps) this.recalculateStep(step.id);
    },
    addComment(content: string, author = '王工', role = '方案', parameter?: ParamKey) {
      if (!content.trim()) return;
      this.comments.unshift({
        id: `C-${Date.now()}`,
        author,
        role,
        content,
        status: 'open',
        stepId: this.selectedStepId,
        parameter: parameter ?? detectCommentParameter(content),
        stale: false
      });
      this.persist();
    },
    resolveComment(id: string) {
      const item = this.comments.find((c) => c.id === id);
      if (item) {
        item.status = 'resolved';
        item.stale = false;
      }
      this.persist();
    },
    /** 复核人重新确认因参数变更失效的意见 */
    confirmComment(id: string) {
      const item = this.comments.find((c) => c.id === id);
      if (item && item.status === 'open') item.stale = false;
      this.persist();
    },
    /** 参数变更后角色重新签署 */
    resignSignature(role: string) {
      const sig = this.signatures.find((s) => s.role === role);
      if (!sig) return;
      sig.status = 'signed';
      sig.stale = false;
      sig.signedAt = now();
      this.signedRevision[role] = this.revision;
      this.persist();
    },
    /**
     * 会签提交：同一版本只收一次。
     * - 已签署同版本 → 判重拒绝，保留本批内容并回显当前版本/签署人
     * - 版本过期 → 拒绝并保留本批内容，回显当前版本
     * - 接受 → 记录签署
     */
    submitReview(role: string, content: string, baseRevision: number): ReviewSubmission {
      const currentRevision = this.revision;
      const sig = this.signatures.find((s) => s.role === role);
      const alreadySigned = sig ? sig.status === 'signed' && this.signedRevision[role] === currentRevision : false;
      const versionMismatch = baseRevision !== currentRevision;
      const accepted = !alreadySigned && !versionMismatch;
      const submission: ReviewSubmission = {
        id: `R-${++reviewSeq}`,
        role,
        name: sig?.name ?? '',
        content,
        baseRevision,
        currentRevision,
        accepted,
        reason: accepted ? 'accepted' : alreadySigned ? 'duplicate' : 'stale',
        signedBy: alreadySigned ? sig?.name ?? null : null,
        at: now()
      };
      if (accepted) {
        if (sig) {
          sig.status = 'signed';
          sig.stale = false;
          sig.signedAt = submission.at;
        }
        this.signedRevision[role] = currentRevision;
      } else {
        // 后到者保留本批内容，不丢弃
        this.rejectedBatches.unshift(submission);
      }
      this.lastSubmitResult = submission;
      this.persist();
      return submission;
    },
    // ---- 断网合并 ----
    goOffline() {
      this.networkStatus = 'offline';
      this.offlineStatus = 'idle';
    },
    goOnline() {
      this.networkStatus = 'online';
      if (this.offlineQueue.some((b) => b.status === 'pending')) {
        void this.syncOffline();
      }
    },
    /** 断网修改按步骤合并：同一步骤的多批修改按字段后写覆盖 */
    queueOfflineEdit(stepId: string, patch: Partial<LiftStep>) {
      const existing = this.offlineQueue.find((b) => b.stepId === stepId && b.status === 'pending');
      if (existing) {
        existing.patch = { ...existing.patch, ...patch };
        existing.at = now();
      } else {
        this.offlineQueue.push({
          id: `OB-${++offlineSeq}`,
          stepId,
          patch,
          baseVersion: this.serverStepVersion[stepId] ?? 0,
          at: now(),
          status: 'pending'
        });
      }
      this.offlineStatus = 'pending';
    },
    /** 按步骤合并提交；合并失败则保留现场（失败批次不清空），可重试 */
    syncOffline() {
      this.offlineStatus = 'syncing';
      const failed: string[] = [];
      const succeededIds: string[] = [];
      for (const batch of this.offlineQueue) {
        if (batch.status !== 'pending') continue;
        const currentVersion = this.serverStepVersion[batch.stepId] ?? 0;
        if (batch.baseVersion === currentVersion) {
          // 版本一致，干净合并；成功批次移出队列
          this.serverStepVersion[batch.stepId] = currentVersion + 1;
          succeededIds.push(batch.id);
        } else {
          failed.push(batch.stepId);
          batch.status = 'failed';
        }
      }
      if (succeededIds.length > 0) {
        this.offlineQueue = this.offlineQueue.filter((b) => !succeededIds.includes(b.id));
      }
      if (failed.length > 0) {
        this.offlineStatus = 'failed';
        this.conflictStepIds = [...new Set(failed)];
        // 保留现场：失败批次留在队列中，不清空
      } else {
        this.offlineStatus = 'idle';
        this.conflictStepIds = [];
      }
      this.persist();
    },
    /** 原请求可重试：重新按步骤合并 */
    retryOffline() {
      for (const b of this.offlineQueue) b.status = 'pending';
      this.conflictStepIds = [];
      void this.syncOffline();
    },
    /** 强制合并：本地修改优先，覆盖服务端版本（保留现场的兜底手段） */
    forceOfflineMerge() {
      for (const batch of this.offlineQueue) {
        const currentVersion = this.serverStepVersion[batch.stepId] ?? 0;
        this.serverStepVersion[batch.stepId] = currentVersion + 1;
        batch.status = 'pending';
      }
      this.offlineQueue = [];
      this.offlineStatus = 'idle';
      this.conflictStepIds = [];
      this.persist();
    },
    /** 测试钩子：模拟服务端在断网期间改了某步骤，制造版本冲突 */
    simulateServerChange(stepId: string) {
      this.serverStepVersion[stepId] = (this.serverStepVersion[stepId] ?? 0) + 1;
    },
    lockPlan() {
      if (this.releaseBlocked) {
        this.persist();
        return { locked: false, reasons: this.releaseReasons };
      }
      this.locked = true;
      this.revision += 1;
      for (const s of this.signatures) {
        if (s.status === 'signed') this.signedRevision[s.role] = this.revision;
      }
      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: 'LP-2026-0918' },
        data: { liftPlan: { __typename: 'LiftPlan', id: 'LP-2026-0918', name: '东塔转换桁架吊装', revision: this.revision, status: 'LOCKED', steps: this.steps } }
      });
      this.persist();
      return { locked: true, reasons: [] };
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    persist() {
      if (typeof localStorage === 'undefined') return;
      const draft = {
        steps: this.steps,
        comments: this.comments,
        selectedStepId: this.selectedStepId,
        revision: this.revision,
        locked: this.locked,
        viewBookmarks: this.viewBookmarks,
        activeBookmark: this.activeBookmark,
        draftSavedAt: new Date().toISOString()
      };
      localStorage.setItem(cacheKey, JSON.stringify(draft));
    }
  }
});
