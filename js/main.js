// AnatoMove — сценарий приложения: экраны, управление жестами, цикл распознавания, итоги.

import { L, clamp } from './geometry.js';
import { CATALOG, makeWorkout, SETUP, Squat } from './exercises.js';
import {
  MUSCLES, drawBones, drawJoints, drawMuscles, drawFaultJoints, drawLabels, drawHandHold, bodyMapSVG,
} from './anatomy.js';
import { startCamera, createPoseDetector } from './pose.js';
import * as sound from './voice.js';

const $ = (s) => document.querySelector(s);
const DEBUG = new URLSearchParams(location.search).has('debug');
const HOLD_SEC = 1.0;        // сколько держать одну руку, чтобы выбрать пункт
const BOTH_SEC = 1.3;        // обе руки — чуть дольше, чтобы не спутать с подъёмом одной
const SKIP_SEC = 2.0;        // руки скрещены на груди во время упражнения — пропуск
const HINT_MS = 3800;        // сколько висит подсказка-поправка
const SETUP_DELAY_MS = 400;  // не мигать подсказкой о положении из-за одного кадра
const MAX_SNAPS = 6;         // стоп-кадров ошибок за тренировку
const SNAP_W = 240, SNAP_H = 320;
const CAM_FILTER = 'grayscale(1) contrast(1.08) brightness(0.72)';
const HISTORY_KEY = 'anatomove.history.v1';

const stage = $('#stage');
const video = $('#cam');
const canvas = $('#overlay');
const ctx = canvas.getContext('2d');
const probe = new Squat();                 // только чтобы в меню проверить, виден ли человек целиком
const INFO = CATALOG.map((C) => new C());  // названия, мышцы и цели для каталога

const st = {
  screen: 'intro',
  detector: null,
  looping: false,
  P: null,            // точки в пикселях кадра камеры
  S: [],              // те же точки на экране (зеркально)
  frame: { w: 1280, h: 720 },
  view: { cw: 0, ch: 0, scale: 1, ox: 0, oy: 0 },
  lastVideoTime: -1,
  lastT: 0,
  holds: { left: 0, right: 0, both: 0 },
  lock: false,        // после выбора ждём, пока человек опустит руки
  crossLock: false,   // после пропуска ждём, пока человек разведёт руки
  plan: null,         // { ids, title } — что запущено: полная тренировка или одно упражнение
  cat: 0,             // выбранное упражнение в каталоге
  workout: [],
  idx: 0,
  ex: null,
  startedAt: 0,
  nextAt: 0,
  trRemaining: 0,
  hint: null,
  hintUntil: 0,
  setup: null,
  setupSince: 0,
  snaps: [],          // стоп-кадры ошибок
  snapKeys: new Set(),
  snapPending: [],
  buffer: [],         // последние кадры упражнения — из них выбираем кадр для стоп-кадра
  bufferTick: 0,
  texts: {},
  debugAt: 0,
};

// ─── Утилиты
const plural = (n, [one, few, many]) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
const setText = (sel, text) => {
  if (st.texts[sel] === text) return;
  st.texts[sel] = text;
  $(sel).textContent = text;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
const fmtDuration = (s) => (s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с`);

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* приватный режим — просто не сохраняем */ }
}

// ─── Экраны
function go(screen) {
  st.screen = screen;
  document.body.dataset.screen = screen;
  st.holds.left = st.holds.right = st.holds.both = 0;
  st.lock = true; // рука, которой выбрали пункт, не должна сразу нажать что-то на новом экране
  hideHint();
  document.querySelectorAll('.gesture').forEach((el) => el.style.setProperty('--hold', 0));
}

const ACTIONS = {
  start: () => startPlan({ ids: null, title: 'Полная тренировка' }),
  catalog: () => showCatalog(),
  history: () => showHistory(),
  menu: () => go('menu'),
  next: () => { st.cat = (st.cat + 1) % INFO.length; renderCatalog(); },
  pick: () => startPlan({ ids: [INFO[st.cat].id], title: INFO[st.cat].name }),
  again: () => startPlan(st.plan),
};

function activate(el) {
  sound.tone('select');
  el.classList.remove('chosen');
  void el.offsetWidth;
  el.classList.add('chosen');
  ACTIONS[el.dataset.action]?.();
}

document.querySelectorAll('.gesture').forEach((el) => {
  // Запасной вариант для жюри: пункты можно нажать и мышью.
  el.addEventListener('click', () => {
    if (el.closest('[data-panel]').dataset.panel === st.screen) activate(el);
  });
});

$('#catalog').addEventListener('click', (e) => {
  const item = e.target.closest('[data-i]');
  if (!item) return;
  st.cat = Number(item.dataset.i);
  renderCatalog();
});

$('#mute').addEventListener('click', () => {
  const m = !sound.isMuted();
  sound.setMuted(m);
  $('#mute').setAttribute('aria-pressed', String(m));
  $('#mute').setAttribute('aria-label', m ? 'Включить звук' : 'Выключить звук');
});

document.addEventListener('visibilitychange', () => { if (document.hidden) sound.stopSpeech(); });

// ─── Запуск
$('#start').addEventListener('click', boot);
$('#intro-map').innerHTML = bodyMapSVG({
  quads: 1, glutes: 0.85, adductors: 0.5, deltoids: 0.7, traps: 0.3, iliopsoas: 0.75, abs: 0.45,
  erectors: 0.4, triceps: 0.55, obliques: 0.6, ql: 0.35, gmed: 0.5, calves: 0.65,
});

function showIntroError(text) {
  $('#intro-error').textContent = text;
  $('#intro-error').hidden = !text;
}

async function boot() {
  $('#start').disabled = true;
  showIntroError('');
  sound.initAudio();
  go('loading');
  try {
    video.srcObject?.getTracks().forEach((t) => t.stop());
    const stream = await startCamera(video);
    // Камеру отключили или её забрало другое приложение — возвращаемся на старт с понятным текстом.
    stream?.getVideoTracks?.()[0]?.addEventListener('ended', () => {
      showIntroError('Камера отключилась. Проверь подключение и нажми кнопку ещё раз.');
      $('#start').disabled = false;
      go('intro');
    });
    fitView();
    if (!st.detector) st.detector = await createPoseDetector();
    await document.fonts?.ready;
    go('menu');
    if (!st.looping) { st.looping = true; requestAnimationFrame(loop); }
  } catch (e) {
    console.error(e);
    const messages = {
      denied: 'Нет доступа к камере. Разреши его в адресной строке браузера и нажми кнопку ещё раз.',
      'no-camera': 'Камера не найдена или занята. Закрой приложения, которые её используют, и попробуй снова.',
      'no-camera-api': 'Браузер не даёт доступ к камере. Открой ссылку в Chrome, Edge или Safari по https.',
      model: 'Не загрузилась модель распознавания. Проверь интернет и нажми кнопку ещё раз.',
    };
    showIntroError(messages[e.code] || 'Не получилось запуститься. Обнови страницу и попробуй снова.');
    $('#start').disabled = false;
    go('intro');
  }
}

// Видео растянуто на весь экран (object-fit: cover) и зеркально — считаем, куда попадают точки.
function fitView() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = stage.clientWidth, ch = stage.clientHeight;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const scale = Math.max(cw / vw, ch / vh);
  st.view = { cw, ch, scale, ox: (cw - vw * scale) / 2, oy: (ch - vh * scale) / 2 };
  st.frame = { w: vw, h: vh };
}
window.addEventListener('resize', fitView);
video.addEventListener('loadedmetadata', fitView);

function toScreen(P) {
  if (!P) return [];
  const { cw, scale, ox, oy } = st.view;
  return P.map((p) => (p.visibility >= 0.5 ? { x: cw - (ox + p.x * scale), y: oy + p.y * scale } : null));
}

// ─── Главный цикл
function loop() {
  requestAnimationFrame(loop);
  if (!st.detector || video.readyState < 2 || st.screen === 'intro') return;
  if (video.currentTime === st.lastVideoTime) return; // новый кадр ещё не пришёл
  st.lastVideoTime = video.currentTime;

  const now = performance.now();
  // До 0,25 с: на слабом устройстве (4–10 кадров/с) удержание жеста всё равно длится честную секунду.
  const dt = st.lastT ? clamp((now - st.lastT) / 1000, 0, 0.25) : 1 / 30;
  st.lastT = now;
  if (video.videoWidth !== st.frame.w || video.videoHeight !== st.frame.h) fitView();

  let result;
  try { result = st.detector.detectForVideo(video, now); } catch (e) { console.error(e); return; }
  const raw = result.landmarks?.[0];
  const { w, h } = st.frame;
  st.P = raw ? raw.map((p) => ({ x: p.x * w, y: p.y * h, visibility: p.visibility ?? 1 })) : null;
  st.S = toScreen(st.P);

  step(now, dt);
  render(now);
  if (st.screen === 'exercise') bufferFrame(now);
  if (st.snapPending.length) takeSnapshots(now);
  if (DEBUG && now - st.debugAt > 120) { st.debugAt = now; showDebug(dt); }
}

function step(now, dt) {
  switch (st.screen) {
    case 'menu': menuStep(); gestures(dt); break;
    case 'catalog':
    case 'history':
    case 'summary': gestures(dt); break;
    case 'transition': transitionStep(dt); break;
    case 'exercise': exerciseStep(now, dt); gestures(dt, { skip: true }); break;
  }
}

// ─── Управление жестами: рука над головой — пункт на этой стороне экрана, обе руки — пункт по центру.
function handsUp(P, margin = 0) {
  const none = { left: false, right: false };
  if (!P) return none;
  const nose = P[L.NOSE];
  if (!nose || nose.visibility < 0.5) return none;
  const lift = margin * Math.abs(P[L.L_SHOULDER].x - P[L.R_SHOULDER].x);
  const up = (i) => P[i].visibility >= 0.5 && P[i].y < nose.y - lift;
  return { left: up(L.L_WRIST), right: up(L.R_WRIST) };
}

// Руки скрещены на груди: левое запястье ушло за правое, обе кисти на уровне корпуса.
function armsCrossed(P) {
  if (!P) return false;
  const need = [L.L_WRIST, L.R_WRIST, L.L_SHOULDER, L.R_SHOULDER, L.L_HIP, L.R_HIP];
  if (need.some((i) => (P[i].visibility ?? 0) < 0.5)) return false;
  const sw = Math.abs(P[L.L_SHOULDER].x - P[L.R_SHOULDER].x);
  const top = Math.min(P[L.L_SHOULDER].y, P[L.R_SHOULDER].y) - 0.3 * sw;
  const bottom = Math.max(P[L.L_HIP].y, P[L.R_HIP].y);
  const lw = P[L.L_WRIST], rw = P[L.R_WRIST];
  const inBand = (w) => w.y > top && w.y < bottom;
  // В кадре (не зеркальном) левая рука человека обычно правее правой; скрестил — наоборот.
  return lw.x < rw.x - 0.1 * sw && inBand(lw) && inBand(rw);
}

function gestures(dt, { skip = false } = {}) {
  const h = handsUp(st.P);
  if (!h.left && !h.right) st.lock = false;
  const grow = (key, on, limit) => {
    st.holds[key] = on && !st.lock ? st.holds[key] + dt : Math.max(0, st.holds[key] - dt * 2);
    return st.holds[key] >= limit;
  };

  if (skip) {
    // Пропуск — руки скрещены на груди 2 секунды. Такой позы нет ни в одном упражнении,
    // а пока идёт повтор, удержание не копится (можно приседать и со скрещёнными руками).
    const crossed = armsCrossed(st.P);
    if (!crossed) st.crossLock = false;
    const on = crossed && !st.crossLock && !st.ex.busy;
    st.holds.both = on ? st.holds.both + dt : st.ex.busy ? 0 : Math.max(0, st.holds.both - dt * 2);
    if (st.holds.both >= SKIP_SEC) {
      st.holds.both = 0;
      st.crossLock = true; // следующее упражнение не пропустится, пока руки не разведены
      skipExercise();
    }
    $('#skip').style.setProperty('--hold', clamp(st.holds.both / SKIP_SEC).toFixed(3));
    return;
  }

  const panel = document.querySelector(`[data-panel="${st.screen}"]`);
  const both = h.left && h.right;
  for (const side of ['left', 'right', 'both']) {
    const target = panel?.querySelector(`.gesture[data-side="${side}"]`);
    if (!target) { st.holds[side] = 0; continue; }
    const on = side === 'both' ? both : h[side] && !both;
    const limit = side === 'both' ? BOTH_SEC : HOLD_SEC;
    if (grow(side, on, limit)) {
      st.lock = true;
      st.holds.left = st.holds.right = st.holds.both = 0;
      target.style.setProperty('--hold', 0);
      activate(target);
      return;
    }
    target.style.setProperty('--hold', clamp(st.holds[side] / limit).toFixed(3));
  }
}

// ─── Меню и каталог
function menuStep() {
  const code = probe.positioning(st.P, st.frame, { lower: true, upper: true });
  setText('#menu-status', code ? `${SETUP[code].what}. ${SETUP[code].fix}.` : 'Вижу тебя целиком — можно начинать');
  $('#menu-status').classList.toggle('ok', !code);
}

function showCatalog() {
  renderCatalog();
  go('catalog');
}

function renderCatalog() {
  $('#catalog').innerHTML = INFO.map((e, i) => {
    const faults = Object.keys(e.FAULTS).length;
    return `<li class="cat-item${i === st.cat ? ' current' : ''}" data-i="${i}" aria-current="${i === st.cat}">
      <span class="cat-name">${esc(e.name)}</span>
      <i class="cat-la" lang="la">${e.muscles.slice(0, 2).map((m) => MUSCLES[m].la).join(' · ')}</i>
      <span class="cat-meta">${e.target} ${plural(e.target, ['повтор', 'повтора', 'повторов'])} · ${faults} ${plural(faults, ['ошибка', 'ошибки', 'ошибок'])} в разборе</span>
    </li>`;
  }).join('');
  $('#cat-pick').textContent = INFO[st.cat].name;
}

// ─── Тренировка
function startPlan(plan) {
  st.plan = plan;
  st.workout = makeWorkout(plan.ids);
  st.idx = 0;
  st.startedAt = performance.now();
  st.snaps = [];
  st.snapKeys.clear();
  beginTransition();
}

function beginTransition() {
  const ex = st.workout[st.idx];
  st.ex = ex;
  st.buffer = [];
  const step = st.workout.length > 1 ? `Упражнение ${st.idx + 1} из ${st.workout.length}` : 'Одно упражнение';
  $('#tr-step').textContent = step;
  $('#tr-name').textContent = ex.name;
  $('#tr-how').textContent = ex.how;
  $('#tr-fact').textContent = ex.fact;
  $('#tr-muscles').innerHTML = ex.muscles
    .map((id) => `<li><span>${MUSCLES[id].ru}</span><i lang="la">${MUSCLES[id].la}</i></li>`)
    .join('');
  st.trRemaining = 6;
  go('transition');
  sound.say(`${ex.name}. ${ex.how}`, { urgent: true, cooldown: 0 });
}

function transitionStep(dt) {
  const ex = st.ex;
  const code = ex.positioning(st.P, st.frame, ex.needs);
  if (code) {
    st.trRemaining = Math.max(st.trRemaining, 3.2); // отсчёт идёт, только когда человек в кадре
    setText('#tr-wait', `${SETUP[code].what}. ${SETUP[code].fix}.`);
    sound.say(SETUP[code].say, { cooldown: 6000 });
  } else {
    st.trRemaining -= dt;
    setText('#tr-wait', '');
  }
  const n = Math.ceil(st.trRemaining);
  setText('#tr-count', !code && n <= 3 && n >= 1 ? String(n) : '');
  if (st.trRemaining <= 0) startExercise();
}

function startExercise() {
  const ex = st.ex;
  $('#hud-step').textContent = st.workout.length > 1 ? `Упражнение ${st.idx + 1} из ${st.workout.length}` : 'Одно упражнение';
  $('#hud-name').textContent = ex.name;
  $('#hud-target').textContent = `из ${ex.target}`;
  updateCount();
  st.nextAt = 0;
  st.setup = null;
  go('exercise');
  sound.say('Начали', { urgent: true, cooldown: 0 });
}

function exerciseStep(now, dt) {
  const ex = st.ex;
  if (st.nextAt) {
    if (now >= st.nextAt) nextExercise();
    return;
  }
  const res = ex.update({ P: st.P, frame: st.frame, t: now, dt });

  if (res.setup) {
    if (st.setup !== res.setup) { st.setup = res.setup; st.setupSince = now; }
    if (now - st.setupSince > SETUP_DELAY_MS) {
      if (st.hint?.code !== res.setup) showHint('setup', { code: res.setup, ...SETUP[res.setup], joints: [], muscles: [] });
      sound.say(SETUP[res.setup].say, { cooldown: 6000 });
    }
  } else if (st.setup) {
    st.setup = null;
    if (st.hint?.kind === 'setup') hideHint();
  }

  for (const e of res.events) {
    if (e.type === 'fault') {
      showHint('fault', e);
      sound.say(e.say, { urgent: true, cooldown: 2500 });
      const key = `${ex.id}:${e.code}`;
      if (!st.snapKeys.has(key) && st.snaps.length + st.snapPending.length < MAX_SNAPS) {
        st.snapKeys.add(key);
        st.snapPending.push({ fault: e, exName: ex.name });
      }
    } else if (e.type === 'rep') {
      updateCount(e.clean);
      if (e.clean) {
        sound.tone('good');
        if (e.streak >= 5 && e.streak % 5 === 0) sound.say(`${e.streak} чистых подряд!`, { urgent: true, cooldown: 0 });
        else sound.say(String(e.total), { cooldown: 0 });
        if (st.hint?.kind === 'fault') st.hintUntil = Math.min(st.hintUntil, now + 900);
      } else {
        sound.tone('bad');
      }
    }
  }
  if (st.hint?.kind === 'fault' && now > st.hintUntil) hideHint();

  if (ex.done) {
    st.nextAt = now + 1500;
    sound.tone('done');
    sound.say(st.idx + 1 < st.workout.length ? 'Готово. Следующее упражнение' : 'Готово', { urgent: true, cooldown: 0 });
  }
}

function skipExercise() {
  st.ex.skipped = true;
  st.snapPending = [];
  sound.say('Пропускаем', { urgent: true, cooldown: 0 });
  nextExercise();
}

function nextExercise() {
  st.nextAt = 0;
  st.idx++;
  if (st.idx < st.workout.length) beginTransition();
  else finishWorkout();
}

function updateCount(flash) {
  const ex = st.ex;
  $('#hud-count').textContent = ex.total;
  $('#hud-clean').textContent = `${ex.clean} ${plural(ex.clean, ['чистый', 'чистых', 'чистых'])}`;
  $('#hud-streak').textContent = ex.streak >= 3 ? `серия ${ex.streak}` : '';
  if (flash === undefined) return;
  const box = $('.hud-count');
  box.classList.remove('flash-good', 'flash-bad');
  void box.offsetWidth; // перезапуск анимации
  box.classList.add(flash ? 'flash-good' : 'flash-bad');
}

function showHint(kind, d) {
  st.hint = { kind, ...d };
  st.hintUntil = performance.now() + HINT_MS;
  const el = $('#hint');
  el.dataset.kind = kind;
  $('#hint-kind').textContent = kind === 'fault' ? 'Поправка' : 'Положение перед камерой';
  $('#hint-what').textContent = d.what;
  $('#hint-fix').textContent = d.fix;
  el.classList.add('show');
}

function hideHint() {
  st.hint = null;
  $('#hint').classList.remove('show');
}

// ─── Стоп-кадры ошибок
// Каждый второй кадр упражнения кладём в короткий буфер (уменьшенным, вместе с подсветкой мышц).
// При ошибке берём из последних 1,6 с кадр с максимальной нагрузкой — это пик движения, где ошибка видна лучше всего.
function bodyCrop() {
  const pts = st.S.filter(Boolean);
  if (pts.length < 8) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const pad = (y1 - y0) * 0.16 + 24;
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad * 0.6;
  let w = x1 - x0, h = y1 - y0;
  const ratio = SNAP_W / SNAP_H;
  if (w / h > ratio) { const nh = w / ratio; y0 -= (nh - h) / 2; h = nh; } else { const nw = h * ratio; x0 -= (nw - w) / 2; w = nw; }
  return { x: x0, y: y0, w, h };
}

function activationScore(act) {
  let s = 0;
  for (const v of Object.values(act)) s += typeof v === 'number' ? v : (v.left || 0) + (v.right || 0);
  return s;
}

function bufferFrame(now) {
  if (st.bufferTick++ % 2 && !st.snapPending.length) return;
  const crop = bodyCrop();
  if (!crop) return;
  const f = st.buffer.length >= 14 ? st.buffer.shift() : { c: document.createElement('canvas') };
  f.c.width = SNAP_W;
  f.c.height = SNAP_H;
  const g = f.c.getContext('2d');
  const { cw, ch, scale, ox, oy } = st.view;
  const k = SNAP_W / crop.w;
  g.fillStyle = '#161a22';
  g.fillRect(0, 0, SNAP_W, SNAP_H);
  g.setTransform(k, 0, 0, k, -crop.x * k, -crop.y * k); // экранные координаты → кадр
  g.save();
  g.translate(cw, 0);
  g.scale(-1, 1);
  g.filter = CAM_FILTER;
  g.drawImage(video, ox, oy, st.frame.w * scale, st.frame.h * scale);
  g.restore();
  g.filter = 'none';
  g.drawImage(canvas, 0, 0, cw, ch);
  g.setTransform(1, 0, 0, 1, 0, 0);
  f.crop = crop;
  f.k = k;
  f.S = st.S.map((p) => p && { x: p.x, y: p.y });
  f.score = activationScore(st.ex.activation);
  f.t = now;
  st.buffer.push(f);
}

function takeSnapshots(now) {
  const recent = st.buffer.filter((f) => now - f.t < 1600);
  if (!recent.length) { st.snapPending = []; return; }
  const best = recent.reduce((a, b) => (b.score > a.score ? b : a));
  for (const { fault, exName } of st.snapPending) {
    const c = document.createElement('canvas');
    c.width = SNAP_W;
    c.height = SNAP_H;
    const g = c.getContext('2d');
    g.drawImage(best.c, 0, 0);
    g.lineWidth = 2.5;
    g.strokeStyle = 'rgba(255, 212, 59, 0.95)';
    for (const j of new Set(fault.joints)) {
      const p = best.S[j];
      if (!p) continue;
      g.beginPath();
      g.arc((p.x - best.crop.x) * best.k, (p.y - best.crop.y) * best.k, 11, 0, Math.PI * 2);
      g.stroke();
    }
    try {
      st.snaps.push({ img: c.toDataURL('image/jpeg', 0.82), exName, what: fault.what, fix: fault.fix });
    } catch (e) { console.warn('Стоп-кадр не сохранился', e); }
  }
  st.snapPending = [];
}

// ─── Итоги
function finishWorkout() {
  const exs = st.workout;
  const total = exs.reduce((s, e) => s + e.total, 0);
  const clean = exs.reduce((s, e) => s + e.clean, 0);
  const bestStreak = exs.reduce((m, e) => Math.max(m, e.bestStreak), 0);
  const score = clean * 10 + (total - clean) * 4 + bestStreak * 3;
  const tech = total ? Math.round((clean / total) * 100) : 0;
  const secs = Math.round((performance.now() - st.startedAt) / 1000);

  const history = loadHistory();
  const prevBest = history.reduce((m, h) => Math.max(m, h.score), 0);
  saveHistory([{ date: Date.now(), title: st.plan.title, score, tech, total, clean, bestStreak, secs }, ...history].slice(0, 30));

  $('#sum-title').textContent = exs.length > 1 ? 'Тренировка завершена' : `${st.plan.title} — готово`;
  $('#sum-score').textContent = score;
  $('#sum-score-unit').textContent = plural(score, ['балл', 'балла', 'баллов']);
  $('#sum-record').textContent = score > prevBest && history.length ? `Новый рекорд — прошлый лучший результат ${prevBest}` : '';
  $('#sum-tech').textContent = `${tech}%`;
  $('#sum-reps').textContent = `${clean} из ${total}`;
  $('#sum-streak').textContent = bestStreak;
  $('#sum-time').textContent = fmtDuration(secs);

  $('#sum-ex').innerHTML = exs.map((e) => {
    let tip;
    if (e.skipped && !e.total) tip = 'Пропущено';
    else {
      const top = Object.entries(e.faultCounts).sort((a, b) => b[1] - a[1])[0];
      if (top) {
        const d = e.describe(top[0], e.faultSides[top[0]]);
        tip = `Чаще всего: ${d.what.toLowerCase()} (${top[1]} ${plural(top[1], ['повтор', 'повтора', 'повторов'])}). ${d.fix}.`;
      } else tip = e.total ? 'Без ошибок — чистая техника.' : '';
    }
    const num = e.skipped && !e.total ? '—' : `${e.clean} из ${e.total} чистых`;
    return `<li><p class="se-head"><span>${esc(e.name)}</span><span class="se-num">${num}</span></p><p class="se-tip">${esc(tip)}</p></li>`;
  }).join('');

  // Анатомия: какие мышцы работали и где нагрузка ушла не туда из-за ошибок.
  const load = {};
  for (const e of exs) for (const [m, v] of Object.entries(e.load())) load[m] = (load[m] || 0) + v;
  $('#sum-map').innerHTML = bodyMapSVG(load);
  const ranked = Object.entries(load).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = ranked[0]?.[1] || 1;
  $('#sum-muscles').innerHTML = ranked.map(([id, v]) =>
    `<li style="--v:${(v / max).toFixed(2)}"><span>${MUSCLES[id].ru}</span><i lang="la">${MUSCLES[id].la}</i></li>`).join('');

  const notes = [];
  for (const e of exs) {
    for (const [code, n] of Object.entries(e.faultCounts)) {
      for (const m of Object.keys(e.loadPerFault?.[code] || {})) {
        const why = e.describe(code, e.faultSides[code]).what.toLowerCase();
        notes.push(`Лишняя нагрузка: ${MUSCLES[m].ru.toLowerCase()}. Причина — ${why} (${n} ${plural(n, ['повтор', 'повтора', 'повторов'])}).`);
      }
    }
  }
  $('#sum-notes').textContent = notes.join(' ');

  $('#sum-snaps').innerHTML = st.snaps.map((s) => `<figure class="snap">
      <img src="${s.img}" alt="Стоп-кадр: ${esc(s.what)}" width="${SNAP_W}" height="${SNAP_H}">
      <figcaption><span class="snap-ex">${esc(s.exName)}</span><b>${esc(s.what)}</b><span>${esc(s.fix)}</span></figcaption>
    </figure>`).join('');
  $('#sum-snaps-wrap').hidden = !st.snaps.length;

  go('summary');
  sound.tone('done');
  sound.say(`${exs.length > 1 ? 'Тренировка завершена' : 'Готово'}. ${score} ${plural(score, ['балл', 'балла', 'баллов'])}, техника ${tech} процентов`, { urgent: true, cooldown: 0 });
}

// ─── Прогресс
function showHistory() {
  const list = loadHistory();
  const best = list.reduce((m, h) => Math.max(m, h.score), 0);
  $('#hist-best').textContent = list.length ? `Лучший результат — ${best} ${plural(best, ['балл', 'балла', 'баллов'])}` : '';
  $('#hist-list').innerHTML = list.length
    ? list.slice(0, 8).map((e) => `<li${e.score === best ? ' class="best"' : ''}>
        <span class="h-when"><time>${fmtDate(e.date)}</time><span>${esc(e.title || 'Тренировка')}</span></span>
        <span class="h-score">${e.score}</span>
        <span>техника ${e.tech}%</span><span>${e.total} ${plural(e.total, ['повтор', 'повтора', 'повторов'])}</span></li>`).join('')
    : '<li class="empty">Здесь появятся твои тренировки. Вернись в меню и подними правую руку, чтобы начать первую.</li>';
  $('#hist-chart').innerHTML = sparkline(list.slice(0, 10).reverse().map((e) => e.tech));
  go('history');
}

// Линия техники (%) по последним тренировкам.
function sparkline(values) {
  if (values.length < 2) return '';
  const w = 320, h = 80, p = 6;
  const pts = values.map((v, i) => [p + (i * (w - 2 * p)) / (values.length - 1), h - p - (v / 100) * (h - 2 * p)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return `<p class="hist-sub">Техника по последним тренировкам</p>
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Техника по последним тренировкам">
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="4" fill="var(--muscle)"/></svg>`;
}

// ─── Отрисовка поверх видео
function render(now) {
  const { cw, ch } = st.view;
  ctx.clearRect(0, 0, cw, ch);
  const S = st.S;
  if (!S.length) return;

  if (st.screen === 'exercise') {
    const ex = st.ex;
    const faultMuscles = new Set();
    const joints = [];
    for (const [code, side] of ex.live) {
      const d = ex.describe(code, side);
      d.muscles.forEach((m) => faultMuscles.add(m));
      joints.push(...d.joints);
    }
    if (st.hint?.kind === 'fault') {
      st.hint.muscles.forEach((m) => faultMuscles.add(m));
      joints.push(...st.hint.joints);
    }
    drawBones(ctx, S, 0.35);
    drawMuscles(ctx, S, ex.activation, faultMuscles, now);
    drawJoints(ctx, S);
    drawFaultJoints(ctx, S, joints, now);
    drawLabels(ctx, S, ex.activation, ex.muscles, cw, ch);
  } else if (st.screen === 'transition') {
    // Подсвечиваем мышцы следующего упражнения прямо на человеке.
    const glow = 0.4 + 0.15 * Math.sin(now / 380);
    drawBones(ctx, S, 0.35);
    drawMuscles(ctx, S, Object.fromEntries(st.ex.muscles.map((m) => [m, glow])), new Set(), now);
    drawJoints(ctx, S);
  } else if (['menu', 'catalog', 'summary', 'history'].includes(st.screen)) {
    const quiet = st.screen === 'summary' || st.screen === 'history';
    drawBones(ctx, S, quiet ? 0.18 : 0.45);
    drawJoints(ctx, S, quiet ? 0.3 : 0.8);
    const both = st.holds.both / BOTH_SEC;
    drawHandHold(ctx, S, { left: Math.max(st.holds.left / HOLD_SEC, both), right: Math.max(st.holds.right / HOLD_SEC, both) });
  }
}

function showDebug(dt) {
  const el = $('#debug');
  el.hidden = false;
  const m = st.screen === 'exercise' && st.ex ? st.ex.metrics : {};
  const f = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));
  el.textContent = [`fps ${Math.round(1 / dt)}`, `экран ${st.screen}`, ...Object.entries(m).map(([k, v]) => `${k} ${f(v)}`)].join('\n');
}
