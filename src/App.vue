<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore } from './store';
import { PARAM_LABELS, ParamKey } from './domain';
import { useQuasar } from 'quasar';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const $q = useQuasar();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
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

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');

const staleBanner = computed(() => {
  const parts: string[] = [];
  if (store.staleConflicts.length) parts.push(`${store.staleConflicts.length} 项冲突待重算`);
  if (store.staleComments.length) parts.push(`${store.staleComments.length} 条意见待确认`);
  if (store.staleSignatures.length) parts.push(`${store.staleSignatures.length} 个签署待重签`);
  return parts;
});

const firstUnsignedRole = computed(() => store.signatures.find((s) => s.status !== 'signed')?.role ?? '');

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function submitComment() {
  store.addComment(commentText.value);
  commentText.value = '';
}

function paramLabel(key: ParamKey) {
  return PARAM_LABELS[key];
}

function titleOf(stepId: string) {
  return store.steps.find((s) => s.id === stepId)?.title ?? stepId;
}

function lockAndReport() {
  const result = store.lockPlan();
  if (result.locked) {
    $q.notify({ type: 'positive', message: `已锁定并发布 V${store.revision}`, icon: 'lock' });
  } else {
    $q.notify({ type: 'warning', message: `发布被退回：${result.reasons.length} 项未清完`, icon: 'warning', timeout: 4000 });
  }
}

function toggleNetwork() {
  if (store.networkStatus === 'online') {
    store.goOffline();
    $q.notify({ type: 'info', message: '已断网，修改将按步骤合并，联网后自动同步', icon: 'cloud_off' });
  } else {
    store.goOnline();
    $q.notify({ type: 'positive', message: '已联网，开始按步骤合并同步', icon: 'cloud_sync' });
  }
}

/** 模拟两名复核人同时提交同一版本：只收一次，后到者保留本批内容并看到当前版本 */
function simulateConcurrentSubmit() {
  const role = firstUnsignedRole.value || '设备';
  const baseRevision = store.revision;
  const r1 = store.submitReview(role, '复核人甲：同意按当前版本实施', baseRevision);
  const r2 = store.submitReview(role, '复核人乙：同意按当前版本实施', baseRevision);
  if (r1.accepted && !r2.accepted) {
    $q.notify({
      type: 'warning',
      message: `${role} 会签：${r1.name} 已收，后到的 ${r2.name} 判重（本批内容已保留，当前版本 V${r2.currentRevision}）`,
      icon: 'fact_check',
      timeout: 5000
    });
  } else if (r1.accepted) {
    $q.notify({ type: 'positive', message: `${role} 已签署`, icon: 'fact_check' });
  } else {
    $q.notify({ type: 'info', message: `${role} 该版本已签署，后到提交已判重并保留`, icon: 'info' });
  }
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
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知">
          <q-badge floating color="red">{{ store.openComments.length + store.staleConflicts.length }}</q-badge>
        </q-btn>
      </q-toolbar>
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
            <q-badge color="negative">{{ store.conflicts.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon :name="store.networkStatus === 'online' ? 'cloud_done' : 'cloud_off'" :color="store.networkStatus === 'online' ? 'teal' : 'orange'" />
        <span>
          {{ store.networkStatus === 'online' ? '草稿已自动保存' : '断网修改待合并' }}<br />
          <small>{{ new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small>
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
            <q-btn
              outline
              no-caps
              :icon="store.networkStatus === 'online' ? 'cloud_off' : 'cloud_sync'"
              :label="store.networkStatus === 'online' ? '断网模拟' : '联网同步'"
              @click="toggleNetwork"
            />
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn color="primary" no-caps icon="lock" :label="store.locked ? '版本已锁定' : '确认并锁定'" :disable="store.locked || store.releaseBlocked" @click="lockAndReport" />
          </div>
        </header>

        <!-- 失效退回横幅 -->
        <q-banner v-if="staleBanner.length" class="stale-banner" rounded dense>
          <template #avatar>
            <q-icon name="warning" color="orange" />
          </template>
          <strong>参数已变更，{{ staleBanner.join('、') }}，清零后方可发布。</strong>
          <template #action>
            <q-btn color="primary" flat no-caps label="一键重算冲突" @click="store.recalculateAll" />
          </template>
        </q-banner>

        <!-- 断网合并状态 -->
        <q-banner v-if="store.networkStatus === 'offline' || store.offlineStatus === 'failed'" class="offline-banner" rounded dense>
          <template #avatar>
            <q-icon name="cloud_off" :color="store.offlineStatus === 'failed' ? 'red' : 'orange'" />
          </template>
          <div v-if="store.offlineStatus !== 'failed'">
            <strong>当前断网：</strong>修改按步骤合并（{{ store.pendingOfflineCount }} 批待同步），联网后自动提交。
          </div>
          <div v-else>
            <strong>合并失败（现场已保留）：</strong>步骤 {{ store.conflictStepIds.join('、') }} 的服务端版本在断网期间被改动，本地修改未丢弃，可重试或强制合并。
          </div>
          <template #action>
            <q-btn v-if="store.offlineStatus === 'failed'" color="primary" flat no-caps label="重试原请求" @click="store.retryOffline" />
            <q-btn v-if="store.offlineStatus === 'failed'" color="negative" flat no-caps label="强制合并(本地优先)" @click="store.forceOfflineMerge" />
          </template>
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
                v-for="(step, index) in store.steps"
                :key="step.id"
                class="timeline-step"
                :class="[step.status, { selected: store.selectedStepId === step.id }]"
                @click="store.selectStep(step.id)"
              >
                <span>{{ step.time }}</span>
                <strong>{{ step.title }}</strong>
                <small>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空</small>
              </button>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title }}</h2>
              </div>
            </div>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: store.selectedStep.loadRate > 90 }">{{ store.selectedStep.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: store.selectedStep.clearance < 1.5 }">{{ store.selectedStep.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ store.selectedStep.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ store.selectedStep.wind }}m/s</strong></div>
            </div>
            <label class="field-label">荷载率 <span class="field-hint">变更后依赖该参数的冲突/意见/签署将失效重算</span></label>
            <q-slider v-model="store.selectedStep.loadRate" :min="0" :max="120" color="primary" />
            <div class="form-row">
              <q-input v-model.number="store.selectedStep.clearance" type="number" label="最小净空 / m" outlined dense />
              <q-input v-model.number="store.selectedStep.wind" type="number" label="风速 / m/s" outlined dense />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              v-model="store.selectedStep.status"
              spread
              no-caps
              toggle-color="primary"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
            />
            <q-input v-model="store.selectedStep.note" type="textarea" autogrow outlined label="现场控制说明" class="note-input" />
            <q-btn class="save-step" color="primary" no-caps icon="save" label="保存步骤修改" @click="store.updateStep({})" />
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE</span>
              <h2>冲突定位与条件清单</h2>
            </div>
            <div class="heading-actions">
              <q-btn outline no-caps icon="refresh" label="一键重算所有冲突" @click="store.recalculateAll" />
              <q-badge color="negative">{{ store.conflicts.length }} 项待处理</q-badge>
            </div>
          </div>
          <div class="check-layout">
            <div class="conflict-list">
              <div v-for="item in store.conflicts" :key="item.id" class="conflict-item" :class="{ stale: item.status === 'stale' }">
                <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                <div class="conflict-body" @click="store.selectStep(item.stepId)">
                  <strong>{{ item.stepId }} · {{ titleOf(item.stepId) }}</strong><small>{{ item.message }}</small>
                  <small v-if="item.status === 'stale'" class="stale-tag">参数变更失效 · 待重算</small>
                </div>
                <q-btn v-if="item.status === 'stale'" flat color="primary" no-caps label="重算" @click.stop="store.recalculateConflict(item.id)" />
                <q-icon v-else name="arrow_forward" />
              </div>
              <div v-if="store.conflicts.length === 0" class="empty-state">当前版本未发现规则冲突。</div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStep.id }}</h3>
              <div v-for="comment in store.comments.filter(c => c.stepId === store.selectedStepId)" :key="comment.id" class="comment-row" :class="{ stale: comment.stale }">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ comment.role }}</small></strong>
                  <p>{{ comment.content }}</p>
                  <small v-if="comment.parameter" class="param-tag">依赖参数 · {{ paramLabel(comment.parameter) }}</small>
                  <small v-if="comment.stale" class="stale-tag">参数变更失效 · 待确认</small>
                  <div class="comment-actions">
                    <button v-if="comment.status === 'open' && comment.stale" @click="store.confirmComment(comment.id)">重新确认</button>
                    <button v-if="comment.status === 'open'" @click="store.resolveComment(comment.id)">标记已解决</button>
                    <span v-if="comment.status === 'resolved'" class="resolved">已解决</span>
                  </div>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="heading-actions">
              <q-btn outline no-caps icon="group" label="模拟双人同时会签" @click="simulateConcurrentSubmit" />
              <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
            </div>
          </div>
          <div class="review-grid">
            <article v-for="person in store.signatures" :key="person.id" class="review-card" :class="{ stale: person.stale }">
              <div class="review-head">
                <strong>{{ person.name }}</strong>
                <q-badge v-if="person.stale" color="warning">待重签</q-badge>
                <q-badge v-else :color="person.status === 'signed' ? 'positive' : 'grey'">{{ person.status === 'signed' ? '已签署' : '待确认' }}</q-badge>
              </div>
              <span>{{ person.team }}</span>
              <p>{{ person.scope }}</p>
              <small class="scope-params">负责参数：<template v-if="person.parameters.length">{{ person.parameters.map(paramLabel).join('、') }}</template><template v-else>—</template></small>
              <q-btn v-if="person.stale" color="warning" no-caps label="重新签署" @click="store.resignSignature(person.role)" />
              <q-btn v-else-if="person.status !== 'signed'" outline no-caps label="接受方案" @click="store.submitReview(person.role, '同意按当前版本实施', store.revision)" />
              <q-btn v-else disable no-caps :label="person.signedAt ? '已签署 ' + new Date(person.signedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '已签署'" />
            </article>
          </div>

          <!-- 后到者保留的本批内容 -->
          <div v-if="store.rejectedBatches.length" class="rejected-panel">
            <h3>未受理会签（本批内容已保留）</h3>
            <div v-for="r in store.rejectedBatches" :key="r.id" class="rejected-row">
              <q-icon name="info" color="warning" />
              <div>
                <strong>{{ r.name }} · {{ r.role }}</strong>
                <small>提交版本 V{{ r.baseRevision }} · 当前版本 V{{ r.currentRevision }}</small>
                <p>{{ r.content }}</p>
                <small class="stale-tag">{{ r.reason === 'duplicate' ? '该版本已由 ' + r.signedBy + ' 签署，只收一次' : '版本已过期' }}</small>
              </div>
            </div>
          </div>

          <div class="release-gate" :class="{ blocked: store.releaseBlocked }">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <span v-if="!store.releaseBlocked">冲突清零、意见全部关闭、四个角色完成签署，可发布。</span>
                <span v-else>存在未清完的失效项，发布被退回：</span>
                <ul v-if="store.releaseBlocked" class="release-reasons">
                  <li v-for="(reason, i) in store.releaseReasons" :key="i">{{ reason }}</li>
                </ul>
              </div>
            </div>
            <q-btn color="primary" no-caps icon="lock" label="锁定并发布 V{{ store.revision + 1 }}" :disable="store.locked || store.releaseBlocked" @click="lockAndReport" />
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
