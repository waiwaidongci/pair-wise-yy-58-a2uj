import type { LiftStep, ParamKey } from './domain';

export interface RuleConflict {
  id: string;
  ruleId: string;
  stepId: string;
  title: string;
  message: string;
  detail: string;
  severity: 'high' | 'medium';
  deps: ParamKey[];
  /** 现场处置（迁移障碍、降载、等待风窗后确认等）；有处置且复核通过后不再阻断发布 */
  handling?: { note: string; by: string; at: number };
}

interface RuleDef {
  ruleId: string;
  deps: ParamKey[];
  severity: 'high' | 'medium';
  test: (step: LiftStep) => boolean;
  message: (step: LiftStep) => { text: string; detail: string };
}

// 每条规则显式声明依赖的工况参数：只有这些参数变化，该冲突才需要重算/复签
const RULES: RuleDef[] = [
  {
    ruleId: 'LOAD_RATE',
    deps: ['loadRate'],
    severity: 'high',
    test: (s) => s.loadRate > 90,
    message: (s) => ({ text: `荷载率 ${s.loadRate}% 超过 90% 阈值`, detail: '额定负荷率控制值 90%，超出必须降载或换型。' })
  },
  {
    ruleId: 'CLEARANCE',
    deps: ['clearance'],
    severity: 'high',
    test: (s) => s.clearance < 1.5,
    message: (s) => ({ text: `净空 ${s.clearance}m 小于 1.5m`, detail: '夜间作业最小安全净空 1.5m，需迁移障碍或调整回转路径。' })
  },
  {
    ruleId: 'WIND',
    deps: ['wind'],
    severity: 'high',
    test: (s) => s.wind > 8,
    message: (s) => ({ text: `风速 ${s.wind}m/s 超过暂停值`, detail: '阵风超过 8m/s 暂停起吊，等待风窗。' })
  },
  {
    ruleId: 'RADIUS_RATING',
    deps: ['radius', 'boom'],
    severity: 'medium',
    test: (s) => s.radius > s.boom * 0.62,
    message: (s) => ({ text: '工作半径接近额定幅度', detail: `当前幅度 ${s.radius}m，占臂长 ${s.boom}m 的 ${Math.round((s.radius / s.boom) * 100)}%，限值 62%。` })
  }
];

export function evaluateStep(step: LiftStep, handling: Record<string, RuleConflict['handling'] | undefined>): RuleConflict[] {
  return RULES.filter((rule) => rule.test(step)).map((rule) => ({
    id: `${step.id}:${rule.ruleId}`,
    ruleId: rule.ruleId,
    stepId: step.id,
    title: step.title,
    message: rule.message(step).text,
    detail: rule.message(step).detail,
    severity: rule.severity,
    deps: rule.deps,
    handling: handling[`${step.id}:${rule.ruleId}`]
  }));
}

export function evaluateAll(steps: LiftStep[], handling: Record<string, RuleConflict['handling'] | undefined>): RuleConflict[] {
  return steps.flatMap((step) => evaluateStep(step, handling));
}

export function rulesDependingOn(param: ParamKey): string[] {
  return RULES.filter((rule) => rule.deps.includes(param)).map((rule) => rule.ruleId);
}

export const RULE_DEPS: Record<string, ParamKey[]> = Object.fromEntries(
  RULES.map((rule) => [rule.ruleId, rule.deps])
);
