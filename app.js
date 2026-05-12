/* =========================================================
 * 間歇運動計時器 (Firebase 雲端版)
 * 多群組結構：state.groups[]，每組 { name, stages, rounds }
 * 未登入：localStorage；登入後：Firestore，跨裝置同步
 * ========================================================= */
import {
  signIn, signOut, onAuthChange,
  loadSettings, saveSettings, logWorkout, listWorkouts, deleteWorkout
} from "./firebase.js";

// ---------- 常數 ----------
const COLORS = [
  "#ff453a", "#ff9500", "#ffd60a", "#34c759",
  "#5ac8fa", "#007aff", "#5856d6", "#af52de",
  "#ff2d55", "#a2845e", "#8e8e93", "#30d158"
];
const DEFAULT_REST_DURATION = 15;
const REST_COLOR = "#5ac8fa";

function defaultGroup(id = 1, name = "訓練") {
  return {
    id,
    name,
    rounds: 3,
    stages: [
      { id: 1, name: "高強度", duration: 30, color: "#ff453a", phase: "work" },
      { id: 2, name: "休息", duration: DEFAULT_REST_DURATION, color: REST_COLOR, phase: "rest" }
    ]
  };
}

const PRESETS = {
  tabata: {
    name: "Tabata",
    rounds: 8,
    stages: [
      { name: "全力", duration: 20, color: "#ff453a", phase: "work" },
      { name: "休息", duration: 10, color: REST_COLOR, phase: "rest" }
    ]
  },
  hiit: {
    name: "HIIT",
    rounds: 6,
    stages: [
      { name: "高強度", duration: 40, color: "#ff453a", phase: "work" },
      { name: "中強度", duration: 20, color: "#ff9500", phase: "work" },
      { name: "休息", duration: 30, color: REST_COLOR, phase: "rest" }
    ]
  },
  emom: {
    name: "EMOM",
    rounds: 10,
    stages: [
      { name: "動作", duration: 45, color: "#34c759", phase: "work" },
      { name: "休息", duration: 15, color: REST_COLOR, phase: "rest" }
    ]
  },
  warmup: {
    name: "熱身",
    rounds: 1,
    stages: [
      { name: "熱身", duration: 60, color: "#ff9500", phase: "warmup" },
      { name: "動態伸展", duration: 90, color: "#ffd60a", phase: "warmup" },
      { name: "啟動", duration: 30, color: "#34c759", phase: "work" }
    ]
  }
};

// ---------- 狀態 ----------
let state = {
  voice: true,
  sound: true,
  groups: [defaultGroup()]
};
let runtime = null;       // 訓練時 runtime
let editingStage = null;  // { groupId, stage }
let editingGroupId = null;
let user = null;
let runStartedAt = 0;

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const setupScreen = $("#setupScreen");
const runScreen = $("#runScreen");
const doneScreen = $("#doneScreen");
const historyScreen = $("#historyScreen");

const groupsContainer = $("#groupsContainer");
const addGroupBtn = $("#addGroupBtn");
const voiceToggle = $("#voiceToggle");
const soundToggle = $("#soundToggle");
const startBtn = $("#startBtn");
const historyBtn = $("#historyBtn");
const stageCount = $("#stageCount");
const totalDurationEl = $("#totalDuration");

const exitBtn = $("#exitBtn");
const pauseBtn = $("#pauseBtn");
const prevBtn = $("#prevBtn");
const nextBtn = $("#nextBtn");
const ringProgress = $("#ringProgress");
const timeRemainingEl = $("#timeRemaining");
const runStageNameEl = $("#runStageName");
const currentRoundEl = $("#currentRound");
const totalRoundsEl = $("#totalRounds");
const groupIndicatorEl = $("#groupIndicator");
const nextStageHintEl = $("#nextStageHint");

const doneSummary = $("#doneSummary");
const doneSaveStatus = $("#doneSaveStatus");
const doneBackBtn = $("#doneBackBtn");

const stageModal = $("#stageModal");
const stageNameInput = $("#stageNameInput");
const stageDurationInput = $("#stageDurationInput");
const colorPicker = $("#colorPicker");
const stageSaveBtn = $("#stageSaveBtn");
const stageCancelBtn = $("#stageCancelBtn");
const stageDeleteBtn = $("#stageDeleteBtn");
const stageDuplicateBtn = $("#stageDuplicateBtn");
const stageModalTitle = $("#stageModalTitle");

const signInBtn = $("#signInBtn");
const signOutBtn = $("#signOutBtn");
const userBadge = $("#userBadge");
const userAvatar = $("#userAvatar");
const userName = $("#userName");
const syncStatus = $("#syncStatus");

const historyBackBtn = $("#historyBackBtn");
const historyList = $("#historyList");
const historyEmpty = $("#historyEmpty");
const statCount = $("#statCount");
const statTotal = $("#statTotal");
const statStreak = $("#statStreak");
const statWeek = $("#statWeek");

// ---------- 資料 migration（舊版 stages/rounds → groups） ----------
function migrate(s) {
  if (!s) return null;
  if (Array.isArray(s.groups) && s.groups.length) return s; // 已是新格式
  if (Array.isArray(s.stages) && s.stages.length) {
    return {
      voice: s.voice ?? true,
      sound: s.sound ?? true,
      groups: [{
        id: 1,
        name: "訓練",
        rounds: s.rounds ?? 3,
        stages: s.stages.map((st, i) => ({ id: st.id ?? (i + 1), ...st }))
      }]
    };
  }
  return null;
}

// ---------- localStorage ----------
const STORAGE_KEY = "intervalTimer.fb.v1";
function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      voice: state.voice, sound: state.sound, groups: state.groups
    }));
  } catch (e) {}
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch (e) { return null; }
}

let saveDebounce = null;
function persist() {
  saveLocal();
  if (user) {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(async () => {
      try {
        showSync("同步中…");
        await saveSettings(user.uid, {
          voice: state.voice, sound: state.sound, groups: state.groups
        });
        showSync("已同步", true);
      } catch (e) {
        console.error(e);
        showSync("同步失敗");
      }
    }, 600);
  }
}
function showSync(msg, fade = false) {
  syncStatus.textContent = msg;
  syncStatus.classList.remove("hidden");
  if (fade) setTimeout(() => syncStatus.classList.add("hidden"), 1800);
}

// ---------- ID helpers ----------
function newGroupId() {
  return (state.groups.reduce((m, g) => Math.max(m, g.id || 0), 0) || 0) + 1;
}
function newStageId(group) {
  return (group.stages.reduce((m, s) => Math.max(m, s.id || 0), 0) || 0) + 1;
}
function ensureIds() {
  let gid = 0;
  state.groups.forEach(g => {
    if (!g.id) g.id = ++gid; else gid = Math.max(gid, g.id);
    let sid = 0;
    g.stages.forEach(s => {
      if (!s.id) s.id = ++sid; else sid = Math.max(sid, s.id);
    });
  });
}

// ---------- 初始化 ----------
async function init() {
  const saved = loadLocal();
  if (saved) state = { ...state, ...saved };
  ensureIds();
  hydrateUI();
  bindSetupEvents();
  bindRunEvents();
  bindModalEvents();
  bindAuth();
  bindHistory();
  buildColorPicker();

  if ("speechSynthesis" in window) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => {};
  }

  onAuthChange(async (u) => {
    user = u || null;
    if (u) {
      signInBtn.hidden = true;
      userBadge.hidden = false;
      userAvatar.src = u.photoURL || "";
      userAvatar.alt = u.displayName || "";
      userName.textContent = u.displayName || u.email || "已登入";
      try {
        showSync("讀取雲端設定…");
        const cloud = migrate(await loadSettings(u.uid));
        if (cloud && cloud.groups && cloud.groups.length) {
          state = cloud;
          ensureIds();
          hydrateUI();
          showSync("已載入雲端設定", true);
        } else {
          await saveSettings(u.uid, {
            voice: state.voice, sound: state.sound, groups: state.groups
          });
          showSync("已建立雲端備份", true);
        }
      } catch (e) {
        console.error(e);
        showSync("讀取失敗（用本地資料）");
      }
    } else {
      signInBtn.hidden = false;
      userBadge.hidden = true;
      showSync("");
    }
  });
}

function hydrateUI() {
  voiceToggle.checked = state.voice;
  soundToggle.checked = state.sound;
  renderGroups();
  updateTotals();
}

// ---------- 渲染 ----------
function renderGroups() {
  groupsContainer.innerHTML = "";
  state.groups.forEach(group => {
    groupsContainer.appendChild(renderGroup(group));
  });
}

function renderGroup(group) {
  const card = document.createElement("div");
  card.className = "group-card";
  card.dataset.groupId = group.id;

  // Header
  const header = document.createElement("div");
  header.className = "group-header";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "group-name";
  nameInput.value = group.name;
  nameInput.maxLength = 16;
  nameInput.placeholder = "群組名稱";
  nameInput.addEventListener("change", () => {
    group.name = nameInput.value.trim() || "群組";
    nameInput.value = group.name;
    persist();
  });
  header.appendChild(nameInput);

  // rounds stepper
  const rounds = document.createElement("div");
  rounds.className = "group-rounds";
  rounds.innerHTML = `
    <span>回合</span>
    <div class="stepper">
      <button class="stepper-btn" data-act="rounds-minus">−</button>
      <input type="number" min="1" max="99" value="${group.rounds}" inputmode="numeric" />
      <button class="stepper-btn" data-act="rounds-plus">＋</button>
    </div>
  `;
  const roundsInput = rounds.querySelector("input");
  rounds.querySelectorAll(".stepper-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      let v = +roundsInput.value;
      v = act === "rounds-plus" ? v + 1 : v - 1;
      group.rounds = clamp(v, 1, 99);
      roundsInput.value = group.rounds;
      persist();
      updateTotals();
    });
  });
  roundsInput.addEventListener("change", () => {
    group.rounds = clamp(+roundsInput.value || 1, 1, 99);
    roundsInput.value = group.rounds;
    persist();
    updateTotals();
  });
  header.appendChild(rounds);

  // 刪除群組（只在 >1 個群組時顯示）
  if (state.groups.length > 1) {
    const delBtn = document.createElement("button");
    delBtn.className = "group-delete-btn";
    delBtn.textContent = "✕";
    delBtn.title = "刪除群組";
    delBtn.addEventListener("click", () => {
      if (!confirm(`刪除群組「${group.name}」？`)) return;
      state.groups = state.groups.filter(g => g.id !== group.id);
      persist();
      renderGroups();
      updateTotals();
    });
    header.appendChild(delBtn);
  }

  card.appendChild(header);

  // Stages list
  const list = document.createElement("ul");
  list.className = "stages-list";
  group.stages.forEach(stage => {
    list.appendChild(renderStageItem(group, stage));
  });
  card.appendChild(list);

  // Actions
  const actions = document.createElement("div");
  actions.className = "group-stage-actions";
  actions.innerHTML = `
    <button class="add-stage">＋ 階段</button>
    <button class="rest-quick">＋ 休息 (${DEFAULT_REST_DURATION}s)</button>
  `;
  actions.querySelector(".add-stage").addEventListener("click", () => openStageModal(group, null));
  actions.querySelector(".rest-quick").addEventListener("click", () => {
    const id = newStageId(group);
    group.stages.push({
      id,
      name: "休息",
      duration: DEFAULT_REST_DURATION,
      color: REST_COLOR,
      phase: "rest"
    });
    persist();
    renderGroups();
    updateTotals();
  });
  card.appendChild(actions);

  return card;
}

function renderStageItem(group, stage) {
  const li = document.createElement("li");
  li.className = "stage-item";
  li.draggable = true;
  li.dataset.id = stage.id;
  li.dataset.groupId = group.id;
  li.innerHTML = `
    <span class="stage-color-dot" style="background:${stage.color}"></span>
    <span class="stage-name"></span>
    <span class="stage-time">${formatTime(stage.duration)}</span>
    <span class="stage-handle" aria-label="拖曳">⋮⋮</span>
  `;
  li.querySelector(".stage-name").textContent = stage.name;
  li.addEventListener("click", (e) => {
    if (e.target.classList.contains("stage-handle")) return;
    openStageModal(group, stage);
  });
  attachDragHandlers(li);
  return li;
}

function updateTotals() {
  let stagesN = 0;
  let totalSec = 0;
  state.groups.forEach(g => {
    stagesN += g.stages.length * g.rounds;
    totalSec += g.stages.reduce((s, st) => s + st.duration, 0) * g.rounds;
  });
  stageCount.textContent = stagesN;
  totalDurationEl.textContent = formatTime(totalSec);
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- 拖曳排序（同群組內） ----------
let dragSrc = null; // {groupId, stageId}
function attachDragHandlers(li) {
  li.addEventListener("dragstart", (e) => {
    dragSrc = { groupId: +li.dataset.groupId, stageId: +li.dataset.id };
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    $$(".stage-item").forEach(el => el.classList.remove("drag-over"));
    dragSrc = null;
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    li.classList.add("drag-over");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    li.classList.remove("drag-over");
    if (!dragSrc) return;
    const targetGroupId = +li.dataset.groupId;
    const targetStageId = +li.dataset.id;
    if (dragSrc.groupId !== targetGroupId) return; // 不跨群組
    if (dragSrc.stageId === targetStageId) return;
    const group = state.groups.find(g => g.id === targetGroupId);
    if (!group) return;
    const fromIdx = group.stages.findIndex(s => s.id === dragSrc.stageId);
    const toIdx = group.stages.findIndex(s => s.id === targetStageId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = group.stages.splice(fromIdx, 1);
    group.stages.splice(toIdx, 0, moved);
    persist();
    renderGroups();
    updateTotals();
  });
}

// ---------- 設定畫面事件 ----------
function bindSetupEvents() {
  voiceToggle.addEventListener("change", () => { state.voice = voiceToggle.checked; persist(); });
  soundToggle.addEventListener("change", () => { state.sound = soundToggle.checked; persist(); });

  addGroupBtn.addEventListener("click", () => {
    state.groups.push({
      id: newGroupId(),
      name: `群組 ${state.groups.length + 1}`,
      rounds: 3,
      stages: [
        { id: 1, name: "高強度", duration: 30, color: "#ff453a", phase: "work" },
        { id: 2, name: "休息", duration: DEFAULT_REST_DURATION, color: REST_COLOR, phase: "rest" }
      ]
    });
    persist();
    renderGroups();
    updateTotals();
  });

  startBtn.addEventListener("click", () => {
    const totalStages = state.groups.reduce((s, g) => s + g.stages.length, 0);
    if (totalStages === 0) { alert("請至少新增一個階段"); return; }
    unlockAudio();
    startRun();
  });

  historyBtn.addEventListener("click", openHistory);

  // Presets — 套用後變成單一群組
  document.querySelectorAll(".preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.preset;
      const p = PRESETS[key];
      if (!p) return;
      if (!confirm(`套用 ${btn.textContent} 預設？目前的設定會被覆蓋。`)) return;
      state.groups = [{
        id: 1,
        name: p.name,
        rounds: p.rounds,
        stages: p.stages.map((s, i) => ({ ...s, id: i + 1 }))
      }];
      persist();
      renderGroups();
      updateTotals();
    });
  });
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ---------- Stage Modal ----------
function openStageModal(group, stage) {
  editingGroupId = group ? group.id : null;
  editingStage = stage || null;
  if (stage) {
    stageModalTitle.textContent = "編輯階段";
    stageNameInput.value = stage.name;
    stageDurationInput.value = stage.duration;
    selectColor(stage.color);
    stageDeleteBtn.hidden = group.stages.length <= 1 && state.groups.length === 1;
    stageDuplicateBtn.hidden = false;
  } else {
    stageModalTitle.textContent = "新增階段";
    stageNameInput.value = "";
    stageDurationInput.value = 30;
    selectColor(COLORS[Math.floor(Math.random() * COLORS.length)]);
    stageDeleteBtn.hidden = true;
    stageDuplicateBtn.hidden = true;
  }
  stageModal.hidden = false;
  setTimeout(() => stageNameInput.focus(), 100);
}

function closeStageModal() {
  stageModal.hidden = true;
  editingStage = null;
  editingGroupId = null;
}

function buildColorPicker() {
  colorPicker.innerHTML = "";
  COLORS.forEach(c => {
    const sw = document.createElement("div");
    sw.className = "color-swatch";
    sw.style.background = c;
    sw.dataset.color = c;
    sw.addEventListener("click", () => selectColor(c));
    colorPicker.appendChild(sw);
  });
}
function selectColor(c) {
  $$(".color-swatch").forEach(el => el.classList.toggle("selected", el.dataset.color === c));
}
function getSelectedColor() {
  const sel = $(".color-swatch.selected");
  return sel ? sel.dataset.color : COLORS[0];
}

function bindModalEvents() {
  // Stepper buttons inside modal
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener("click", () => {
      const a = btn.dataset.action;
      if (a === "dur-plus") stageDurationInput.value = clamp(+stageDurationInput.value + 5, 1, 3600);
      if (a === "dur-minus") stageDurationInput.value = clamp(+stageDurationInput.value - 5, 1, 3600);
    });
  });

  stageCancelBtn.addEventListener("click", closeStageModal);
  stageModal.addEventListener("click", (e) => { if (e.target === stageModal) closeStageModal(); });

  stageSaveBtn.addEventListener("click", () => {
    const group = state.groups.find(g => g.id === editingGroupId);
    if (!group) return closeStageModal();
    const name = stageNameInput.value.trim() || "階段";
    const duration = clamp(+stageDurationInput.value || 30, 1, 3600);
    const color = getSelectedColor();
    const phase = inferPhase(name, color);
    if (editingStage) {
      editingStage.name = name;
      editingStage.duration = duration;
      editingStage.color = color;
      editingStage.phase = phase;
    } else {
      group.stages.push({ id: newStageId(group), name, duration, color, phase });
    }
    persist();
    renderGroups();
    updateTotals();
    closeStageModal();
  });

  stageDeleteBtn.addEventListener("click", () => {
    if (!editingStage) return;
    const group = state.groups.find(g => g.id === editingGroupId);
    if (!group) return;
    if (group.stages.length <= 1 && state.groups.length === 1) return;
    group.stages = group.stages.filter(s => s.id !== editingStage.id);
    // 若群組變空且還有其他群組，移除空群組
    if (group.stages.length === 0 && state.groups.length > 1) {
      state.groups = state.groups.filter(g => g.id !== group.id);
    }
    persist();
    renderGroups();
    updateTotals();
    closeStageModal();
  });

  stageDuplicateBtn.addEventListener("click", () => {
    if (!editingStage) return;
    const group = state.groups.find(g => g.id === editingGroupId);
    if (!group) return;
    const name = stageNameInput.value.trim() || editingStage.name;
    const duration = clamp(+stageDurationInput.value || editingStage.duration, 1, 3600);
    const color = getSelectedColor();
    const phase = inferPhase(name, color);
    const newStage = { id: newStageId(group), name, duration, color, phase };
    const idx = group.stages.findIndex(s => s.id === editingStage.id);
    if (idx >= 0) group.stages.splice(idx + 1, 0, newStage);
    else group.stages.push(newStage);
    persist();
    renderGroups();
    updateTotals();
    closeStageModal();
  });
}

function inferPhase(name, color) {
  if (/休|rest|recover/i.test(name)) return "rest";
  if (/熱身|warm/i.test(name)) return "warmup";
  if (/緩|cool|收/i.test(name)) return "cooldown";
  if (color === REST_COLOR || color === "#007aff") return "rest";
  if (color === "#ff9500" || color === "#ffd60a") return "warmup";
  return "work";
}

// ===========================================================
//  音效
// ===========================================================
let audioCtx = null;
function getCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  return audioCtx;
}
function unlockAudio() {
  const ctx = getCtx();
  if (ctx && ctx.state === "suspended") ctx.resume();
  if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance("");
    window.speechSynthesis.speak(u);
  }
}
function beep(freq = 880, duration = 0.12, volume = 0.3) {
  if (!state.sound) return;
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.value = 0;
  gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.01);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration + 0.02);
}
function bell() {
  if (!state.sound) return;
  beep(660, 0.15, 0.3);
  setTimeout(() => beep(990, 0.25, 0.3), 130);
}
function finishChord() {
  if (!state.sound) return;
  beep(523, 0.18, 0.25);
  setTimeout(() => beep(659, 0.18, 0.25), 160);
  setTimeout(() => beep(784, 0.4, 0.3), 320);
}

// ===========================================================
//  語音
// ===========================================================
let voiceCache = null;
function pickVoice() {
  if (voiceCache) return voiceCache;
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  voiceCache = voices.find(v => /zh-TW|zh_TW/i.test(v.lang)) ||
               voices.find(v => /zh-Hant/i.test(v.lang)) ||
               voices.find(v => /zh/i.test(v.lang)) ||
               voices[0] || null;
  return voiceCache;
}
function speak(text) {
  if (!state.voice) return;
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = (v && v.lang) || "zh-TW";
    u.rate = 1.05;
    u.pitch = 1.0;
    u.volume = 1.0;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

// ===========================================================
//  執行
// ===========================================================
function getCurrentGroup() { return state.groups[runtime.currentGroupIdx]; }
function getCurrentStage() { return getCurrentGroup().stages[runtime.currentStageIdx]; }

function isAbsoluteLastPos(groupIdx, round, stageIdx) {
  if (groupIdx !== state.groups.length - 1) return false;
  const g = state.groups[groupIdx];
  if (round !== g.rounds) return false;
  return stageIdx === g.stages.length - 1;
}

function startRun() {
  runtime = {
    currentGroupIdx: 0,
    currentRound: 1,
    currentStageIdx: 0,
    remaining: state.groups[0].stages[0].duration,
    paused: false,
    tickerId: null,
    lastTick: 0,
    announcedSecond: -1,
    halfAnnounced: false,
    endingSoonAnnounced: false,
  };
  runStartedAt = Date.now();
  showScreen("run");
  refreshRunUI(true);
  speakGroupStart(getCurrentGroup());
  speakStageStart(getCurrentStage());
  bell();
  startTicker();
  keepAwake(true);
}

function startTicker() {
  runtime.lastTick = performance.now();
  runtime.tickerId = requestAnimationFrame(tick);
}
function stopTicker() {
  if (runtime && runtime.tickerId) {
    cancelAnimationFrame(runtime.tickerId);
    runtime.tickerId = null;
  }
}

function tick(now) {
  if (!runtime || runtime.paused) return;
  const dt = (now - runtime.lastTick) / 1000;
  runtime.lastTick = now;
  runtime.remaining -= dt;

  const stage = getCurrentStage();
  const remSec = Math.ceil(runtime.remaining);
  const elapsed = stage.duration - runtime.remaining;

  if (remSec !== runtime.announcedSecond) {
    runtime.announcedSecond = remSec;
    if (remSec === 3 || remSec === 2 || remSec === 1) {
      beep(880, 0.1, 0.25);
    }
  }

  // 運動過半語音
  if (!runtime.halfAnnounced &&
      stage.phase === "work" &&
      stage.duration >= 20 &&
      elapsed >= stage.duration / 2) {
    runtime.halfAnnounced = true;
    speak("過半");
  }

  // 休息/緩和快結束預告（最後一階段不播）
  const isLast = isAbsoluteLastPos(runtime.currentGroupIdx, runtime.currentRound, runtime.currentStageIdx);
  if (!runtime.endingSoonAnnounced &&
      (stage.phase === "rest" || stage.phase === "cooldown") &&
      stage.duration >= 8 &&
      runtime.remaining <= 5 && runtime.remaining > 4 &&
      !isLast) {
    runtime.endingSoonAnnounced = true;
    speak("準備");
  }

  if (runtime.remaining <= 0) {
    advanceStage();
  } else {
    refreshRunUI(false);
    runtime.tickerId = requestAnimationFrame(tick);
  }
}

function advanceStage() {
  let g = runtime.currentGroupIdx;
  let r = runtime.currentRound;
  let s = runtime.currentStageIdx + 1;
  let group = state.groups[g];

  if (s >= group.stages.length) {
    r += 1;
    s = 0;
    if (r > group.rounds) {
      g += 1;
      r = 1;
      if (g >= state.groups.length) {
        finishRun();
        return;
      }
      group = state.groups[g];
    }
  }

  const nextStage = group.stages[s];
  // 最後一階段如為 rest 直接結束
  if (isAbsoluteLastPos(g, r, s) && nextStage.phase === "rest") {
    finishRun();
    return;
  }

  const isNewGroup = g !== runtime.currentGroupIdx;
  runtime.currentGroupIdx = g;
  runtime.currentRound = r;
  runtime.currentStageIdx = s;
  runtime.remaining = nextStage.duration;
  runtime.announcedSecond = -1;
  runtime.halfAnnounced = false;
  runtime.endingSoonAnnounced = false;
  bell();
  if (isNewGroup) speakGroupStart(group);
  speakStageStart(nextStage);
  refreshRunUI(true);
  runtime.tickerId = requestAnimationFrame(tick);
}

function speakGroupStart(group) {
  if (!state.voice) return;
  if (state.groups.length <= 1) return;
  speak(`${group.name}`);
}
function speakStageStart(stage) {
  if (!state.voice) return;
  let prefix = "";
  if (stage.phase === "rest" || stage.phase === "cooldown") prefix = "休息，";
  else if (stage.phase === "warmup") prefix = "熱身，";
  else prefix = "開始，";
  speak(`${prefix}${stage.name}，${stage.duration}秒`);
}

function refreshRunUI() {
  const group = getCurrentGroup();
  const stage = getCurrentStage();
  const remaining = Math.max(0, runtime.remaining);
  const min = Math.floor(remaining / 60);
  const sec = Math.floor(remaining % 60);
  timeRemainingEl.textContent = `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  runStageNameEl.textContent = stage.name;
  runStageNameEl.style.color = stage.color;
  currentRoundEl.textContent = runtime.currentRound;
  totalRoundsEl.textContent = group.rounds;
  groupIndicatorEl.textContent = state.groups.length > 1
    ? `${group.name} (${runtime.currentGroupIdx + 1}/${state.groups.length})`
    : "";
  const pct = remaining / stage.duration;
  ringProgress.style.strokeDashoffset = 578 * (1 - pct);
  ringProgress.style.stroke = stage.color;
  document.body.className = `phase-${stage.phase || "work"}`;
  nextStageHintEl.textContent = getNextHint();
}

function getNextHint() {
  const g = runtime.currentGroupIdx;
  const r = runtime.currentRound;
  const s = runtime.currentStageIdx;
  const group = state.groups[g];

  // next stage in same round
  if (s + 1 < group.stages.length) {
    // 最後一階段如為 rest 會被跳過
    const next = group.stages[s + 1];
    if (isAbsoluteLastPos(g, r, s + 1) && next.phase === "rest") return "即將結束";
    return `下一階段：${next.name}`;
  }
  // next round in same group
  if (r < group.rounds) return `下一回合：${group.stages[0].name}`;
  // next group
  if (g + 1 < state.groups.length) return `下一群組：${state.groups[g + 1].name}`;
  return "最後階段";
}

function togglePause() {
  if (!runtime) return;
  runtime.paused = !runtime.paused;
  if (runtime.paused) {
    stopTicker();
    pauseBtn.textContent = "▶";
    speak("暫停");
  } else {
    pauseBtn.textContent = "⏸";
    speak("繼續");
    startTicker();
  }
}

function exitRun() {
  if (!runtime) { showScreen("setup"); return; }
  if (!confirm("確定要結束訓練？")) return;
  stopTicker();
  runtime = null;
  document.body.className = "";
  keepAwake(false);
  showScreen("setup");
}

async function finishRun() {
  stopTicker();
  finishChord();
  speak("訓練完成");
  document.body.className = "";
  const total = state.groups.reduce((sum, g) =>
    sum + g.stages.reduce((s, st) => s + st.duration, 0) * g.rounds, 0);
  const totalRounds = state.groups.reduce((s, g) => s + g.rounds, 0);
  doneSummary.textContent = `總時間 ${formatTime(total)} · ${totalRounds} 回合`;
  doneSaveStatus.textContent = "";
  runtime = null;
  keepAwake(false);
  showScreen("done");

  if (user) {
    try {
      doneSaveStatus.textContent = "儲存到雲端…";
      await logWorkout(user.uid, {
        startedAt: runStartedAt,
        durationSec: total,
        totalRounds,
        groups: state.groups.map(g => ({
          name: g.name,
          rounds: g.rounds,
          stages: g.stages.map(s => ({ name: s.name, duration: s.duration, color: s.color, phase: s.phase }))
        })),
      });
      doneSaveStatus.textContent = "✓ 已記錄到雲端";
    } catch (e) {
      console.error(e);
      doneSaveStatus.textContent = "雲端儲存失敗（網路或權限）";
    }
  } else {
    doneSaveStatus.textContent = "登入即可保存到雲端";
  }
}

function bindRunEvents() {
  pauseBtn.addEventListener("click", togglePause);
  exitBtn.addEventListener("click", exitRun);

  prevBtn.addEventListener("click", () => {
    if (!runtime) return;
    const stage = getCurrentStage();
    // 若已經過 2 秒，先 reset 本階段
    if (runtime.remaining < stage.duration - 2) {
      runtime.remaining = stage.duration;
    } else {
      // 倒退
      let g = runtime.currentGroupIdx;
      let r = runtime.currentRound;
      let s = runtime.currentStageIdx - 1;
      if (s < 0) {
        r -= 1;
        if (r < 1) {
          g -= 1;
          if (g < 0) return;
          r = state.groups[g].rounds;
        }
        s = state.groups[g].stages.length - 1;
      }
      runtime.currentGroupIdx = g;
      runtime.currentRound = r;
      runtime.currentStageIdx = s;
      runtime.remaining = state.groups[g].stages[s].duration;
    }
    runtime.announcedSecond = -1;
    runtime.halfAnnounced = false;
    runtime.endingSoonAnnounced = false;
    bell();
    speakStageStart(getCurrentStage());
    refreshRunUI(true);
  });

  nextBtn.addEventListener("click", () => {
    if (!runtime) return;
    runtime.remaining = 0;
    runtime.announcedSecond = -1;
    advanceStage();
  });

  doneBackBtn.addEventListener("click", () => showScreen("setup"));

  document.addEventListener("keydown", (e) => {
    if (runScreen.classList.contains("active")) {
      if (e.code === "Space") { e.preventDefault(); togglePause(); }
      if (e.code === "ArrowRight") nextBtn.click();
      if (e.code === "ArrowLeft") prevBtn.click();
      if (e.code === "Escape") exitRun();
    }
  });
}

function showScreen(name) {
  setupScreen.classList.toggle("active", name === "setup");
  runScreen.classList.toggle("active", name === "run");
  doneScreen.classList.toggle("active", name === "done");
  historyScreen.classList.toggle("active", name === "history");
  window.scrollTo({ top: 0, behavior: "instant" });
}

// Wake Lock
let wakeLock = null;
async function keepAwake(on) {
  if (!("wakeLock" in navigator)) return;
  try {
    if (on) wakeLock = await navigator.wakeLock.request("screen");
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && runtime && !runtime.paused) keepAwake(true);
});

// ===========================================================
//  Auth
// ===========================================================
function bindAuth() {
  signInBtn.addEventListener("click", async () => {
    try {
      showSync("登入中…");
      await signIn();
    } catch (e) {
      console.error(e);
      showSync("登入失敗：" + (e?.code || e?.message || ""));
    }
  });
  signOutBtn.addEventListener("click", async () => {
    if (!confirm("確定登出？登出後僅在這台裝置看設定。")) return;
    await signOut();
  });
}

// ===========================================================
//  歷史紀錄
// ===========================================================
function bindHistory() {
  historyBackBtn.addEventListener("click", () => showScreen("setup"));
}

async function openHistory() {
  showScreen("history");
  if (!user) {
    historyEmpty.hidden = false;
    historyEmpty.querySelector("p").textContent = "請先登入才能看雲端紀錄";
    historyList.innerHTML = "";
    statCount.textContent = "0";
    statTotal.textContent = "0";
    statStreak.textContent = "0";
    statWeek.textContent = "0";
    return;
  }
  historyEmpty.hidden = true;
  historyList.innerHTML = `<li class="loading">載入中…</li>`;
  try {
    const items = await listWorkouts(user.uid, 100);
    renderHistory(items);
  } catch (e) {
    console.error(e);
    historyList.innerHTML = `<li class="empty-row">讀取失敗</li>`;
  }
}

function renderHistory(items) {
  if (!items.length) {
    historyEmpty.hidden = false;
    historyList.innerHTML = "";
    statCount.textContent = "0";
    statTotal.textContent = "0";
    statStreak.textContent = "0";
    statWeek.textContent = "0";
    return;
  }
  historyEmpty.hidden = true;
  const totalSec = items.reduce((s, w) => s + (w.durationSec || 0), 0);
  statCount.textContent = items.length;
  statTotal.textContent = Math.round(totalSec / 60);
  const days = new Set(items.map(w => dateKey(w.completedAt)));
  statStreak.textContent = currentStreak(days);
  const weekStart = startOfWeek(new Date());
  const weekCount = items.filter(w => toDate(w.completedAt) >= weekStart).length;
  statWeek.textContent = weekCount;

  historyList.innerHTML = "";
  items.forEach(w => {
    const li = document.createElement("li");
    li.className = "history-item";
    const d = toDate(w.completedAt);
    // 新格式有 groups[], 舊格式只有 stages[]
    let summary = "";
    if (Array.isArray(w.groups) && w.groups.length) {
      if (w.groups.length === 1) {
        summary = w.groups[0].stages.map(s => s.name).join(" → ");
      } else {
        summary = w.groups.map(g => g.name).join(" / ");
      }
    } else if (Array.isArray(w.stages)) {
      summary = w.stages.map(s => s.name).join(" → ");
    } else summary = "訓練";
    const roundsLabel = w.totalRounds ?? w.rounds ?? 1;
    li.innerHTML = `
      <div class="history-date">
        <span class="h-day"></span>
        <span class="h-time"></span>
      </div>
      <div class="history-body">
        <div class="h-title"></div>
        <div class="h-meta"></div>
      </div>
      <button class="h-del" aria-label="刪除">✕</button>
    `;
    li.querySelector(".h-day").textContent = formatDay(d);
    li.querySelector(".h-time").textContent = formatHM(d);
    li.querySelector(".h-title").textContent = summary;
    li.querySelector(".h-meta").textContent = `${formatTime(w.durationSec || 0)} · ${roundsLabel} 回合`;
    li.querySelector(".h-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("刪除這筆紀錄？")) return;
      try { await deleteWorkout(user.uid, w.id); openHistory(); }
      catch (err) { alert("刪除失敗"); }
    });
    historyList.appendChild(li);
  });
}

function toDate(ts) {
  if (!ts) return new Date(0);
  if (typeof ts.toDate === "function") return ts.toDate();
  if (ts.seconds) return new Date(ts.seconds * 1000);
  if (typeof ts === "number") return new Date(ts);
  return new Date(ts);
}
function dateKey(ts) {
  const d = toDate(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function formatDay(d) {
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return "今天";
  if (sameDay(d, yest)) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function formatHM(d) {
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0,0,0,0);
  const day = x.getDay();
  const diff = (day === 0 ? 6 : day - 1);
  x.setDate(x.getDate() - diff);
  return x;
}
function currentStreak(daySet) {
  let n = 0;
  const d = new Date();
  d.setHours(0,0,0,0);
  while (daySet.has(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  if (n === 0) {
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(0,0,0,0);
    if (daySet.has(`${y.getFullYear()}-${y.getMonth()}-${y.getDate()}`)) {
      let cur = y;
      while (daySet.has(`${cur.getFullYear()}-${cur.getMonth()}-${cur.getDate()}`)) {
        n++;
        cur.setDate(cur.getDate() - 1);
      }
    }
  }
  return n;
}

init();
