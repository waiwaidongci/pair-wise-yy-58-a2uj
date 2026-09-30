// 东塔转换桁架吊装 —— 领域模型与规则引擎
// 步骤参数 (荷载率 / 净空 / 风速) 变更后，只有依赖该参数的冲突、未关闭意见、
// 对应角色签署会被标记为「失效待重算」，其余步骤与已关闭意见继续沿用。

export type ParamKey = 'loadRate' | 'clearance' | 'wind' | 'radius' | 'boom';

export type StepStatus = 'pending' | 'passed' | 'blocked';

export type ConflictStatus = 'active' | 'stale';

export type CommentStatus = 'open' | 'resolved';

export type SignatureStatus = 'signed' | 'pending';

export type LiftStep = {
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
};

export type Conflict = {
  id: string;
  stepId: string;
  /** 该冲突依赖的参数键 —— 参数一变，只有命中此键的冲突失效 */
  rule: ParamKey;
  message: string;
  severity: 'high' | 'medium';
  status: ConflictStatus;
};

export type Comment = {
  id: string;
  author: string;
  role: string;
  content: string;
  status: CommentStatus;
  stepId: string;
  /** 该意见依赖的参数键；null 表示不随参数变更失效 */
  parameter: ParamKey | null;
  /** 参数变更后置为 true，待复核人重新确认 */
  stale: boolean;
};

export type Signature = {
  id: string;
  role: string;
  name: string;
  team: string;
  scope: string;
  /** 该角色负责的参数 —— 任一 argc 参数变更，该角色签署失效 */
  parameters: ParamKey[];
  status: SignatureStatus;
  stale: boolean;
  signedAt: string | null;
};

export type OfflineBatch = {
  id: string;
  stepId: string;
  patch: Partial<LiftStep>;
  /** 断网提交时所依据的服务端步骤版本，用于按步骤合并 */
  baseVersion: number;
  at: string;
  status: 'pending' | 'failed';
};

export type ReviewSubmission = {
  id: string;
  role: string;
  name: string;
  content: string;
  baseRevision: number;
  currentRevision: number;
  accepted: boolean;
  reason: 'accepted' | 'duplicate' | 'stale';
  signedBy: string | null;
  at: string;
};

export const PARAM_LABELS: Record<ParamKey, string> = {
  loadRate: '荷载率',
  clearance: '净空',
  wind: '风速',
  radius: '作业半径',
  boom: '臂长'
};

export const STEP_PARAMS: ParamKey[] = ['loadRate', 'clearance', 'wind', 'radius', 'boom'];

/** 冲突规则：每条规则只依赖一个参数，参数变更后仅命中规则失效重算 */
export type ConflictRule = {
  param: ParamKey;
  evaluate: (step: LiftStep) => string | null;
};

export const CONFLICT_RULES: ConflictRule[] = [
  { param: 'loadRate', evaluate: (s) => (s.loadRate > 90 ? `荷载率 ${s.loadRate}% 超过 90% 阈值` : null) },
  { param: 'clearance', evaluate: (s) => (s.clearance < 1.5 ? `净空 ${s.clearance}m 小于 1.5m` : null) },
  { param: 'wind', evaluate: (s) => (s.wind > 8 ? `风速 ${s.wind}m/s 超过暂停值` : null) },
  { param: 'radius', evaluate: (s) => (s.radius > s.boom * 0.62 ? '工作半径接近额定幅度' : null) }
];

/** 会签角色与各自负责的参数 —— 参数变更只让对应角色的签署失效 */
export const SIGNATURE_SCOPES: { role: string; name: string; team: string; scope: string; parameters: ParamKey[] }[] = [
  { role: '总包', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', parameters: [] },
  { role: '设备', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', parameters: ['radius', 'boom', 'loadRate'] },
  { role: '安全', name: '周工', team: '安全监督', scope: '净空、风速与警戒区', parameters: ['clearance', 'wind'] },
  { role: '方案', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数', parameters: ['loadRate', 'radius', 'boom'] }
];

export const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

export const initialComments: Comment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02', parameter: 'clearance', stale: false },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05', parameter: 'loadRate', stale: false },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03', parameter: null, stale: false }
];

export function initialSignatures(): Signature[] {
  return SIGNATURE_SCOPES.map((s) => ({
    id: `SG-${s.role}`,
    role: s.role,
    name: s.name,
    team: s.team,
    scope: s.scope,
    parameters: s.parameters,
    status: s.role === '总包' ? 'signed' : 'pending',
    stale: false,
    signedAt: s.role === '总包' ? '2026-09-18T08:00:00.000Z' : null
  }));
}

/** 由步骤初始生成冲突，id 规则与时间轴一致：${stepId}-${该步骤命中规则的序号} */
export function generateConflicts(steps: LiftStep[]): Conflict[] {
  const list: Conflict[] = [];
  for (const step of steps) {
    let index = 0;
    for (const rule of CONFLICT_RULES) {
      const message = rule.evaluate(step);
      if (message) {
        list.push({
          id: `${step.id}-${index}`,
          stepId: step.id,
          rule: rule.param,
          message,
          severity: step.status === 'blocked' ? 'high' : 'medium',
          status: 'active'
        });
        index += 1;
      }
    }
  }
  return list;
}

/** 从意见内容推断其依赖的参数 */
export function detectCommentParameter(content: string): ParamKey | null {
  if (/荷载|载荷|load/i.test(content)) return 'loadRate';
  if (/净空|clearance/i.test(content)) return 'clearance';
  if (/风速|wind/i.test(content)) return 'wind';
  if (/半径|幅度|radius/i.test(content)) return 'radius';
  return null;
}

/** 深拷贝步骤，用于提交前快照比对 */
export function cloneSteps(steps: LiftStep[]): LiftStep[] {
  return steps.map((s) => ({ ...s }));
}
