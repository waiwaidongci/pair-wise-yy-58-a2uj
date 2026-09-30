<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore } from './store';
import { PARAM_LABELS, PARAM_UNITS, type ParamKey } from './domain';
import type { RuleConflict } from './rules';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
const handlingNotes = reactive<Record<string, string>>({});
const commentDeps = ref<ParamKey[]>(['loadRate', 'clearance', 'wind']);
let renderer: THREE.WebGLRenderer | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let theta = 0.8;
let phi = 0.9;
let dragging = false;
let previousX = 0;

const nav = [
  { path: '/', label: '三维复核', icon: 'view_in_ar' },
  { path: '/models', label: '模型与参数', icon: 'tune' },
  { path: '/checks', label: '冲突与评论', icon: 'rule' },
  { path: '/review', label: '多角色会签', icon: 'fact_check' }
];

const depOptions = Object.entries(PARAM_LABELS).map(([value, label]) => ({ value: value as ParamKey, label }));

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');
const selectedDirty = computed(() => store.localDirtySteps.has(store.selectedStepId));
const pendingQueue = computed(() => store.queue.filter((item) => item.status !== 'done'));
const gateReasons = computed(() => store.gateReasons);

const stateMeta: Record<string, { label: string; color: string }> = {
  valid: { label: '已签署', color: 'positive' },
  invalid: { label: '签署失效', color: 'negative' },
  syncing: { label: '同步中', color: 'warning' },
  missing: { label: '待签署', color: 'grey' }
};

const requestStatusMeta: Record<string, string> = {
  pending: '待联网发送',
  syncing: '同步中…',
  failed: '发送失败',
  done: '已完成'
};

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function toggleCommentDep(param: ParamKey) {
  if (commentDeps.value.includes(param)) commentDeps.value = commentDeps.value.filter((item) => item !== param);
  else commentDeps.value = [...commentDeps.value, param];
}

function stepComments(stepId: string) {
  return store.comments.filter((comment) => comment.stepId === stepId);
}

function submitComment() {
  store.addComment(commentText.value, commentDeps.value);
  commentText.value = '';
}

function submitHandling(conflict: RuleConflict) {
  const note = handlingNotes[conflict.id]?.trim();
  if (!note) return;
  store.handleConflict(conflict.id, note);
  handlingNotes[conflict.id] = '';
}

function saveStep() {
  if (store.locked) {
    store.pushNotice('warn', '当前版本已锁定发布', '如需修改请先在会签页解锁（演示）。');
    return;
  }
  store.saveStep();
}

function initializeScene() {
  if (!canvasRef.value || !sceneContainer.value) return;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce6e1');
  scene.fog = new THREE.Fog('#dce6e1', 34, 78);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.HemisphereLight('#eefaf5', '#273b34', 2.3));
  const sun = new THREE.DirectionalLight('#fff4d6', 3.2);
  sun.position.set(14, 28, 18);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 44),
    new THREE.MeshStandardMaterial({ color: '#b8c7bf', roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 30, '#80948a', '#a8b8b0');
  grid.position.y = 0.02;
  scene.add(grid);

  const steel = new THREE.MeshStandardMaterial({ color: '#ec7a3c', roughness: 0.48, metalness: 0.35 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: '#2d5c4f', roughness: 0.58, metalness: 0.42 });
  const truss = new THREE.Group();
  const chordGeometry = new THREE.BoxGeometry(18, 1.1, 1.1);
  for (const z of [-3.5, 3.5]) {
    for (const y of [4.2, 8.4]) {
      const chord = new THREE.Mesh(chordGeometry, steel);
      chord.position.set(0, y, z);
      truss.add(chord);
    }
  }
  for (let x = -8; x <= 8; x += 2) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.8, 0.34), steel);
    brace.position.set(x, 6.2, -3.5);
    brace.rotation.z = x % 4 === 0 ? 0.36 : -0.36;
    truss.add(brace);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 7), darkSteel);
    cross.position.set(x, 4.2, 0);
    truss.add(cross);
  }
  truss.position.set(0, 6.5, 2);
  scene.add(truss);

  const crane = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 5), darkSteel);
  base.position.y = 0.6;
  crane.add(base);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 2.7, 3), new THREE.MeshStandardMaterial({ color: '#d8a733' }));
  cabin.position.set(-1, 2.5, 0);
  crane.add(cabin);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 24, 1.2), darkSteel);
  mast.position.y = 12;
  crane.add(mast);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 36), steel);
  boom.position.set(-8.5, 20.5, 9.5);
  boom.rotation.set(-0.38, 0.7, 0.14);
  crane.add(boom);
  crane.position.set(-15, 0, -12);
  scene.add(crane);

  const obstacleMat = new THREE.MeshStandardMaterial({ color: '#d34c45', transparent: true, opacity: 0.38 });
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 4), obstacleMat);
  obstacle.position.set(10, 2.5, 8);
  scene.add(obstacle);
  scene.add(new THREE.BoxHelper(obstacle, '#a92d2a'));

  const updateCamera = () => {
    const radius = 48;
    camera.position.set(
      Math.sin(theta) * Math.sin(phi) * radius,
      Math.cos(phi) * radius + 12,
      Math.cos(theta) * Math.sin(phi) * radius
    );
    camera.lookAt(0, 7, 0);
  };

  const render = () => {
    frame = requestAnimationFrame(render);
    truss.position.y = 6.5 + Math.sin(Date.now() / 900) * 0.08;
    updateCamera();
    renderer?.render(scene, camera);
  };
  render();

  const resize = () => {
    if (!sceneContainer.value || !renderer) return;
    const { width, height } = sceneContainer.value.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sceneContainer.value);
  resize();

  canvasRef.value.onpointerdown = (event) => {
    dragging = true;
    previousX = event.clientX;
    canvasRef.value?.setPointerCapture(event.pointerId);
  };
  canvasRef.value.onpointermove = (event) => {
    if (!dragging) return;
    theta += (event.clientX - previousX) * 0.006;
    previousX = event.clientX;
  };
  canvasRef.value.onpointerup = () => {
    dragging = false;
  };
}

onMounted(() => {
  nextTick(initializeScene);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
});
</script>

<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <q-header elevated class="topbar">
      <q-toolbar>
        <div class="brand-mark">LIFT</div>
        <div class="brand-copy">
          <strong>大型构件吊装三维校核</strong>
          <span>东塔转换桁架 · 方案版本 V{{ store.revision }}</span>
        </div>
        <q-space />
        <q-btn-toggle
          :model-value="store.online ? 'online' : 'offline'"
          dense
          no-caps
          toggle-color="primary"
          color="white"
          :options="[
            { label: '在线', value: 'online' },
            { label: '断网', value: 'offline' }
          ]"
          @update:model-value="(v) => store.setOnline(v === 'online')"
        />
        <q-btn dense flat no-caps icon="sync" label="拉取当前版本" class="header-link" @click="store.pullCurrent" />
        <q-btn dense flat no-caps icon="restart_alt" label="重置演示" class="header-link" @click="store.resetDemo" />
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知">
          <q-badge floating color="red">{{ store.notices.length }}</q-badge>
        </q-btn>
      </q-toolbar>
      <div v-if="store.notices.length" class="notice-strip">
        <div v-for="notice in store.notices.slice(0, 3)" :key="notice.id" class="notice-item" :class="notice.kind">
          <q-icon :name="{ info: 'info', success: 'check_circle', warn: 'warning', error: 'error' }[notice.kind]" />
          <div class="notice-body">
            <strong>{{ notice.title }}</strong>
            <span>{{ notice.text }}</span>
          </div>
          <q-btn dense flat round size="sm" icon="close" @click="store.dismissNotice(notice.id)" />
        </div>
      </div>
    </q-header>

    <q-drawer show-if-above side="left" :width="232" bordered class="left-nav">
      <div class="drawer-section-label">方案工作区</div>
      <q-list padding>
        <q-item
          v-for="item in nav"
          :key="item.path"
          clickable
          :active="route.path === item.path"
          active-class="nav-active"
          @click="go(item.path)"
        >
          <q-item-section avatar><q-icon :name="item.icon" /></q-item-section>
          <q-item-section>{{ item.label }}</q-item-section>
          <q-item-section v-if="item.path === '/checks'" side>
            <q-badge color="negative">{{ store.openConflicts.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon :name="store.online ? 'cloud_done' : 'cloud_off'" :color="store.online ? 'teal' : 'orange-9'" />
        <span>
          {{ store.online ? '在线协同 · 修改按步骤合并' : `断网中 · ${pendingQueue.length} 个请求保留在现场` }}
          <br /><small>本地草稿自动保存 {{ new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small>
        </span>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="workspace-page">
        <header class="page-heading">
          <div>
            <div class="eyebrow">LP-2026-0918 / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '版本已锁定' : '确认并锁定'"
              :disable="store.locked || !store.releaseAllowed"
              @click="store.lockPlan"
            />
            <q-btn v-if="store.locked" outline color="warning" no-caps icon="lock_open" label="解锁（演示）" @click="store.unlockPlan" />
          </div>
        </header>

        <q-banner v-if="!store.releaseAllowed && !store.locked" class="gate-banner" rounded>
          <template #avatar><q-icon name="block" color="negative" /></template>
          发布入口已锁定：失效内容未清完前不能放行。退回原因：{{ gateReasons.join('；') }}
        </q-banner>

        <section v-if="route.path === '/' || route.path === '/models'" class="work-grid">
          <article class="scene-panel content-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">THREE.JS SCENE</span>
                <h2>吊装姿态与空间冲突</h2>
              </div>
              <div class="view-bookmarks">
                <button
                  v-for="bookmark in store.viewBookmarks"
                  :key="bookmark"
                  :class="{ active: store.activeBookmark === bookmark }"
                  @click="store.setBookmark(bookmark)"
                >
                  {{ bookmark }}
                </button>
              </div>
            </div>
            <div ref="sceneContainer" class="scene-container">
              <canvas ref="canvasRef" aria-label="吊装三维场景" />
              <div class="scene-legend">
                <span><i class="legend-dot crane" />主吊</span>
                <span><i class="legend-dot load" />构件</span>
                <span><i class="legend-dot risk" />障碍物</span>
              </div>
              <div class="scene-hint">拖动旋转视角 · 滚轮缩放由设备手势控制</div>
            </div>
            <div class="timeline">
              <button
                v-for="step in store.steps"
                :key="step.id"
                class="timeline-step"
                :class="[step.status, { selected: store.selectedStepId === step.id }]"
                @click="store.selectStep(step.id)"
              >
                <span>{{ step.time }}<i v-if="store.localDirtySteps.has(step.id)" class="dirty-dot" title="有未同步修改" /></span>
                <strong>{{ step.title }}</strong>
                <small>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空</small>
              </button>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title}}</h2>
              </div>
              <q-badge v-if="selectedDirty" color="orange" outline>未同步</q-badge>
            </div>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: store.selectedStep.loadRate > 90 }">{{ store.selectedStep.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: store.selectedStep.clearance < 1.5 }">{{ store.selectedStep.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ store.selectedStep.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ store.selectedStep.wind }}m/s</strong></div>
            </div>
            <q-banner v-if="store.locked" dense rounded class="locked-banner">
              <template #avatar><q-icon name="lock" color="warning" /></template>
              当前版本已锁定，参数不可修改。
            </q-banner>
            <label class="field-label">荷载率<small>变化后只重算荷载类冲突、依赖意见与相关签署</small></label>
            <q-slider v-model="store.selectedStep.loadRate" :min="0" :max="120" color="primary" :disable="store.locked" />
            <div class="form-row">
              <q-input v-model.number="store.selectedStep.clearance" type="number" label="最小净空 / m" outlined dense :disable="store.locked" />
              <q-input v-model.number="store.selectedStep.wind" type="number" label="风速 / m/s" outlined dense :disable="store.locked" />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              :model-value="store.selectedStep.status"
              spread
              no-caps
              toggle-color="primary"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
              @update:model-value="store.setStepStatus"
            />
            <q-input
              :model-value="store.selectedStep.note"
              type="textarea"
              autogrow
              outlined
              label="现场控制说明"
              class="note-input"
              @update:model-value="(value: string | number | null) => store.setStepNote(String(value ?? ''))"
            />
            <q-btn class="save-step" color="primary" no-caps icon="save" label="保存步骤修改（触发依赖失效与重算）" @click="saveStep" />
            <q-btn flat dense no-caps size="sm" icon="wifi_tethering_error" class="demo-link" label="演示：他端在线改了 S-02 净空（用于制造合并失败）" @click="store.simulateRemoteChange" />

            <div v-if="pendingQueue.length" class="queue-panel">
              <h3><q-icon name="pending_actions" /> 现场请求队列 · {{ pendingQueue.length }}</h3>
              <div v-for="request in pendingQueue" :key="request.id" class="queue-item">
                <template v-if="request.kind === 'stepPatch'">
                  <div class="queue-head">
                    <strong>{{ request.stepId }} 参数修改</strong>
                    <q-badge :color="request.conflicts ? 'negative' : request.status === 'failed' ? 'negative' : request.status === 'syncing' ? 'primary' : 'orange'">
                      {{ request.conflicts ? '合并失败' : requestStatusMeta[request.status] }}
                    </q-badge>
                  </div>
                  <p class="queue-patch">
                    <span v-for="(value, key) in request.patch" :key="key">{{ PARAM_LABELS[key as ParamKey] }} → {{ value }}{{ PARAM_UNITS[key as ParamKey] }}　</span>
                  </p>
                  <div v-if="request.conflicts" class="merge-box">
                    <p v-for="conflict in request.conflicts" :key="conflict.param">
                      <q-icon name="compare_arrows" color="negative" />
                      {{ PARAM_LABELS[conflict.param] }}：现场 {{ conflict.local }}{{ PARAM_UNITS[conflict.param] }} ／ 他端已改为 {{ conflict.server }}{{ PARAM_UNITS[conflict.param] }}（同步基准 {{ conflict.base }}{{ PARAM_UNITS[conflict.param] }}）
                    </p>
                    <div class="merge-actions">
                      <q-btn dense no-caps color="primary" icon="save" label="保留现场值并重试原请求" @click="store.retryKeepingLocal(request.id)" />
                      <q-btn dense no-caps outline icon="download_done" label="采用当前版本值" @click="store.acceptServerVersion(request.id)" />
                    </div>
                  </div>
                  <q-btn v-else-if="request.status === 'failed'" dense flat no-caps size="sm" icon="refresh" label="重试原请求" @click="store.retryRequest(request.id)" />
                </template>
                <template v-else>
                  <div class="queue-head">
                    <strong>{{ store.reviewerName(request.reviewerId!) }} 的会签批次</strong>
                    <q-badge color="orange">{{ requestStatusMeta[request.status] }}</q-badge>
                  </div>
                  <q-btn v-if="request.status === 'failed'" dense flat no-caps size="sm" icon="refresh" label="重试批次" @click="store.retryRequest(request.id)" />
                </template>
              </div>
            </div>
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE</span>
              <h2>冲突定位与条件清单</h2>
            </div>
            <div class="heading-counts">
              <q-badge color="negative">{{ store.openConflicts.length }} 项待处理</q-badge>
              <q-badge color="warning" outline>{{ store.openComments.length }} 条未关闭意见</q-badge>
              <q-badge color="grey-7" outline>{{ store.invalidComments.length }} 条失效待重核</q-badge>
            </div>
          </div>
          <div class="check-layout">
            <div class="conflict-list">
              <button v-for="item in store.conflicts" :key="item.id" class="conflict-item" :class="{ handled: item.handling }" @click="store.selectStep(item.stepId)">
                <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                <div>
                  <strong>{{ item.stepId }} · {{ item.title }}</strong>
                  <small>{{ item.message }}</small>
                  <small class="conflict-detail">{{ item.detail }}</small>
                  <small class="conflict-deps">关联参数：{{ item.deps.map((d) => PARAM_LABELS[d]).join('、') }}（只在这些参数变化时重算）</small>
                  <template v-if="item.handling">
                    <small class="handling-note">现场处置：{{ item.handling.note }}（{{ item.handling.by }} · {{ formatTime(item.handling.at) }}）</small>
                    <span class="handling-actions" @click.stop>
                      <q-btn dense flat no-caps size="xs" icon="undo" label="撤销处置（退回阻断）" @click="store.reopenConflict(item.id)" />
                    </span>
                  </template>
                </div>
                <q-icon name="arrow_forward" />
              </button>
              <div v-for="item in store.conflicts.filter(c => !c.handling)" :key="`${item.id}-form`" class="handling-form" @click.stop>
                <q-input
                  v-model="handlingNotes[item.id]"
                  dense
                  outlined
                  :placeholder="`为 ${item.stepId} 填写现场处置（迁移障碍/降载/等待风窗…），处置后不计入阻断`"
                >
                  <template #append>
                    <q-btn dense flat icon="task_alt" label="登记处置" @click="submitHandling(item)" />
                  </template>
                </q-input>
              </div>
              <div v-if="store.conflicts.length === 0" class="empty-state">当前版本未发现规则冲突。</div>

              <div v-if="pendingQueue.length" class="queue-panel checks-queue">
                <h3><q-icon name="pending_actions" /> 现场请求队列 · {{ pendingQueue.length }}</h3>
                <div v-for="request in pendingQueue" :key="request.id" class="queue-item">
                  <template v-if="request.kind === 'stepPatch'">
                    <div class="queue-head">
                      <strong>{{ request.stepId }} 参数修改</strong>
                      <q-badge :color="request.conflicts ? 'negative' : 'orange'">{{ request.conflicts ? '合并失败' : requestStatusMeta[request.status] }}</q-badge>
                    </div>
                    <div v-if="request.conflicts" class="merge-box">
                      <p v-for="conflict in request.conflicts" :key="conflict.param">
                        {{ PARAM_LABELS[conflict.param] }}：现场 {{ conflict.local }}{{ PARAM_UNITS[conflict.param] }} ／ 他端 {{ conflict.server }}{{ PARAM_UNITS[conflict.param] }}
                      </p>
                      <div class="merge-actions">
                        <q-btn dense no-caps color="primary" label="保留现场并重试" @click="store.retryKeepingLocal(request.id)" />
                        <q-btn dense no-caps outline label="采用当前版本" @click="store.acceptServerVersion(request.id)" />
                      </div>
                    </div>
                    <q-btn v-else-if="request.status === 'failed'" dense flat no-caps size="sm" icon="refresh" label="重试" @click="store.retryRequest(request.id)" />
                  </template>
                  <template v-else>
                    <div class="queue-head">
                      <strong>{{ store.reviewerName(request.reviewerId!) }} 的会签批次</strong>
                      <q-badge color="orange">{{ requestStatusMeta[request.status] }}</q-badge>
                    </div>
                    <q-btn v-if="request.status === 'failed'" dense flat no-caps size="sm" icon="refresh" label="重试批次" @click="store.retryRequest(request.id)" />
                  </template>
                </div>
              </div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStep.id }}</h3>
              <div v-for="comment in stepComments(store.selectedStepId)" :key="comment.id" class="comment-row" :class="comment.status">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ comment.role }}</small></strong>
                  <q-badge v-if="comment.deps.length" dense class="dep-badge" color="blue-grey" outline>
                    关联：{{ comment.deps.map((d) => PARAM_LABELS[d]).join('、') }}
                  </q-badge>
                  <p>{{ comment.content }}</p>
                  <button v-if="comment.status === 'open'" @click="store.resolveComment(comment.id)">标记已解决</button>
                  <template v-else-if="comment.status === 'resolved'">
                    <span class="resolved">已解决</span>
                  </template>
                  <template v-else>
                    <span class="invalidated">
                      <q-icon name="history_toggle_off" color="negative" />
                      已失效：关联参数{{ PARAM_LABELS[comment.invalidReason!.param] }}由 {{ comment.invalidReason!.from }}{{ PARAM_UNITS[comment.invalidReason!.param] }} 改为 {{ comment.invalidReason!.to }}{{ PARAM_UNITS[comment.invalidReason!.param] }}，请按新参数重核
                    </span>
                    <button class="recheck" @click="store.recheckComment(comment.id)">按当前参数重新核对（退回未关闭）</button>
                  </template>
                </div>
              </div>
              <div v-if="stepComments(store.selectedStepId).length === 0" class="empty-state">该步骤暂无意见。</div>
              <label class="field-label">本意见关联的工况参数（仅这些参数变化时失效）</label>
              <div class="dep-picker">
                <button
                  v-for="option in depOptions"
                  :key="option.value"
                  type="button"
                  :class="{ active: commentDeps.includes(option.value) }"
                  @click="toggleCommentDep(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" class="comment-submit" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="review-tools">
              <q-btn outline no-caps icon="groups" label="演示：两人同版本同时提交（只收一次）" @click="store.simulateConcurrentSignoff" />
              <q-btn outline no-caps icon="sync" label="拉取当前版本" @click="store.pullCurrent" />
              <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
            </div>
          </div>
          <div class="review-grid">
            <article v-for="person in store.reviewers" :key="person.id" class="review-card" :class="store.reviewerState(person.id)">
              <div class="review-head">
                <strong>{{ person.name }}</strong>
                <q-badge :color="stateMeta[store.reviewerState(person.id)].color">{{ stateMeta[store.reviewerState(person.id)].label }}</q-badge>
              </div>
              <span>{{ person.team }}</span>
              <p>{{ person.scope }}</p>
              <small class="reviewer-deps">签署依据：{{ person.deps.map((d) => PARAM_LABELS[d]).join('、') }}</small>
              <q-btn
                v-if="store.reviewerState(person.id) === 'missing'"
                outline
                color="primary"
                no-caps
                label="接受方案并签署"
                :disable="store.locked"
                @click="store.submitSignoff(person.id)"
              />
              <q-btn v-else-if="store.reviewerState(person.id) === 'syncing'" outline no-caps label="批次同步中…" disable />
              <q-btn v-else-if="store.reviewerState(person.id) === 'invalid'" unelevated color="negative" no-caps icon="published_with_changes" label="按当前版本重签" @click="store.rebaseSignoff(person.id)" />
              <q-btn v-else unelevated color="positive" no-caps label="已签署（V{{ store.signoffById[person.id].revision }}）" disable />
              <div v-if="store.reviewerState(person.id) === 'invalid'" class="signoff-diffs">
                <span>失效依据（参数已变）：</span>
                <p v-for="diff in store.signoffDiffs(store.signoffById[person.id])" :key="`${diff.stepId}-${diff.param}`">
                  {{ diff.stepId }} {{ PARAM_LABELS[diff.param] }}：签署时 {{ diff.from }}{{ PARAM_UNITS[diff.param] }} → 当前 {{ diff.to }}{{ PARAM_UNITS[diff.param] }}
                </p>
              </div>
            </article>
          </div>

          <div v-if="store.packets.length" class="packet-log">
            <h3>会签批次记录</h3>
            <div v-for="packet in store.packets.slice(0, 6)" :key="packet.batchId" class="packet-row" :class="{ deduped: packet.deduped }">
              <q-icon :name="packet.deduped ? 'content_copy' : 'fact_check'" :color="packet.deduped ? 'warning' : 'positive'" />
              <div>
                <strong>{{ packet.reviewerName }}</strong>
                <span>{{ packet.summary }} · V{{ packet.revision }} · {{ formatTime(packet.at) }}</span>
                <small v-if="packet.deduped">
                  同版本同批内容，服务端只收取一次；本批内容保留，当前版本由
                  {{ (packet.acceptedBy ?? '').split(',').map((id) => store.reviewerName(id)).join('、') }}
                  先提交
                </small>
              </div>
            </div>
          </div>

          <div class="release-gate" :class="{ blocked: !store.releaseAllowed && !store.locked }">
            <div class="gate-info">
              <q-icon :name="store.locked ? 'lock' : gateReasons.length ? 'gpp_bad' : 'verified_user'" size="30px" />
              <div>
                <strong>{{ store.locked ? `V${store.revision} 已锁定发布` : gateReasons.length ? '发布前门禁未通过（退回原因）' : '发布前门禁已满足' }}</strong>
                <span v-if="store.locked">冲突清零、意见关闭、四角色签署齐全，已完成发布。</span>
                <span v-else-if="gateReasons.length">
                  <i v-for="(reason, index) in gateReasons" :key="index">{{ index + 1 }}. {{ reason }}<br /></i>
                </span>
                <span v-else>冲突清零（含现场处置确认）、意见全部关闭或重核、四个角色签署均对当前版本有效。</span>
              </div>
            </div>
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '已发布' : '锁定并发布 V' + (store.revision + 1)"
              :disable="store.locked || !store.releaseAllowed"
              @click="store.lockPlan"
            />
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
