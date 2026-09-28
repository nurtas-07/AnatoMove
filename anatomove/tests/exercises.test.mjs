// Тесты логики упражнений на синтетических позах: node tests/exercises.test.mjs
// Генерируем «человека» из 33 точек и прогоняем движения — правильные и с ошибками.

import { Squat, LateralRaise, HighKnees } from '../js/exercises.js';
import { L } from '../js/geometry.js';

const W = 1280, H = 720, FPS = 30;
const frame = { w: W, h: H };
let failed = 0;

function check(name, cond, info = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${info ? '  ' + info : ''}`);
  if (!cond) failed++;
}

// Поза стоя лицом к камере. Правая сторона человека — слева в кадре.
function pose({ depth = 0, valgus = 0, lean = 0, shift = 0, armL = 8, armR = 8, elbowBend = 0, shrug = 0, liftL = 0, liftR = 0, sway = 0 } = {}) {
  const P = Array.from({ length: 33 }, () => ({ x: 640, y: 150, visibility: 0.99 }));
  const thigh = 130, torso = 180, shin = 120;
  const kneeY = 530;
  const hipY = kneeY - thigh * (1 - 0.8 * depth);
  const hipX = 640 + shift;
  const set = (i, x, y) => { P[i] = { x, y, visibility: 0.99 }; };

  set(L.L_ANKLE, 690, kneeY + shin); set(L.R_ANKLE, 590, kneeY + shin);
  set(L.L_HIP, hipX + 35, hipY); set(L.R_HIP, hipX - 35, hipY);
  set(L.L_KNEE, 685 - valgus, kneeY); set(L.R_KNEE, 595 + valgus, kneeY);

  // Подъём колена: бедро «укорачивается» в кадре, голень под коленом.
  const legLift = (hipI, kneeI, ankleI, lift) => {
    if (!lift) return;
    const h = P[hipI];
    const ky = h.y + thigh * (1 - lift);
    set(kneeI, P[kneeI].x, ky);
    set(ankleI, P[ankleI].x, ky + shin);
  };
  legLift(L.L_HIP, L.L_KNEE, L.L_ANKLE, liftL);
  legLift(L.R_HIP, L.R_KNEE, L.R_ANKLE, liftR);

  const tl = torso * Math.cos((lean * Math.PI) / 180);
  const shY = hipY - tl;
  const swayX = Math.tan((sway * Math.PI) / 180) * tl;
  set(L.L_SHOULDER, hipX + 60 + swayX, shY - shrug);
  set(L.R_SHOULDER, hipX - 60 + swayX, shY - shrug);
  set(L.NOSE, hipX + swayX, shY - 70);
  set(L.L_EAR, hipX + 20 + swayX, shY - 70); set(L.R_EAR, hipX - 20 + swayX, shY - 70);

  // Руки: угол отведения от корпуса (0 — вдоль тела, 90 — горизонтально).
  const arm = (sI, eI, wI, a, dir) => {
    const s = P[sI];
    const r = (a * Math.PI) / 180;
    const e = { x: s.x + dir * Math.sin(r) * 110, y: s.y + Math.cos(r) * 110 };
    const r2 = r + (elbowBend * Math.PI) / 180 * -1;
    const w = { x: e.x + dir * Math.sin(r2) * 100, y: e.y + Math.cos(r2) * 100 };
    set(eI, e.x, e.y); set(wI, w.x, w.y);
  };
  arm(L.L_SHOULDER, L.L_ELBOW, L.L_WRIST, armL, 1);
  arm(L.R_SHOULDER, L.R_ELBOW, L.R_WRIST, armR, -1);
  return P;
}

// Прогон сценария: список [длительность в секундах, функция параметров от доли 0..1].
function run(ex, script) {
  const events = [];
  let t = 0;
  const dt = 1 / FPS;
  for (const [sec, fn] of script) {
    const n = Math.round(sec * FPS);
    for (let i = 0; i < n; i++) {
      const res = ex.update({ P: pose(fn(i / n)), frame, t, dt });
      events.push(...res.events);
      t += dt * 1000;
    }
  }
  return events;
}

const stand = (s, extra = {}) => [s, () => ({ ...extra })];
const ramp = (s, key, a, b, extra = {}) => [s, (k) => ({ ...extra, [key]: a + (b - a) * k })];
const faultsOf = (ev) => ev.filter((e) => e.type === 'fault').map((e) => e.code);

// ─── Приседания
{
  const ex = new Squat();
  const rep = (extra = {}) => [ramp(0.8, 'depth', 0, 1, extra), stand(0.3, { depth: 1, ...extra }), ramp(0.8, 'depth', 1, 0, extra), stand(0.4)];
  const ev = run(ex, [stand(1), ...rep(), ...rep()]);
  check('приседания: 2 чистых повтора', ex.total === 2 && ex.clean === 2, `total=${ex.total} clean=${ex.clean} faults=${faultsOf(ev)}`);
}
{
  const ex = new Squat();
  const ev = run(ex, [stand(1), ramp(0.8, 'depth', 0, 0.45), ramp(0.8, 'depth', 0.45, 0), stand(0.4)]);
  check('приседания: неглубоко → shallow', ex.total === 1 && faultsOf(ev).includes('shallow'), `faults=${faultsOf(ev)}`);
}
{
  const ex = new Squat();
  const down = (k) => ({ depth: k, valgus: 40 * k });
  const ev = run(ex, [stand(1), [0.8, down], stand(0.4, { depth: 1, valgus: 40 }), [0.8, (k) => down(1 - k)], stand(0.4)]);
  check('приседания: колени внутрь → valgus', faultsOf(ev).includes('valgus') && ex.clean === 0, `faults=${faultsOf(ev)}`);
}
{
  const ex = new Squat();
  const down = (k) => ({ depth: k, lean: 60 * k });
  const ev = run(ex, [stand(1), [0.8, down], stand(0.4, { depth: 1, lean: 60 }), [0.8, (k) => down(1 - k)], stand(0.4)]);
  check('приседания: наклон корпуса → lean', faultsOf(ev).includes('lean'), `faults=${faultsOf(ev)}`);
}
{
  const ex = new Squat();
  const down = (k) => ({ depth: k, shift: -40 * k });
  const ev = run(ex, [stand(1), [0.8, down], stand(0.4, { depth: 1, shift: -40 }), [0.8, (k) => down(1 - k)], stand(0.4)]);
  const f = ev.find((e) => e.code === 'shift');
  check('приседания: таз влево в кадре → вес на правой ноге', f && f.side === 'right', f ? f.what : 'нет ошибки');
}
{
  const ex = new Squat();
  const res = ex.update({ P: null, frame, t: 0, dt: 1 / 30 });
  check('приседания: никого в кадре → подсказка nobody', res.setup === 'nobody');
  const P = pose(); P[L.L_ANKLE].y = 800; P[L.R_ANKLE].y = 800;
  check('приседания: стопы за кадром → feet', ex.update({ P, frame, t: 0, dt: 1 / 30 }).setup === 'feet');
}

// ─── Разведение рук
{
  const ex = new LateralRaise();
  // Обе руки синхронно
  const both = (to, extra = {}) => [
    [0.7, (k) => ({ ...extra, armL: 8 + (to - 8) * k, armR: 8 + (to - 8) * k })],
    [0.3, () => ({ ...extra, armL: to, armR: to })],
    [0.7, (k) => ({ ...extra, armL: to - (to - 8) * k, armR: to - (to - 8) * k })],
    stand(0.3),
  ];
  const ev = run(ex, [stand(1), ...both(90), ...both(88)]);
  check('руки: 2 чистых повтора', ex.total === 2 && ex.clean === 2, `total=${ex.total} clean=${ex.clean} faults=${faultsOf(ev)}`);

  const ex2 = new LateralRaise();
  const ev2 = run(ex2, [stand(1), ...both(130)]);
  check('руки: выше плеч → high', faultsOf(ev2).includes('high'), `faults=${faultsOf(ev2)}`);

  const ex3 = new LateralRaise();
  const ev3 = run(ex3, [stand(1), ...both(60)]);
  check('руки: низко → low', faultsOf(ev3).includes('low'), `faults=${faultsOf(ev3)}`);

  const ex4 = new LateralRaise();
  const ev4 = run(ex4, [stand(1),
    [0.7, (k) => ({ armL: 8 + 50 * k, armR: 8 + 82 * k })],
    [0.3, () => ({ armL: 58, armR: 90 })],
    [0.7, (k) => ({ armL: 58 - 50 * k, armR: 90 - 82 * k })],
    stand(0.3)]);
  const f4 = ev4.find((e) => e.code === 'asym');
  check('руки: левая отстаёт → asym left', f4 && f4.side === 'left', f4 ? f4.what : `faults=${faultsOf(ev4)}`);

  const ex5 = new LateralRaise();
  const ev5 = run(ex5, [stand(1), ...both(90, { elbowBend: 70 })]);
  check('руки: согнуты в локтях → elbows', faultsOf(ev5).includes('elbows'), `faults=${faultsOf(ev5)}`);

  const ex6 = new LateralRaise();
  const shrugged = both(90).map(([s, fn], i) => [s, (k) => ({ ...fn(k), shrug: [25 * k, 25, 25 * (1 - k), 0][i] })]);
  const ev6 = run(ex6, [stand(1), ...shrugged]);
  check('руки: плечи к ушам → shrug', faultsOf(ev6).includes('shrug'), `faults=${faultsOf(ev6)}`);
}

// ─── Подъём коленей
{
  const ex = new HighKnees();
  const lift = (side, to, extra = {}) => {
    const key = side === 'left' ? 'liftL' : 'liftR';
    return [ramp(0.35, key, 0, to, extra), stand(0.1, { [key]: to, ...extra }), ramp(0.35, key, to, 0, extra), stand(0.15)];
  };
  const ev = run(ex, [stand(1), ...lift('left', 0.9), ...lift('right', 0.9), ...lift('left', 0.9), ...lift('right', 0.9)]);
  check('колени: 4 чистых повтора', ex.total === 4 && ex.clean === 4, `total=${ex.total} clean=${ex.clean} faults=${faultsOf(ev)}`);

  const ex2 = new HighKnees();
  const ev2 = run(ex2, [stand(1), ...lift('right', 0.45)]);
  const f2 = ev2.find((e) => e.code === 'low');
  check('колени: правое низко → low right', f2 && f2.side === 'right', f2 ? f2.what : `faults=${faultsOf(ev2)}`);

  const ex3 = new HighKnees();
  const ev3 = run(ex3, [stand(1), ...lift('left', 0.9), ...lift('left', 0.9), ...lift('left', 0.9)]);
  const f3 = ev3.find((e) => e.code === 'alternate');
  check('колени: 3 раза левой → alternate', !!f3, f3 ? f3.fix : `faults=${faultsOf(ev3)}`);

  const ex4 = new HighKnees();
  const ev4 = run(ex4, [stand(1), ...lift('left', 0.9, { sway: 20 })]);
  check('колени: корпус вбок → sway', faultsOf(ev4).includes('sway'), `faults=${faultsOf(ev4)}`);
}

console.log(failed ? `\n${failed} проверок не прошли` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
