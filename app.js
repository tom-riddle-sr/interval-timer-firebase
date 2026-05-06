/* =========================================================
 * 間歇運動計時器 (Firebase 雲端版)
 * 未登入：用 localStorage（同原版）
 * 登入後：設定與訓練紀錄存 Firestore，跨裝置同步
 * ========================================================= */
import {
  signIn, signOut, onAuthChange, currentUser,
  loadSettings, saveSettings, logWorkout, listWorkouts, deleteWorkout
} from "./firebase.js";

// ---------- 預設與常數 ----------
const COLORS = [
  "#ff453a", "#ff9500", "#ffd60a", "#34c759",
  "#5ac8fa", "#007aff", "#5856d6", "#af52de",
  "#ff2d55", "#a2845e", "#8e8e93", "#30d158"
];

const DEFAULT_STAGES = [
  { id: 1, name: "高強度", duration: 30, color: "#ff453a", phase: "work" },
  { id: 2, name: "休息", duration: 15, color: "#5ac8fa", phase: "rest" }
];

const PRESETS = {
  tabata: {
    rounds: 8,
    stages: [
      { name: "全力", duration: 20, color: "#ff453a", phase: "work" },
      { name: "休息", duration: 10, color: "#5ac8fa", phase: "rest" }
    ]
  },
  hiit: {
    rounds: 6,
    stages: [
      { name: "高強度", duration: 40, color: "#ff453a", phase: "work" },
      { name: "中強度", duration: 20, color: "#ff9500", phase: "work" },
      { name: "休息", duration: 30, color: "#5ac8fa", phase: "rest" }
    ]
  },
  emom: {
    rounds: 10,
    stages: [
      { name: "動作", duration: 45, color: "#34c759", phase: "work" },
      { name: "休息", duration: 15, color: "#5ac8fa", phase: "rest" }
    ]
  },
  warmup: {
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
  rounds: 3,
  voice: true,
  sound: true,
  stages: [],
};
let runtime = null;
let editingStage = null;
let user = null;
let runStartedAt = 0;

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const setupScreen = $("#setupScreen");
const runScreen = $("#runScreen");
const doneScreen = $("#doneScreen");
const historyScreen = $("#historyScreen");

const stagesList = $("#stagesList");
const roundsInput = $("#roundsInput");
const voiceToggle = $("#voiceToggle");
const soundToggle = $("#soundToggle");
const startBtn = $("#startBtn");
const historyBtn = $("#historyBtn");
const addStageBtn = $("#addStageBtn");
const roundDurationEl = $("#roundDuration");
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

// ---------- localStorage 後備 ----------
const STORAGE_KEY = "intervalTimer.fb.v1";
function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      rounds: state.rounds, voice: state.voice, sound: state.sound, stages: state.stages,
    }));
  } catch (e) {}
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.stages) || data.stages.length === 0) return null;
    return data;
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
          rounds: state.rounds, voice: state.voice, sound: state.sound, stages: state.stages,
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

// ---------- 初始化 ----------
async function init() {
  // 先用本地資料快速顯示
  const saved = loadLocal();
  if (saved) {
    state = { ...state, ...saved };
  } else {
    state.stages = DEFAULT_STAGES.map(s => ({ ...s }));
  }
  ensureIds();
  hydrateUI();

  bindSetupEvents();
  bindRunEvents();
  bindModalEvents();
  bindPresets();
  bindAuth();
  bindHistory();
  buildColorPicker();

  // 預先觸發語音引擎
  if ("speechSynthesis" in window) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => {};
  }

  // 監聽登入狀態
  onAuthChange(async (u) => {
    user = u || null;
    if (u) {
      signInBtn.hidden = true;
      userBadge.hidden = false;
      userAvatar.src = u.photoURL || "";
      userAvatar.alt = u.displayName || "";
      userName.textContent = u.displayName || u.email || "已登入";
      // 雲端 → 本地（雲端優先）
      try {
        showSync("讀取雲端設定…");
        const cloud = await loadSettings(u.uid);
        if (cloud && Array.isArray(cloud.stages) && cloud.stages.length) {
          state = {
            rounds: cloud.rounds ?? state.rounds,
            voice: cloud.voice ?? state.voice,
            sound: cloud.sound ?? state.sound,
            stages: cloud.stages
          };
          ensureIds();
          hydrateUI();
          showSync("已載入雲端設定", true);
        } else {
          // 雲端沒資料 → 把目前的本地推上去
          await saveSettings(u.uid, {
            rounds: state.rounds, voice: state.voice, sound: state.sound, stages: state.stages,
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

function ensureIds() {
  let nextId = state.stages.reduce((m, s) => Math.max(m, s.id || 0), 0);
  state.stages.forEach(s => { if (!s.id) s.id = ++nextId; });
}

function hydrateUI() {
  roundsInput.value = state.rounds;
  voiceToggle.checked = state.voice;
  soundToggle.checked = state.sound;
  renderStages();
  updateTotals();
}

// ---------- 渲染階段 ----------
function renderStages() {
  stagesList.innerHTML = "";
  state.stages.forEach((stage) => {
    const li = document.createElement("li");
    li.className = "stage-item";
    li.draggable = true;
    li.dataset.id = stage.id;
    li.innerHTML = `
      <span class="stage-color-dot" style="background:${stage.color}"></span>
      <span class="stage-name"></span>
      <span class="stage-time">${formatTime(stage.duration)}</span>
      <span class="stage-handle" aria-label="拖曳">⋮⋮</span>
    `;
    li.querySelector(".stage-name").textContent = stage.name;
    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("stage-handle")) return;
      openStageModal(stage);
    });
    attachDragHandlers(li);
    stagesList.appendChild(li);
  });
}

function updateTotals() {
  const perRound = state.stages.reduce((sum, s) => sum + s.duration, 0);
  const total = perRound * state.rounds;
  roundDurationEl.textContent = formatTime(perRound);
  totalDurationEl.textContent = formatTime(total);
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- 拖曳排序 ----------
let dragSrcId = null;
function attachDragHandlers(li) {
  li.addEventListener("dragstart", (e) => {
    dragSrcId = Number(li.dataset.id);
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    $$(".stage-item").forEach(el => el.classList.remove("drag-over"));
    dragSrcId = null;
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    li.classList.add("drag-over");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    li.classList.remove("drag-over");
    if (dragSrcId == null) return;
    const targetId = Number(li.dataset.id);
    if (targetId === dragSrcId) return;
    const fromIdx = state.stages.findIndex(s => s.id === dragSrcId);
    const toIdx = state.stages.findIndex(s => s.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = state.stages.splice(fromIdx, 1);
    state.stages.splice(toIdx, 0, moved);
    persist();
    renderStages();
    updateTotals();
  });
}

// ---------- 設定畫面事件 ----------
function bindSetupEvents() {
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener("click", () => {
      const a = btn.dataset.action;
      if (a === "rounds-plus") roundsInput.value = clamp(+roundsInput.value + 1, 1, 99);
      if (a === "rounds-minus") roundsInput.value = clamp(+roundsInput.value - 1, 1, 99);
      if (a === "dur-plus") stageDurationInput.value = clamp(+stageDurationInput.value + 5, 1, 3600);
      if (a === "dur-minus") stageDurationInput.value = clamp(+stageDurationInput.value - 5, 1, 3600);
      if (a === "rounds-plus" || a === "rounds-minus") {
        state.rounds = +roundsInput.value;
        persist();
        updateTotals();
      }
    });
  });

  roundsInput.addEventListener("change", () => {
    state.rounds = clamp(+roundsInput.value || 1, 1, 99);
    roundsInput.value = state.rounds;
    persist();
    updateTotals();
  });

  voiceToggle.addEventListener("change", () => {
    state.voice = voiceToggle.checked;
    persist();
  });
  soundToggle.addEventListener("change", () => {
    state.sound = soundToggle.checked;
    persist();
  });

  addStageBtn.addEventListener("click", () => openStageModal(null));

  startBtn.addEventListener("click", () => {
    if (state.stages.length === 0) {
      alert("請至少新增一個階段");
      return;
    }
    unlockAudio();
    startRun();
  });

  historyBtn.addEventListener("click", openHistory);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ---------- 預設方案 ----------
function bindPresets() {
  document.querySelectorAll(".preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = PRESETS[btn.dataset.preset];
      if (!p) return;
      if (!confirm(`套用 ${btn.textContent} 預設？目前的設定會被覆蓋。`)) return;
      state.rounds = p.rounds;
      state.stages = p.stages.map((s, i) => ({ ...s, id: i + 1 }));
      roundsInput.value = state.rounds;
      persist();
      renderStages();
      updateTotals();
    });
  });
}

// ---------- Stage Modal ----------
function openStageModal(stage) {
  editingStage = stage;
  if (stage) {
    stageModalTitle.textContent = "編輯階段";
    stageNameInput.value = stage.name;
    stageDurationInput.value = stage.duration;
    selectColor(stage.color);
    stageDeleteBtn.hidden = state.stages.length <= 1;
  } else {
    stageModalTitle.textContent = "新增階段";
    stageNameInput.value = "";
    stageDurationInput.value = 30;
    selectColor(COLORS[Math.floor(Math.random() * COLORS.length)]);
    stageDeleteBtn.hidden = true;
  }
  stageModal.hidden = false;
  setTimeout(() => stageNameInput.focus(), 100);
}

function closeStageModal() {
  stageModal.hidden = true;
  editingStage = null;
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
  $$(".color-swatch").forEach(el => {
    el.classList.toggle("selected", el.dataset.color === c);
  });
}
function getSelectedColor() {
  const sel = $(".color-swatch.selected");
  return sel ? sel.dataset.color : COLORS[0];
}

function bindModalEvents() {
  stageCancelBtn.addEventListener("click", closeStageModal);
  stageModal.addEventListener("click", (e) => {
    if (e.target === stageModal) closeStageModal();
  });

  stageSaveBtn.addEventListener("click", () => {
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
      const id = (state.stages.reduce((m, s) => Math.max(m, s.id), 0) || 0) + 1;
      state.stages.push({ id, name, duration, color, phase });
    }
    persist();
    renderStages();
    updateTotals();
    closeStageModal();
  });

  stageDeleteBtn.addEventListener("click", () => {
    if (!editingStage) return;
    if (state.stages.length <= 1) return;
    state.stages = state.stages.filter(s => s.id !== editingStage.id);
    persist();
    renderStages();
    updateTotals();
    closeStageModal();
  });
}

function inferPhase(name, color) {
  if (/休|rest|recover/i.test(name)) return "rest";
  if (/熱身|warm/i.test(name)) return "warmup";
  if (/緩|cool|收/i.test(name)) return "cooldown";
  if (color === "#5ac8fa" || color === "#007aff") return "rest";
  if (color === "#ff9500" || color === "#ffd60a") return "warmup";
  return "work";
}

// ===========================================================
//  音效（Web Audio API）
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
function startRun() {
  runtime = {
    currentRound: 1,
    currentStageIdx: 0,
    remaining: state.stages[0].duration,
    paused: false,
    tickerId: null,
    lastTick: 0,
    announcedSecond: -1,
    halfAnnounced: false,
    endingSoonAnnounced: false,
  };
  runStartedAt = Date.now();
  showScreen("run");
  totalRoundsEl.textContent = state.rounds;
  refreshRunUI(true);
  speakStageStart(state.stages[0]);
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

  const stage = state.stages[runtime.currentStageIdx];
  const remSec = Math.ceil(runtime.remaining);
  const elapsed = stage.duration - runtime.remaining;

  if (remSec !== runtime.announcedSecond) {
    runtime.announcedSecond = remSec;
    if (remSec === 3 || remSec === 2 || remSec === 1) {
      beep(880, 0.1, 0.25);
    }
  }

  // 運動過半語音（只在 work 且階段 ≥ 20 秒，避免短階段太吵）
  if (!runtime.halfAnnounced &&
      stage.phase === "work" &&
      stage.duration >= 20 &&
      elapsed >= stage.duration / 2) {
    runtime.halfAnnounced = true;
    speak("過半");
  }

  // 休息/緩和快結束預告（剩 5 秒，且階段 ≥ 8 秒）
  if (!runtime.endingSoonAnnounced &&
      (stage.phase === "rest" || stage.phase === "cooldown") &&
      stage.duration >= 8 &&
      runtime.remaining <= 5 && runtime.remaining > 4) {
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
  const nextIdx = runtime.currentStageIdx + 1;
  if (nextIdx >= state.stages.length) {
    if (runtime.currentRound >= state.rounds) {
      finishRun();
      return;
    }
    runtime.currentRound += 1;
    runtime.currentStageIdx = 0;
  } else {
    runtime.currentStageIdx = nextIdx;
  }
  const stage = state.stages[runtime.currentStageIdx];
  runtime.remaining = stage.duration;
  runtime.announcedSecond = -1;
  runtime.halfAnnounced = false;
  runtime.endingSoonAnnounced = false;
  bell();
  speakStageStart(stage);
  refreshRunUI(true);
  runtime.tickerId = requestAnimationFrame(tick);
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
  const stage = state.stages[runtime.currentStageIdx];
  const remaining = Math.max(0, runtime.remaining);
  const min = Math.floor(remaining / 60);
  const sec = Math.floor(remaining % 60);
  timeRemainingEl.textContent = `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  runStageNameEl.textContent = stage.name;
  runStageNameEl.style.color = stage.color;
  currentRoundEl.textContent = runtime.currentRound;
  const pct = remaining / stage.duration;
  ringProgress.style.strokeDashoffset = 578 * (1 - pct);
  ringProgress.style.stroke = stage.color;
  document.body.className = `phase-${stage.phase || "work"}`;
  nextStageHintEl.textContent = getNextHint();
}

function getNextHint() {
  const idx = runtime.currentStageIdx + 1;
  if (idx < state.stages.length) return `下一階段：${state.stages[idx].name}`;
  if (runtime.currentRound < state.rounds) return `下一回合：${state.stages[0].name}`;
  return "最後一階段";
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
  const total = state.stages.reduce((s, x) => s + x.duration, 0) * state.rounds;
  doneSummary.textContent = `總時間 ${formatTime(total)} · ${state.rounds} 回合`;
  doneSaveStatus.textContent = "";
  runtime = null;
  keepAwake(false);
  showScreen("done");

  // 寫入雲端紀錄
  if (user) {
    try {
      doneSaveStatus.textContent = "儲存到雲端…";
      await logWorkout(user.uid, {
        startedAt: runStartedAt,
        durationSec: total,
        rounds: state.rounds,
        stages: state.stages.map(s => ({ name: s.name, duration: s.duration, color: s.color, phase: s.phase })),
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
    if (runtime.remaining < state.stages[runtime.currentStageIdx].duration - 2) {
      runtime.remaining = state.stages[runtime.currentStageIdx].duration;
    } else if (runtime.currentStageIdx > 0) {
      runtime.currentStageIdx -= 1;
      runtime.remaining = state.stages[runtime.currentStageIdx].duration;
    } else if (runtime.currentRound > 1) {
      runtime.currentRound -= 1;
      runtime.currentStageIdx = state.stages.length - 1;
      runtime.remaining = state.stages[runtime.currentStageIdx].duration;
    }
    runtime.announcedSecond = -1;
    runtime.halfAnnounced = false;
    runtime.endingSoonAnnounced = false;
    bell();
    speakStageStart(state.stages[runtime.currentStageIdx]);
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

// ---------- Wake Lock ----------
let wakeLock = null;
async function keepAwake(on) {
  if (!("wakeLock" in navigator)) return;
  try {
    if (on) {
      wakeLock = await navigator.wakeLock.request("screen");
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) {}
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && runtime && !runtime.paused) {
    keepAwake(true);
  }
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

  // 統計
  const totalSec = items.reduce((s, w) => s + (w.durationSec || 0), 0);
  statCount.textContent = items.length;
  statTotal.textContent = Math.round(totalSec / 60);

  const days = new Set(items.map(w => dateKey(w.completedAt)));
  statStreak.textContent = currentStreak(days);

  const weekStart = startOfWeek(new Date());
  const weekCount = items.filter(w => toDate(w.completedAt) >= weekStart).length;
  statWeek.textContent = weekCount;

  // 列表
  historyList.innerHTML = "";
  items.forEach(w => {
    const li = document.createElement("li");
    li.className = "history-item";
    const d = toDate(w.completedAt);
    const stagesStr = (w.stages || []).map(s => s.name).join(" → ");
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
    li.querySelector(".h-title").textContent = stagesStr || "訓練";
    li.querySelector(".h-meta").textContent =
      `${formatTime(w.durationSec || 0)} · ${w.rounds || 1} 回合`;
    li.querySelector(".h-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("刪除這筆紀錄？")) return;
      try {
        await deleteWorkout(user.uid, w.id);
        openHistory();
      } catch (err) { alert("刪除失敗"); }
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
  const diff = (day === 0 ? 6 : day - 1); // 週一為一週開始
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
  // 如果今天還沒做但昨天有 → 仍從昨天往前算（讓今天空著不歸零）
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

// Boot
init();
