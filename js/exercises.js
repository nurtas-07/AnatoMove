// Логика упражнений: подсчёт повторений и режим «ошибка».
// Всё на собственных правилах поверх 33 точек MediaPipe Pose — без обучения модели.
// Координаты точек — в пикселях кадра камеры (не зеркальные).
// Файл не трогает DOM, поэтому его можно проверять тестами в Node (tests/).

import { L, clamp, mid, dist, angle, tiltFromVertical, seen, allSeen, Ema, DecayingMax, Streak } from './geometry.js';

// Все пороги в одном месте — удобно подстраивать, глядя в режим ?debug.
export const CONFIG = {
  squat: {
    target: 8,
    enter: 0.75,     // глубина = длина бедра в кадре / длина бедра стоя. Ниже — повтор начался
    exit: 0.88,      // выше — человек встал, повтор закончен
    good: 0.45,      // до этой глубины нужно опуститься
    checkBelow: 0.65,// технику проверяем только в нижней части движения
    valgus: 0.8,     // расстояние между коленями < 80% расстояния между стопами → «колени внутрь»
    lean: 50,        // наклон корпуса вперёд, градусы
    shift: 0.35,     // смещение таза от центра стоп, доля ширины таза
    minStance: 0.5,  // стопы почти вместе — колени оценить нельзя
    sustain: 4,      // столько кадров подряд, чтобы ошибка засчиталась
    minRepMs: 350,   // быстрее — это дрожание точек, а не повтор
    fastMs: 900,     // весь повтор быстрее — «слишком быстро»
  },
  raise: {
    target: 8,
    enter: 45,       // угол «корпус — плечо» (отведение руки), градусы
    exit: 30,
    low: 75,         // средний пик ниже — руки не дошли до плеч
    high: 110,       // выше — руки над уровнем плеч
    asym: 20,        // разница между руками
    elbow: 140,      // угол в локте меньше — руки согнуты
    shrug: 0.72,     // шея в кадре короче 72% от исходной — плечи к ушам
    sustain: 4,
    minRepMs: 600,
    fastMs: 1000,
  },
  knees: {
    target: 12,      // всего, на обе ноги
    enter: 0.3,      // подъём колена: 0 — стоит, 1 — бедро параллельно полу
    exit: 0.15,
    good: 0.6,
    sway: 12,        // отклонение корпуса вбок, градусы
    sustain: 4,
    minRepMs: 250,
  },
  press: {
    target: 8,
    enter: 0.72,     // подъём кистей: (плечо − кисть) / длина руки. 1 — руки прямо над головой
    exit: 0.5,
    lock: 150,       // угол в локте наверху меньше — руки не выпрямлены
    asym: 0.18,
    shrug: 0.72,
    sustain: 4,
    minRepMs: 600,
    fastMs: 900,
  },
  bend: {
    target: 8,       // всего, на обе стороны
    enter: 10,       // наклон корпуса вбок, градусы
    exit: 5,
    good: 18,
    forward: 0.82,   // корпус в кадре короче 82% — наклон ушёл вперёд
    hips: 0.5,       // таз сместился от центра стоп больше чем на половину ширины таза
    sustain: 4,
    minRepMs: 500,
  },
  jacks: {
    target: 12,
    armsOpen: 100,   // угол «корпус — плечо», градусы
    armsClosed: 55,
    armsGood: 140,
    feetOpen: 1.3,   // расстояние между стопами / ширина плеч
    feetClosed: 1.05,
    feetGood: 1.5,
    minRepMs: 350,
  },
  minBodyHeight: 0.35, // доля высоты кадра, меньше — человек слишком далеко
};

// Подсказки по положению перед камерой. Это не ошибки техники, в статистику не идут.
export const SETUP = {
  nobody: { what: 'Не вижу тебя целиком', fix: 'Встань лицом к камере в 2–3 метрах', say: 'Встань перед камерой' },
  feet:   { what: 'Не видно колен и стоп', fix: 'Отойди на шаг назад — ноги должны быть в кадре', say: 'Отойди на шаг назад' },
  upper:  { what: 'Не видно рук', fix: 'Отойди назад, чтобы в кадре были локти и кисти', say: 'Отойди назад, мне не видно рук' },
  far:    { what: 'Ты слишком далеко', fix: 'Подойди на шаг ближе к камере', say: 'Подойди ближе' },
  turn:   { what: 'Ты стоишь боком', fix: 'Повернись к камере лицом', say: 'Повернись лицом к камере' },
  stance: { what: 'Стопы стоят вплотную', fix: 'Поставь стопы на ширину плеч, носки чуть наружу', say: 'Поставь стопы на ширину плеч' },
};

// Общая для нескольких упражнений ошибка темпа.
const FAST = {
  what: 'Слишком быстро',
  fix: 'Медленнее: 2 секунды вниз, 1 — вверх. Пусть работают мышцы, а не инерция',
  say: 'Медленнее',
  joints: () => [],
};

const pick = (v, side) => (typeof v === 'function' ? v(side) : v);
const leftRight = (side, l, r) => (side === 'left' ? l : r);

class Exercise {
  constructor(cfg) {
    this.cfg = cfg;
    this.target = cfg.target;
    this.total = 0;
    this.clean = 0;
    this.faultCounts = {};   // код ошибки → в скольких повторах встретилась
    this.faultSides = {};    // код ошибки → сторона в последний раз (для текста в итогах)
    this.activation = {};    // мышца → 0..1 (или {left, right}) — для подсветки
    this.live = new Map();   // ошибки, которые видны прямо сейчас → сторона
    this.metrics = {};       // для режима ?debug
    this.rep = null;
    this.skipped = false;
    this.streak = 0;         // чистых повторов подряд
    this.bestStreak = 0;
  }

  get done() { return this.total >= this.target; }

  describe(code, side) {
    const f = this.FAULTS[code];
    return {
      code, side,
      what: pick(f.what, side), fix: pick(f.fix, side), say: pick(f.say, side),
      joints: f.joints ? f.joints(side) : [],
      muscles: f.muscles || [],
    };
  }

  // Отмечаем ошибку: подсветка сейчас + событие, если в этом повторе она впервые.
  flag(code, side, events, rep = this.rep) {
    this.live.set(code, side);
    if (rep && !rep.faults.has(code)) {
      rep.faults.set(code, side);
      events.push({ type: 'fault', ...this.describe(code, side) });
    }
  }

  finishRep(events, rep = this.rep) {
    this.total++;
    const clean = rep.faults.size === 0;
    if (clean) {
      this.clean++;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else {
      this.streak = 0;
    }
    for (const [code, side] of rep.faults) {
      this.faultCounts[code] = (this.faultCounts[code] || 0) + 1;
      this.faultSides[code] = side;
    }
    events.push({
      type: 'rep', clean, total: this.total, cleanTotal: this.clean, streak: this.streak,
      faults: [...rep.faults.entries()].map(([c, s]) => this.describe(c, s)),
    });
  }

  // Весь повтор занял меньше fastMs — движение на инерции.
  checkTempo(rep, t, events) {
    if (this.cfg.fastMs && t - rep.start < this.cfg.fastMs) this.flag('fast', null, events, rep);
  }

  idle() {
    this.activation = {};
    this.live.clear();
  }

  positioning(P, frame, { lower = false, upper = false } = {}) {
    if (!P) return 'nobody';
    const core = [L.L_SHOULDER, L.R_SHOULDER, L.L_HIP, L.R_HIP];
    if (!allSeen(P, core, frame)) return 'nobody';
    if (lower && !allSeen(P, [L.L_KNEE, L.R_KNEE, L.L_ANKLE, L.R_ANKLE], frame)) return 'feet';
    // upper: 'elbows' — кисти могут уходить за верх кадра (руки над головой), нужны только локти.
    const arms = upper === 'elbows' ? [L.L_ELBOW, L.R_ELBOW] : [L.L_ELBOW, L.R_ELBOW, L.L_WRIST, L.R_WRIST];
    if (upper && !allSeen(P, arms, frame)) return 'upper';
    const sw = dist(P[L.L_SHOULDER], P[L.R_SHOULDER]);
    const torso = dist(mid(P[L.L_SHOULDER], P[L.R_SHOULDER]), mid(P[L.L_HIP], P[L.R_HIP]));
    if (sw < torso * 0.45) return 'turn';
    if (lower && frame && seen(P, L.NOSE, frame)) {
      const bodyH = Math.max(P[L.L_ANKLE].y, P[L.R_ANKLE].y) - P[L.NOSE].y;
      if (bodyH < frame.h * CONFIG.minBodyHeight) return 'far';
    }
    return null;
  }

  // Нагрузка на мышцы за всю тренировку — для анатомической карты в итогах.
  load() {
    const out = {};
    const add = (m, v) => { out[m] = (out[m] || 0) + v; };
    for (const [m, v] of Object.entries(this.loadPerRep)) add(m, v * this.total);
    for (const [code, n] of Object.entries(this.faultCounts)) {
      for (const [m, v] of Object.entries(this.loadPerFault?.[code] || {})) add(m, v * n);
    }
    return out;
  }
}

// ─────────────────────────────────────────────── Приседания
export class Squat extends Exercise {
  id = 'squat';
  name = 'Приседания';
  needs = { lower: true };
  how = 'Стопы на ширине плеч, лицом к камере. Опускайся, будто садишься на стул, и возвращайся вверх.';
  fact = 'Четыре головки четырёхглавой мышцы сходятся в одно сухожилие, внутри которого лежит надколенник — самая крупная сесамовидная кость тела.';
  muscles = ['quads', 'glutes', 'adductors', 'erectors'];
  loadPerRep = { quads: 1, glutes: 0.9, adductors: 0.6, erectors: 0.4 };
  loadPerFault = { lean: { erectors: 0.6 } };

  FAULTS = {
    valgus: {
      what: 'Колени заваливаются внутрь',
      fix: 'Разводи колени наружу — по линии носков',
      say: 'Колени наружу, по линии носков',
      joints: () => [L.L_KNEE, L.R_KNEE],
    },
    lean: {
      what: 'Корпус слишком наклонён вперёд',
      fix: 'Держи грудь выше и спину ровно, таз уводи назад',
      say: 'Грудь выше, спина ровная',
      joints: () => [L.L_SHOULDER, L.R_SHOULDER],
      muscles: ['erectors'],
    },
    shift: {
      what: (s) => `Вес смещён на ${leftRight(s, 'левую', 'правую')} ногу`,
      fix: 'Распредели вес поровну на обе стопы, таз держи по центру',
      say: 'Держи вес поровну на обеих ногах',
      joints: (s) => leftRight(s, [L.L_HIP, L.L_KNEE], [L.R_HIP, L.R_KNEE]),
    },
    shallow: {
      what: 'Не хватило глубины',
      fix: 'Опускайся ниже — бёдра почти параллельно полу',
      say: 'Садись глубже',
      joints: () => [L.L_HIP, L.R_HIP],
    },
    fast: FAST,
  };

  constructor(cfg = CONFIG.squat) {
    super(cfg);
    this.state = 'up';
    this.refL = new DecayingMax();
    this.refR = new DecayingMax();
    this.refTorso = new DecayingMax();
    this.depthEma = new Ema(0.5);
    this.s = { valgus: new Streak(), lean: new Streak(), shift: new Streak() };
  }

  update({ P, frame, t, dt }) {
    const C = this.cfg;
    const events = [];
    const setup = this.positioning(P, frame, this.needs);
    if (setup) { this.idle(); return { events, setup }; }

    const Ls = P[L.L_SHOULDER], Rs = P[L.R_SHOULDER];
    const Lh = P[L.L_HIP], Rh = P[L.R_HIP];
    const Lk = P[L.L_KNEE], Rk = P[L.R_KNEE];
    const La = P[L.L_ANKLE], Ra = P[L.R_ANKLE];

    // Глубина: при приседании бедро «укорачивается» в кадре (и спереди, и сбоку).
    const thighL = Math.max(1, Lk.y - Lh.y);
    const thighR = Math.max(1, Rk.y - Rh.y);
    const dL = clamp(thighL / this.refL.update(thighL, dt), 0, 1.2);
    const dR = clamp(thighR / this.refR.update(thighR, dt), 0, 1.2);
    const depth = this.depthEma.next((dL + dR) / 2);

    // Наклон корпуса: насколько корпус стал короче по вертикали, чем стоя.
    const ms = mid(Ls, Rs), mh = mid(Lh, Rh), ma = mid(La, Ra);
    const torso = Math.max(1, mh.y - ms.y);
    const lean = (Math.acos(clamp(torso / this.refTorso.update(torso, dt))) * 180) / Math.PI;

    const kneeW = Math.abs(Lk.x - Rk.x);
    const ankleW = Math.max(1, Math.abs(La.x - Ra.x));
    const shoulderW = Math.abs(Ls.x - Rs.x);
    const hipW = Math.max(1, Math.abs(Lh.x - Rh.x));
    const valgus = kneeW / ankleW;
    // В кадре правая сторона человека — слева (меньше x). Таз ушёл влево по x → вес на правой ноге.
    const shift = (mh.x - ma.x) / hipW;

    this.metrics = { state: this.state, depth, lean, valgus, shift };

    if (this.state === 'up' && ankleW < shoulderW * C.minStance) {
      this.idle();
      return { events, setup: 'stance' };
    }

    if (this.state === 'up' && depth < C.enter) {
      this.state = 'down';
      this.rep = { start: t, min: depth, faults: new Map() };
      Object.values(this.s).forEach((s) => { s.n = 0; });
    }

    this.live.clear();
    if (this.state === 'down') {
      const rep = this.rep;
      rep.min = Math.min(rep.min, depth);
      if (depth < C.checkBelow) {
        if (this.s.valgus.push(valgus < C.valgus) >= C.sustain) this.flag('valgus', null, events);
        if (this.s.lean.push(lean > C.lean) >= C.sustain) this.flag('lean', null, events);
        if (this.s.shift.push(Math.abs(shift) > C.shift) >= C.sustain) this.flag('shift', shift < 0 ? 'right' : 'left', events);
      }
      if (depth > C.exit) {
        if (t - rep.start >= C.minRepMs) {
          if (rep.min > C.good) this.flag('shallow', null, events);
          this.checkTempo(rep, t, events);
          this.finishRep(events);
        }
        this.state = 'up';
        this.rep = null;
        this.live.clear();
      }
    }

    const work = clamp((1 - depth) / 0.7);
    this.activation = { quads: work, glutes: work * 0.9, adductors: work * 0.6, erectors: 0.15 + work * 0.4 };
    return { events, setup: null };
  }
}

// ─────────────────────────────────────────────── Разведение рук в стороны
export class LateralRaise extends Exercise {
  id = 'raise';
  name = 'Разведение рук в стороны';
  needs = { upper: true };
  how = 'Руки вдоль тела, лицом к камере. Разводи прямые руки в стороны до уровня плеч и медленно опускай.';
  fact = 'Примерно до горизонтали руку поднимает дельтовидная мышца, а выше в работу включается поворот лопатки — его обеспечивают трапециевидная и передняя зубчатая мышцы.';
  muscles = ['deltoids', 'traps'];
  loadPerRep = { deltoids: 1, traps: 0.3 };
  loadPerFault = { high: { traps: 0.7 }, shrug: { traps: 0.6 } };

  FAULTS = {
    high: {
      what: 'Руки поднялись выше плеч',
      fix: 'Поднимай только до горизонтали — выше работает уже трапеция, а не дельта',
      say: 'Руки только до уровня плеч',
      joints: () => [L.L_WRIST, L.R_WRIST],
      muscles: ['traps'],
    },
    low: {
      what: 'Руки не дошли до уровня плеч',
      fix: 'Поднимай руки выше — до линии плеч',
      say: 'Руки выше, до уровня плеч',
      joints: () => [L.L_ELBOW, L.R_ELBOW],
    },
    elbows: {
      what: 'Руки сильно согнуты в локтях',
      fix: 'Держи руки почти прямыми — локоть лишь слегка согнут',
      say: 'Выпрями руки',
      joints: () => [L.L_ELBOW, L.R_ELBOW],
    },
    asym: {
      what: (s) => `${leftRight(s, 'Левая', 'Правая')} рука отстаёт`,
      fix: 'Поднимай обе руки одновременно и на одну высоту',
      say: (s) => `${leftRight(s, 'Левую', 'Правую')} руку выше`,
      joints: (s) => leftRight(s, [L.L_ELBOW, L.L_WRIST], [L.R_ELBOW, L.R_WRIST]),
    },
    shrug: {
      what: 'Плечи поднимаются к ушам',
      fix: 'Опусти плечи вниз и назад — рука движется только в плечевом суставе',
      say: 'Опусти плечи',
      joints: () => [L.L_SHOULDER, L.R_SHOULDER],
      muscles: ['traps'],
    },
    fast: FAST,
  };

  constructor(cfg = CONFIG.raise) {
    super(cfg);
    this.state = 'down';
    this.emaL = new Ema(0.5);
    this.emaR = new Ema(0.5);
    this.neckBase = null;
    this.s = { high: new Streak(), elbows: new Streak(), shrug: new Streak() };
  }

  update({ P, frame, t }) {
    const C = this.cfg;
    const events = [];
    const setup = this.positioning(P, frame, this.needs);
    if (setup) { this.idle(); return { events, setup }; }

    const Ls = P[L.L_SHOULDER], Rs = P[L.R_SHOULDER];
    const aL = this.emaL.next(angle(P[L.L_HIP], Ls, P[L.L_ELBOW]));
    const aR = this.emaR.next(angle(P[L.R_HIP], Rs, P[L.R_ELBOW]));
    const elbL = angle(Ls, P[L.L_ELBOW], P[L.L_WRIST]);
    const elbR = angle(Rs, P[L.R_ELBOW], P[L.R_WRIST]);
    const top = Math.max(aL, aR);

    // «Длина шеи» в кадре: плечи ползут к ушам → она уменьшается.
    let neck = null;
    if (seen(P, L.L_EAR, frame) && seen(P, L.R_EAR, frame)) {
      neck = (mid(Ls, Rs).y - mid(P[L.L_EAR], P[L.R_EAR]).y) / Math.max(1, dist(Ls, Rs));
      if (this.state === 'down') {
        this.neckBase = this.neckBase === null ? neck : this.neckBase + (neck - this.neckBase) * 0.05;
      }
    }

    this.metrics = { state: this.state, left: aL, right: aR, elbowL: elbL, elbowR: elbR, neck, neckBase: this.neckBase };

    if (this.state === 'down' && top > C.enter) {
      this.state = 'up';
      this.rep = { start: t, maxL: aL, maxR: aR, faults: new Map() };
      Object.values(this.s).forEach((s) => { s.n = 0; });
    }

    this.live.clear();
    if (this.state === 'up') {
      const rep = this.rep;
      rep.maxL = Math.max(rep.maxL, aL);
      rep.maxR = Math.max(rep.maxR, aR);
      if (this.s.high.push(top > C.high) >= C.sustain) this.flag('high', null, events);
      const bent = (aL > 60 && elbL < C.elbow) || (aR > 60 && elbR < C.elbow);
      if (this.s.elbows.push(bent) >= C.sustain) this.flag('elbows', null, events);
      if (neck !== null && this.neckBase && this.s.shrug.push(neck < this.neckBase * C.shrug) >= C.sustain) {
        this.flag('shrug', null, events);
      }
      if (top < C.exit) {
        if (t - rep.start >= C.minRepMs) {
          if (Math.abs(rep.maxL - rep.maxR) > C.asym) this.flag('asym', rep.maxL < rep.maxR ? 'left' : 'right', events);
          else if ((rep.maxL + rep.maxR) / 2 < C.low) this.flag('low', null, events);
          this.checkTempo(rep, t, events);
          this.finishRep(events);
        }
        this.state = 'down';
        this.rep = null;
        this.live.clear();
      }
    }

    const avg = (aL + aR) / 2;
    this.activation = {
      deltoids: clamp(avg / 90),
      traps: clamp(clamp((top - 85) / 35) * 0.9 + (this.live.has('shrug') ? 0.5 : 0)),
    };
    return { events, setup: null };
  }
}

// ─────────────────────────────────────────────── Подъём коленей
export class HighKnees extends Exercise {
  id = 'knees';
  name = 'Подъём коленей';
  needs = { lower: true };
  how = 'Лицом к камере, спина прямая. Поочерёдно поднимай колени до уровня таза, как при ходьбе на месте.';
  fact = 'Подвздошно-поясничная мышца — единственная, что соединяет позвоночник с бедренной костью. Это главный сгибатель бедра.';
  muscles = ['iliopsoas', 'quads', 'abs'];
  loadPerRep = { iliopsoas: 0.55, quads: 0.3, abs: 0.3 };
  loadPerFault = { sway: { abs: 0.2 } };

  FAULTS = {
    low: {
      what: (s) => `${leftRight(s, 'Левое', 'Правое')} колено поднято низко`,
      fix: 'Поднимай колено до уровня таза — бедро параллельно полу',
      say: 'Колено выше',
      joints: (s) => leftRight(s, [L.L_KNEE], [L.R_KNEE]),
    },
    sway: {
      what: 'Корпус заваливается в сторону',
      fix: 'Держи спину ровно и напряги пресс — корпус не качается',
      say: 'Корпус ровно, напряги пресс',
      joints: () => [L.L_SHOULDER, L.R_SHOULDER],
      muscles: ['abs'],
    },
    alternate: {
      what: (s) => `Три раза подряд ${leftRight(s, 'левая', 'правая')} нога`,
      fix: (s) => `Чередуй ноги — сейчас очередь ${leftRight(s, 'правой', 'левой')}`,
      say: (s) => `Теперь ${leftRight(s, 'правое', 'левое')} колено`,
      joints: (s) => leftRight(s, [L.L_KNEE], [L.R_KNEE]),
    },
  };

  constructor(cfg = CONFIG.knees) {
    super(cfg);
    const leg = (knee, hip) => ({ state: 'down', ref: new DecayingMax(), ema: new Ema(0.5), rep: null, knee, hip });
    this.legs = { left: leg(L.L_KNEE, L.L_HIP), right: leg(L.R_KNEE, L.R_HIP) };
    this.lastSide = null;
    this.sameRun = 0;
    this.sway = new Streak();
  }

  update({ P, frame, t, dt }) {
    const C = this.cfg;
    const events = [];
    const setup = this.positioning(P, frame, this.needs);
    if (setup) { this.idle(); return { events, setup }; }

    const ms = mid(P[L.L_SHOULDER], P[L.R_SHOULDER]);
    const mh = mid(P[L.L_HIP], P[L.R_HIP]);
    const swayDeg = tiltFromVertical(mh, ms);
    const swayOn = this.sway.push(swayDeg > C.sway) >= C.sustain;

    this.live.clear();
    const lift = {};
    for (const side of ['left', 'right']) {
      const g = this.legs[side];
      const thigh = Math.max(1, P[g.knee].y - P[g.hip].y);
      // Эталон длины бедра обновляем, только когда нога опущена.
      const ref = g.state === 'down' || !g.ref.v ? g.ref.update(thigh, dt) : g.ref.v;
      lift[side] = g.ema.next(clamp(1 - thigh / ref, 0, 1.2));

      if (g.state === 'down' && lift[side] > C.enter) {
        g.state = 'up';
        g.rep = { start: t, peak: lift[side], faults: new Map() };
      } else if (g.state === 'up') {
        g.rep.peak = Math.max(g.rep.peak, lift[side]);
        if (swayOn) this.flag('sway', null, events, g.rep);
        if (lift[side] < C.exit) {
          if (t - g.rep.start >= C.minRepMs) {
            if (g.rep.peak < C.good) this.flag('low', side, events, g.rep);
            if (this.lastSide === side) this.sameRun++;
            else { this.lastSide = side; this.sameRun = 1; }
            if (this.sameRun >= 3) this.flag('alternate', side, events, g.rep);
            this.finishRep(events, g.rep);
          }
          g.state = 'down';
          g.rep = null;
        }
      }
    }

    this.metrics = { left: lift.left, right: lift.right, sway: swayDeg, stateL: this.legs.left.state, stateR: this.legs.right.state };
    const act = (v) => clamp(v / 0.8);
    this.activation = {
      iliopsoas: { left: act(lift.left), right: act(lift.right) },
      quads: { left: act(lift.left) * 0.6, right: act(lift.right) * 0.6 },
      abs: clamp(0.25 + 0.4 * Math.max(lift.left, lift.right) + (swayOn ? 0.3 : 0)),
    };
    return { events, setup: null };
  }
}

// ─────────────────────────────────────────────── Жим руками вверх
export class OverheadPress extends Exercise {
  id = 'press';
  name = 'Жим руками вверх';
  needs = { upper: true };
  how = 'Лицом к камере. Локти на уровне плеч, кисти смотрят вверх. Выпрями руки над головой и вернись.';
  fact = 'Трёхглавая мышца занимает почти всю заднюю поверхность плеча и разгибает локоть: без неё руки над головой не выпрямить.';
  muscles = ['deltoids', 'triceps', 'traps'];
  loadPerRep = { deltoids: 0.9, triceps: 0.8, traps: 0.3 };
  loadPerFault = { shrug: { traps: 0.6 } };

  FAULTS = {
    lockout: {
      what: 'Руки не выпрямляются до конца',
      fix: 'В верхней точке полностью выпрями локти — кисти над плечами',
      say: 'Выпрями руки до конца',
      joints: () => [L.L_ELBOW, L.R_ELBOW],
    },
    asym: {
      what: (s) => `${leftRight(s, 'Левая', 'Правая')} рука отстаёт`,
      fix: 'Выжимай обе руки одновременно и на одну высоту',
      say: (s) => `${leftRight(s, 'Левую', 'Правую')} руку выше`,
      joints: (s) => leftRight(s, [L.L_ELBOW, L.L_WRIST], [L.R_ELBOW, L.R_WRIST]),
    },
    shrug: {
      what: 'Плечи поднимаются к ушам',
      fix: 'Держи плечи опущенными — жми руками, а не шеей',
      say: 'Опусти плечи',
      joints: () => [L.L_SHOULDER, L.R_SHOULDER],
      muscles: ['traps'],
    },
    fast: FAST,
  };

  constructor(cfg = CONFIG.press) {
    super(cfg);
    this.state = 'down';
    this.emaL = new Ema(0.5);
    this.emaR = new Ema(0.5);
    this.neckBase = null;
    this.s = { shrug: new Streak() };
  }

  update({ P, frame, t }) {
    const C = this.cfg;
    const events = [];
    const setup = this.positioning(P, frame, this.needs);
    if (setup) { this.idle(); return { events, setup }; }

    const Ls = P[L.L_SHOULDER], Rs = P[L.R_SHOULDER];
    const Le = P[L.L_ELBOW], Re = P[L.R_ELBOW], Lw = P[L.L_WRIST], Rw = P[L.R_WRIST];
    // Подъём кисти относительно плеча в долях длины руки: −1 — рука внизу, 1 — прямо над головой.
    const liftL = this.emaL.next((Ls.y - Lw.y) / Math.max(1, dist(Ls, Le) + dist(Le, Lw)));
    const liftR = this.emaR.next((Rs.y - Rw.y) / Math.max(1, dist(Rs, Re) + dist(Re, Rw)));
    const lift = (liftL + liftR) / 2;
    const elbL = angle(Ls, Le, Lw), elbR = angle(Rs, Re, Rw);

    let neck = null;
    if (seen(P, L.L_EAR, frame) && seen(P, L.R_EAR, frame)) {
      neck = (mid(Ls, Rs).y - mid(P[L.L_EAR], P[L.R_EAR]).y) / Math.max(1, dist(Ls, Rs));
      if (this.state === 'down') {
        this.neckBase = this.neckBase === null ? neck : this.neckBase + (neck - this.neckBase) * 0.05;
      }
    }
    this.metrics = { state: this.state, liftL, liftR, elbowL: elbL, elbowR: elbR, neck, neckBase: this.neckBase };

    if (this.state === 'down' && lift > C.enter) {
      this.state = 'up';
      this.rep = { start: t, lock: Math.min(elbL, elbR), maxL: liftL, maxR: liftR, faults: new Map() };
      this.s.shrug.n = 0;
    }

    this.live.clear();
    if (this.state === 'up') {
      const rep = this.rep;
      rep.lock = Math.max(rep.lock, Math.min(elbL, elbR));
      rep.maxL = Math.max(rep.maxL, liftL);
      rep.maxR = Math.max(rep.maxR, liftR);
      if (neck !== null && this.neckBase && this.s.shrug.push(neck < this.neckBase * C.shrug) >= C.sustain) {
        this.flag('shrug', null, events);
      }
      if (lift < C.exit) {
        if (t - rep.start >= C.minRepMs) {
          if (rep.lock < C.lock) this.flag('lockout', null, events);
          if (Math.abs(rep.maxL - rep.maxR) > C.asym) this.flag('asym', rep.maxL < rep.maxR ? 'left' : 'right', events);
          this.checkTempo(rep, t, events);
          this.finishRep(events);
        }
        this.state = 'down';
        this.rep = null;
        this.live.clear();
      }
    }

    const straight = clamp((Math.min(elbL, elbR) - 80) / 90);
    this.activation = {
      deltoids: clamp((lift + 0.3) / 1.1),
      triceps: lift > 0.2 ? straight : straight * 0.3,
      traps: clamp(clamp((lift - 0.6) / 0.4) * 0.6 + (this.live.has('shrug') ? 0.5 : 0)),
    };
    return { events, setup: null };
  }
}

// ─────────────────────────────────────────────── Боковые наклоны
export class SideBend extends Exercise {
  id = 'bend';
  name = 'Боковые наклоны';
  needs = { lower: true };
  how = 'Стопы на ширине плеч, руки вдоль тела. Наклоняйся поочерёдно влево и вправо — ладонь скользит по бедру.';
  fact = 'Волокна наружной косой мышцы живота идут вниз и к центру — так же, как пальцы рук, засунутых в карманы куртки.';
  muscles = ['obliques', 'ql'];
  loadPerRep = { obliques: 0.6, ql: 0.45 };
  loadPerFault = { forward: { erectors: 0.5 } };

  FAULTS = {
    shallow: {
      what: (s) => `Слабый наклон ${leftRight(s, 'влево', 'вправо')}`,
      fix: 'Наклоняйся глубже — ладонь скользит по бедру почти до колена',
      say: 'Наклон глубже',
      joints: (s) => leftRight(s, [L.L_SHOULDER], [L.R_SHOULDER]),
    },
    forward: {
      what: 'Корпус уходит вперёд',
      fix: 'Наклоняйся строго в сторону — будто стоишь между двумя стёклами',
      say: 'Строго в сторону, не вперёд',
      joints: () => [L.L_SHOULDER, L.R_SHOULDER],
      muscles: ['erectors'],
    },
    hips: {
      what: 'Таз уезжает в сторону',
      fix: 'Держи таз над стопами — наклон идёт только в пояснице',
      say: 'Таз на месте',
      joints: () => [L.L_HIP, L.R_HIP],
    },
    alternate: {
      what: (s) => `Три раза подряд наклон ${leftRight(s, 'влево', 'вправо')}`,
      fix: (s) => `Чередуй стороны — сейчас наклон ${leftRight(s, 'вправо', 'влево')}`,
      say: (s) => `Теперь ${leftRight(s, 'вправо', 'влево')}`,
      joints: () => [],
    },
  };

  constructor(cfg = CONFIG.bend) {
    super(cfg);
    this.state = 'center';
    this.side = null;
    this.ema = new Ema(0.5);
    this.ref = new DecayingMax();
    this.lastSide = null;
    this.sameRun = 0;
    this.s = { forward: new Streak(), hips: new Streak() };
  }

  update({ P, frame, t, dt }) {
    const C = this.cfg;
    const events = [];
    const setup = this.positioning(P, frame, this.needs);
    if (setup) { this.idle(); return { events, setup }; }

    const ms = mid(P[L.L_SHOULDER], P[L.R_SHOULDER]);
    const mh = mid(P[L.L_HIP], P[L.R_HIP]);
    const ma = mid(P[L.L_ANKLE], P[L.R_ANKLE]);
    // Знак: плечи ушли вправо по кадру (к левому боку человека) → наклон влево.
    const tilt = this.ema.next((Math.atan2(ms.x - mh.x, mh.y - ms.y) * 180) / Math.PI);
    // Наклон вбок не меняет длину корпуса в кадре, а наклон вперёд — укорачивает.
    const torso = dist(ms, mh);
    const ratio = torso / this.ref.update(torso, dt);
    const shift = (mh.x - ma.x) / Math.max(1, dist(P[L.L_HIP], P[L.R_HIP]));
    const abs = Math.abs(tilt);
    this.metrics = { state: this.state, tilt, torso: ratio, shift };

    if (this.state === 'center' && abs > C.enter) {
      this.state = 'bent';
      this.side = tilt > 0 ? 'left' : 'right';
      this.rep = { start: t, peak: abs, faults: new Map() };
      Object.values(this.s).forEach((s) => { s.n = 0; });
    }

    this.live.clear();
    if (this.state === 'bent') {
      const rep = this.rep;
      rep.peak = Math.max(rep.peak, abs);
      if (this.s.forward.push(ratio < C.forward) >= C.sustain) this.flag('forward', null, events);
      if (this.s.hips.push(Math.abs(shift) > C.hips) >= C.sustain) this.flag('hips', null, events);
      if (abs < C.exit) {
        if (t - rep.start >= C.minRepMs) {
          if (rep.peak < C.good) this.flag('shallow', this.side, events);
          if (this.lastSide === this.side) this.sameRun++;
          else { this.lastSide = this.side; this.sameRun = 1; }
          if (this.sameRun >= 3) this.flag('alternate', this.side, events);
          this.finishRep(events);
        }
        this.state = 'center';
        this.rep = null;
        this.live.clear();
      }
    }

    // Наклон влево контролируют мышцы правого бока: они растягиваются и возвращают корпус.
    const a = clamp(abs / 25);
    let obl = { left: a * 0.3, right: a * 0.3 };
    if (this.state === 'bent') {
      const far = this.side === 'left' ? 'right' : 'left';
      obl = { [far]: a, [this.side]: a * 0.45 };
    }
    this.activation = { obliques: obl, ql: { left: obl.left * 0.8, right: obl.right * 0.8 } };
    return { events, setup: null };
  }
}

// ─────────────────────────────────────────────── Прыжки «звёздочка»
export class JumpingJacks extends Exercise {
  id = 'jacks';
  name = 'Прыжки «звёздочка»';
  needs = { lower: true, upper: 'elbows' };
  how = 'Лицом к камере. В прыжке разведи ноги шире плеч и подними руки через стороны над головой, затем вернись.';
  fact = 'Икроножная мышца — двусуставная: она проходит и через коленный, и через голеностопный сустав, поэтому пружинит в каждом прыжке.';
  muscles = ['deltoids', 'gmed', 'calves', 'adductors'];
  loadPerRep = { deltoids: 0.5, gmed: 0.6, calves: 0.7, adductors: 0.4 };

  FAULTS = {
    arms: {
      what: 'Руки не доходят до верха',
      fix: 'Поднимай руки через стороны до конца — кисти над головой',
      say: 'Руки выше, над головой',
      joints: () => [L.L_ELBOW, L.R_ELBOW],
    },
    legs: {
      what: 'Ноги расходятся слишком узко',
      fix: 'В прыжке ставь стопы шире плеч',
      say: 'Ноги шире',
      joints: () => [L.L_ANKLE, L.R_ANKLE],
    },
  };

  constructor(cfg = CONFIG.jacks) {
    super(cfg);
    this.state = 'closed';
    this.emaA = new Ema(0.6);
    this.emaF = new Ema(0.6);
  }

  update({ P, frame, t }) {
    const C = this.cfg;
    const events = [];
    const setup = this.positioning(P, frame, this.needs);
    if (setup) { this.idle(); return { events, setup }; }

    const Ls = P[L.L_SHOULDER], Rs = P[L.R_SHOULDER];
    const arm = this.emaA.next((angle(P[L.L_HIP], Ls, P[L.L_ELBOW]) + angle(P[L.R_HIP], Rs, P[L.R_ELBOW])) / 2);
    const feet = this.emaF.next(Math.abs(P[L.L_ANKLE].x - P[L.R_ANKLE].x) / Math.max(1, dist(Ls, Rs)));
    this.metrics = { state: this.state, arm, feet };

    if (this.state === 'closed' && (arm > C.armsOpen || feet > C.feetOpen)) {
      this.state = 'open';
      this.rep = { start: t, arm, feet, faults: new Map() };
    }

    this.live.clear();
    if (this.state === 'open') {
      const rep = this.rep;
      rep.arm = Math.max(rep.arm, arm);
      rep.feet = Math.max(rep.feet, feet);
      if (arm < C.armsClosed && feet < C.feetClosed) {
        if (t - rep.start >= C.minRepMs) {
          if (rep.arm < C.armsGood) this.flag('arms', null, events);
          if (rep.feet < C.feetGood) this.flag('legs', null, events);
          this.finishRep(events);
        }
        this.state = 'closed';
        this.rep = null;
        this.live.clear();
      }
    }

    const legs = clamp((feet - 0.8) / 0.8);
    this.activation = {
      deltoids: clamp((arm - 30) / 120),
      gmed: legs,
      adductors: legs * 0.6,
      calves: this.state === 'open' ? 0.85 : 0.45,
    };
    return { events, setup: null };
  }
}

// Каталог в порядке полной тренировки: от силовых к кардио.
export const CATALOG = [Squat, LateralRaise, HighKnees, OverheadPress, SideBend, JumpingJacks];
export const byId = (id) => CATALOG.find((C) => new C().id === id);
export const makeWorkout = (ids) =>
  (ids ? ids.map((id) => byId(id)).filter(Boolean) : CATALOG).map((C) => new C());
