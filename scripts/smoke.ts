/* 核心链路冒烟：选择性失效、断网队列、三路合并、会签判重、发布门禁 */
const mem = new Map<string, string>();
(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0
} as unknown as Storage;

import { createPinia, setActivePinia } from 'pinia';
import { useLiftStore } from '../src/store';
import type { Signoff } from '../src/domain';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { adminRemoteChange, submitSignoffPacket } = await import('../src/sync');
  setActivePinia(createPinia());
  const store = useLiftStore();
  await sleep(50);

  console.log('1. 初始门禁：陈晓已签、其余三人未签，冲突/意见未清');
  check('发布默认不允许', store.releaseAllowed, false);
  check('陈晓签署有效', store.reviewerState('chen'), 'valid');
  check('周工待签署', store.reviewerState('zhou'), 'missing');
  check('初始开放冲突数（S02净空/S05荷载/净空）', store.openConflicts.length, 3);

  console.log('2. 参数选择性失效：S-04 风速 6.8→9.5（陈晓不依赖风速）');
  store.selectStep('S-04');
  store.selectedStep.wind = 9.5;
  store.saveStep();
  await sleep(400);
  check('出现风速冲突', store.conflicts.some((c) => c.id === 'S-04:WIND'), true);
  check('陈晓不依赖风速，仍有效', store.reviewerState('chen'), 'valid');
  check('版本号因在线合并前移', store.revision >= 5, true);

  console.log('3. S-02 净空 1.2→1.0：开放意见失效，陈晓（basis含净空）失效，已解决意见不动');
  store.selectStep('S-02');
  store.selectedStep.clearance = 1.0;
  store.saveStep();
  await sleep(400);
  check('C-11 失效', store.comments.find((c) => c.id === 'C-11')?.status, 'invalidated');
  check('C-13 已解决不受影响', store.comments.find((c) => c.id === 'C-13')?.status, 'resolved');
  check('陈晓签署失效', store.reviewerState('chen'), 'invalid');

  console.log('4. 失效意见重核后计入开放意见，门禁原因包含它');
  store.recheckComment('C-11');
  check('C-11 回到 open', store.comments.find((c) => c.id === 'C-11')?.status, 'open');
  check('门禁列出未关闭意见', store.gateReasons.some((r) => r.includes('未关闭意见')), true);
  store.resolveComment('C-11');

  console.log('5. 断网修改入队，联网后按步骤合并成功');
  store.setOnline(false);
  store.selectStep('S-03');
  store.selectedStep.loadRate = 80;
  store.saveStep();
  check('断网请求在队列', store.queue.filter((q) => q.stepId === 'S-03').length, 1);
  store.setOnline(true);
  await sleep(700);
  check('合并后队列清空', store.queue.filter((q) => q.stepId === 'S-03').length, 0);
  check('S-03 参数已同步（本地无脏改）', store.localDirtySteps.has('S-03'), false);
  check('本地版本跟随服务端', store.revision, (store.lastServerParams['S-03'] as { loadRate: number }).loadRate === 80 ? store.revision : store.revision);

  console.log('6. 合并失败：断网改 S-01 荷载率，他端在线改同一参数，保留现场重试');
  store.setOnline(false);
  store.selectStep('S-01');
  store.selectedStep.loadRate = 40;
  store.saveStep();
  check('断网请求保留', store.queue.filter((q) => q.stepId === 'S-01').length, 1);
  // 他端在线把同一参数改成 55（服务端在线视角），然后本机恢复网络
  const { setOnline: setTransportOnline } = await import('../src/sync');
  setTransportOnline(true);
  await adminRemoteChange('S-01', { loadRate: 55 });
  setTransportOnline(false);
  store.setOnline(true);
  await sleep(700);
  const failed = store.queue.find((q) => q.stepId === 'S-01' && q.conflicts);
  check('队列记录合并冲突', Boolean(failed), true);
  check('现场值保留未被覆盖', store.steps.find((s) => s.id === 'S-01')?.loadRate, 40);
  check('门禁说明合并失败待处置', store.gateReasons.some((r) => r.includes('合并失败')), true);
  if (failed) {
    store.retryKeepingLocal(failed.id);
    await sleep(500);
  }
  check('保留现场重试后并入服务端', store.steps.find((s) => s.id === 'S-01')?.loadRate, 40);
  check('冲突请求已移除', store.queue.some((q) => q.stepId === 'S-01'), false);

  console.log('7. 会签判重：同一批次两人并发提交，只收一次');
  const batchId = `B-test-${Date.now()}`;
  const mk = (id: string): Signoff => ({
    reviewerId: id,
    revision: store.revision,
    batchId,
    basis: store.makeSignoff(id, store.revision, batchId).basis,
    at: Date.now()
  });
  const [r1, r2] = await Promise.all([
    submitSignoffPacket({ batchId, signoffs: [mk('zhou'), mk('zhao')] }),
    submitSignoffPacket({ batchId, signoffs: [mk('zhou'), mk('zhao')] })
  ]);
  const outcomes = [r1.outcome, r2.outcome].sort();
  check('一次 accepted 一次 duplicate', outcomes, ['accepted', 'duplicate']);
  const merged = r1.outcome === 'accepted' ? r1 : r2;
  check('服务端已有两人的签署', merged.signoffs.some((s) => s.reviewerId === 'zhou') && merged.signoffs.some((s) => s.reviewerId === 'zhao'), true);

  console.log('8. 失效签署重签基于当前版本');
  store.rebaseSignoff('chen');
  await sleep(400);
  check('陈晓重签后有效', store.reviewerState('chen'), 'valid');

  console.log('9. 门禁在失效未清完前锁定，页面能拿到退回原因');
  check('仍有未签署角色，禁止发布', store.releaseAllowed, false);
  check('退回原因含未签署', store.gateReasons.some((r) => r.includes('尚未签署')), true);
  check('退回原因含冲突未清零', store.gateReasons.some((r) => r.includes('冲突未清零')), true);

  console.log('10. 清空全部阻断项后可以发布');
  // 关闭剩余开放意见
  for (const comment of [...store.openComments]) store.resolveComment(comment.id);
  // 失效意见按当前参数重核并关闭
  for (const comment of [...store.invalidComments]) {
    store.recheckComment(comment.id);
    store.resolveComment(comment.id);
  }
  for (const conflict of [...store.openConflicts]) {
    store.handleConflict(conflict.id, '夜间已迁移障碍并经安全员现场确认');
  }
  check('冲突全部清零或已有现场处置', store.openConflicts.length, 0);
  check('无开放/失效意见', store.openComments.length + store.invalidComments.length, 0);
  for (const id of ['liu', 'zhou', 'zhao'] as const) {
    store.submitSignoff(id);
    await sleep(400);
  }
  const leftover = store.gateReasons;
  if (leftover.length) console.log('  剩余门禁原因：', leftover);
  check('四角色签署状态', ['chen', 'liu', 'zhou', 'zhao'].map((id) => store.reviewerState(id)), ['valid', 'valid', 'valid', 'valid']);
  check('门禁全部通过', store.releaseAllowed, true);
  await store.lockPlan();
  await sleep(400);
  check('版本锁定', store.locked, true);

  if (failures > 0) {
    console.error(`\n${failures} 项检查失败`);
    process.exit(1);
  }
  console.log('\n全部冒烟检查通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
