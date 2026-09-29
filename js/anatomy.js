// Анатомический слой: мышцы поверх тела на видео, подписи как в атласе, карта мышц в итогах.

import { L, lerp, mid, dist, clamp } from './geometry.js';

export const MUSCLES = {
  quads:     { ru: 'Четырёхглавая мышца бедра', la: 'm. quadriceps femoris' },
  glutes:    { ru: 'Большая ягодичная мышца', la: 'm. gluteus maximus' },
  adductors: { ru: 'Приводящие мышцы бедра', la: 'mm. adductores' },
  erectors:  { ru: 'Мышца, выпрямляющая позвоночник', la: 'm. erector spinae' },
  deltoids:  { ru: 'Дельтовидная мышца', la: 'm. deltoideus' },
  traps:     { ru: 'Трапециевидная мышца', la: 'm. trapezius' },
  iliopsoas: { ru: 'Подвздошно-поясничная мышца', la: 'm. iliopsoas' },
  abs:       { ru: 'Прямая мышца живота', la: 'm. rectus abdominis' },
  triceps:   { ru: 'Трёхглавая мышца плеча', la: 'm. triceps brachii' },
  obliques:  { ru: 'Наружная косая мышца живота', la: 'm. obliquus externus abdominis' },
  ql:        { ru: 'Квадратная мышца поясницы', la: 'm. quadratus lumborum' },
  gmed:      { ru: 'Средняя ягодичная мышца', la: 'm. gluteus medius' },
  calves:    { ru: 'Икроножная мышца', la: 'm. gastrocnemius' },
};

const RGB = { muscle: '255, 79, 109', fibre: '255, 196, 206', fault: '255, 212, 59', bone: '241, 235, 224' };

// Значение активации для стороны: число — одно на обе стороны, объект — {left, right}.
const actFor = (v, side) => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return side === 'center' ? Math.max(v.left || 0, v.right || 0) : v[side] || 0;
};

const add = (p, v, k = 1) => ({ x: p.x + v.x * k, y: p.y + v.y * k });

// Геометрия мышцы в экранных координатах: список «веретён» {a, b, w, side}.
function shapes(id, S) {
  const ls = S[L.L_SHOULDER], rs = S[L.R_SHOULDER], lh = S[L.L_HIP], rh = S[L.R_HIP];
  if (!ls || !rs || !lh || !rh) return [];
  const sw = dist(ls, rs);
  const ms = mid(ls, rs), mh = mid(lh, rh);
  const up = { x: (ms.x - mh.x) / (dist(ms, mh) || 1), y: (ms.y - mh.y) / (dist(ms, mh) || 1) };
  const sides = [
    ['left', ls, lh, S[L.L_KNEE], S[L.L_ELBOW], S[L.L_ANKLE]],
    ['right', rs, rh, S[L.R_KNEE], S[L.R_ELBOW], S[L.R_ANKLE]],
  ];
  const across = { x: (rs.x - ls.x) / (sw || 1), y: (rs.y - ls.y) / (sw || 1) }; // от левого плеча к правому
  const outward = (side) => (side === 'left' ? -1 : 1);
  const out = [];

  switch (id) {
    case 'quads':
      for (const [side, , h, k] of sides) if (k) out.push({ a: lerp(h, k, 0.1), b: lerp(h, k, 0.9), w: sw * 0.34, side });
      break;
    case 'adductors':
      for (const [side, , h, k] of sides) if (k) {
        const b = lerp(h, k, 0.62);
        out.push({ a: lerp(h, mh, 0.6), b: { x: b.x + (mh.x - b.x) * 0.3, y: b.y }, w: sw * 0.14, side });
      }
      break;
    case 'glutes':
      for (const [side, , h, k] of sides) if (k) {
        const outDir = { x: (h.x - mh.x) / (dist(h, mh) || 1), y: 0 };
        out.push({ a: add(add(h, outDir, sw * 0.12), up, sw * 0.18), b: add(lerp(h, k, 0.28), outDir, sw * 0.1), w: sw * 0.3, side });
      }
      break;
    case 'erectors': {
      const across = { x: (rs.x - ls.x) / (sw || 1), y: (rs.y - ls.y) / (sw || 1) };
      for (const [side, k] of [['left', -1], ['right', 1]]) {
        out.push({ a: add(lerp(mh, ms, 0.05), across, k * sw * 0.1), b: add(lerp(mh, ms, 0.8), across, k * sw * 0.1), w: sw * 0.16, side });
      }
      break;
    }
    case 'deltoids':
      for (const [side, s, , , e] of sides) if (e) out.push({ a: lerp(e, s, 1.12), b: lerp(s, e, 0.45), w: sw * 0.28, side });
      break;
    case 'traps': {
      const nose = S[L.NOSE];
      const neck = nose ? lerp(ms, nose, 0.3) : add(ms, up, sw * 0.25);
      for (const [side, s] of sides) out.push({ a: lerp(neck, s, 0.08), b: lerp(s, ms, 0.1), w: sw * 0.16, side });
      break;
    }
    case 'iliopsoas':
      for (const [side, , h, k] of sides) if (k) {
        const b = lerp(h, k, 0.25);
        out.push({ a: lerp(lerp(mh, ms, 0.22), h, 0.45), b: { x: b.x + (mh.x - b.x) * 0.25, y: b.y }, w: sw * 0.11, side });
      }
      break;
    case 'abs':
      out.push({ a: lerp(mh, ms, 0.08), b: lerp(mh, ms, 0.78), w: sw * 0.34, side: 'center' });
      break;
    case 'triceps':
      for (const [side, s, , , e] of sides) if (e) out.push({ a: lerp(s, e, 0.3), b: lerp(s, e, 0.95), w: sw * 0.2, side });
      break;
    case 'obliques': {
      // Волокна идут от нижних рёбер вниз и к центру.
      const center = lerp(mh, ms, 0.45);
      for (const [side, s, h] of sides) {
        out.push({ a: lerp(lerp(s, h, 0.42), center, 0.12), b: add(lerp(h, mh, 0.35), up, sw * 0.08), w: sw * 0.26, side });
      }
      break;
    }
    case 'ql':
      for (const [side, , h] of sides) {
        out.push({
          a: add(lerp(h, mh, 0.5), up, sw * 0.1),
          b: add(lerp(mh, ms, 0.42), across, outward(side) * sw * 0.18),
          w: sw * 0.13, side,
        });
      }
      break;
    case 'gmed':
      for (const [side, , h] of sides) {
        const outDir = { x: (h.x - mh.x) / (dist(h, mh) || 1), y: 0 };
        out.push({ a: add(add(h, outDir, sw * 0.18), up, sw * 0.32), b: add(h, outDir, sw * 0.2), w: sw * 0.2, side });
      }
      break;
    case 'calves':
      for (const [side, , , k, , an] of sides) if (k && an) out.push({ a: lerp(k, an, 0.08), b: lerp(k, an, 0.62), w: sw * 0.24, side });
      break;
  }
  return out;
}

// Мышечное брюшко веретеном + волокна внутри — как на таблицах анатомического атласа.
function spindle(ctx, { a, b, w }, rgb, alpha) {
  const len = dist(a, b) || 1;
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const m = mid(a, b);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo(m.x + n.x * w, m.y + n.y * w, b.x, b.y);
  ctx.quadraticCurveTo(m.x - n.x * w, m.y - n.y * w, a.x, a.y);
  ctx.closePath();
  ctx.shadowColor = `rgba(${rgb}, ${0.9 * alpha})`;
  ctx.shadowBlur = 28 * alpha;
  ctx.fillStyle = `rgba(${rgb}, ${0.12 + 0.5 * alpha})`;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(${rgb === RGB.muscle ? RGB.fibre : rgb}, ${0.2 + 0.55 * alpha})`;
  for (const k of [-0.6, -0.25, 0.1, 0.45]) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(m.x + n.x * w * k, m.y + n.y * w * k, b.x, b.y);
    ctx.stroke();
  }
}

export function drawMuscles(ctx, S, activation, faultMuscles, t) {
  const ids = new Set([...Object.keys(activation), ...faultMuscles]);
  const pulse = 0.75 + 0.25 * Math.sin(t / 140);
  ctx.save();
  for (const id of ids) {
    const isFault = faultMuscles.has(id);
    for (const sh of shapes(id, S)) {
      let a = clamp(actFor(activation[id], sh.side));
      if (isFault) a = Math.max(a, 0.85) * pulse;
      if (a < 0.05) continue;
      spindle(ctx, sh, isFault ? RGB.fault : RGB.muscle, a);
    }
  }
  ctx.restore();
}

const BONES = [
  [L.L_SHOULDER, L.R_SHOULDER], [L.L_HIP, L.R_HIP],
  [L.L_SHOULDER, L.L_HIP], [L.R_SHOULDER, L.R_HIP],
  [L.L_SHOULDER, L.L_ELBOW], [L.L_ELBOW, L.L_WRIST],
  [L.R_SHOULDER, L.R_ELBOW], [L.R_ELBOW, L.R_WRIST],
  [L.L_HIP, L.L_KNEE], [L.L_KNEE, L.L_ANKLE],
  [L.R_HIP, L.R_KNEE], [L.R_KNEE, L.R_ANKLE],
];
const JOINTS = [L.L_SHOULDER, L.R_SHOULDER, L.L_ELBOW, L.R_ELBOW, L.L_WRIST, L.R_WRIST, L.L_HIP, L.R_HIP, L.L_KNEE, L.R_KNEE, L.L_ANKLE, L.R_ANKLE];

// Скелет — «кости» цвета слоновой кости.
export function drawBones(ctx, S, alpha = 0.5) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(${RGB.bone}, ${alpha})`;
  ctx.lineWidth = 2;
  for (const [i, j] of BONES) {
    if (!S[i] || !S[j]) continue;
    ctx.beginPath(); ctx.moveTo(S[i].x, S[i].y); ctx.lineTo(S[j].x, S[j].y); ctx.stroke();
  }
  ctx.restore();
}

export function drawJoints(ctx, S, alpha = 0.85) {
  ctx.save();
  ctx.fillStyle = `rgba(${RGB.bone}, ${alpha})`;
  for (const i of JOINTS) {
    if (!S[i]) continue;
    ctx.beginPath(); ctx.arc(S[i].x, S[i].y, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Кольца на суставах, где ошибка.
export function drawFaultJoints(ctx, S, joints, t) {
  if (!joints.length) return;
  const r = 13 + 4 * Math.sin(t / 120);
  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = `rgba(${RGB.fault}, 0.95)`;
  ctx.fillStyle = `rgba(${RGB.fault}, 0.25)`;
  for (const i of new Set(joints)) {
    if (!S[i]) continue;
    ctx.beginPath(); ctx.arc(S[i].x, S[i].y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

// Выносные подписи, как в атласе: точка на мышце, тонкая линия, латынь курсивом.
export function drawLabels(ctx, S, activation, order, cw, ch) {
  const small = cw < 640;
  const picks = [];
  for (const id of order) {
    const list = shapes(id, S).map((sh) => ({ sh, a: actFor(activation[id], sh.side) }));
    if (!list.length) continue;
    list.sort((x, y) => y.a - x.a);
    if (list[0].a < 0.35) continue;
    picks.push({ id, list });
    if (picks.length === 2) break;
  }
  if (!picks.length) return;

  const cx = S[L.L_SHOULDER] && S[L.R_SHOULDER] ? mid(S[L.L_SHOULDER], S[L.R_SHOULDER]).x : cw / 2;
  const used = new Set();
  const placed = { true: [], false: [] }; // занятые высоты подписей слева и справа
  const pad = small ? 14 : 28;
  const top = small ? 120 : 110, bottom = ch - (small ? 190 : 170);

  ctx.save();
  for (const { id, list } of picks) {
    // Первая подпись — со стороны её мышцы, вторая — с противоположной, если есть парная мышца.
    let choice = list[0];
    let onLeft = mid(choice.sh.a, choice.sh.b).x < cx;
    if (used.has(onLeft)) {
      const other = list.find((c) => (mid(c.sh.a, c.sh.b).x < cx) !== onLeft && c.a > 0.2);
      if (other) { choice = other; onLeft = !onLeft; }
    }
    used.add(onLeft);

    const alpha = clamp((choice.a - 0.25) / 0.3);
    const anchor = mid(choice.sh.a, choice.sh.b);
    const m = MUSCLES[id];
    const la = small ? 17 : 23, ru = small ? 11 : 13;
    const gap = la + ru + 18;
    let y = clamp(anchor.y, top, bottom);
    while (placed[onLeft].some((py) => Math.abs(py - y) < gap)) y += gap;
    placed[onLeft].push(y);

    ctx.font = `italic 500 ${la}px "Cormorant Garamond", Georgia, serif`;
    const w1 = ctx.measureText(m.la).width;
    ctx.font = `500 ${ru}px Onest, system-ui, sans-serif`;
    const w2 = ctx.measureText(m.ru).width;
    const tw = Math.max(w1, w2);
    const x = onLeft ? pad : cw - pad;
    const lineEnd = onLeft ? x + tw + 10 : x - tw - 10;

    ctx.strokeStyle = `rgba(${RGB.bone}, ${0.75 * alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(lineEnd, y - la * 0.35); ctx.stroke();
    ctx.fillStyle = `rgba(${RGB.bone}, ${alpha})`;
    ctx.beginPath(); ctx.arc(anchor.x, anchor.y, 3, 0, Math.PI * 2); ctx.fill();

    ctx.textAlign = onLeft ? 'left' : 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 8;
    ctx.font = `italic 500 ${la}px "Cormorant Garamond", Georgia, serif`;
    ctx.fillText(m.la, x, y);
    ctx.font = `500 ${ru}px Onest, system-ui, sans-serif`;
    ctx.fillStyle = `rgba(${RGB.bone}, ${0.7 * alpha})`;
    ctx.fillText(m.ru, x, y + ru + 6);
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

// Метки на кистях в меню: заполняются, пока рука поднята.
export function drawHandHold(ctx, S, holds) {
  ctx.save();
  for (const [side, idx] of [['left', L.L_WRIST], ['right', L.R_WRIST]]) {
    const p = S[idx];
    if (!p) continue;
    const h = holds[side] || 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(${RGB.bone}, 0.35)`;
    ctx.beginPath(); ctx.arc(p.x, p.y, 20, 0, Math.PI * 2); ctx.stroke();
    if (h > 0) {
      ctx.strokeStyle = `rgba(${RGB.muscle}, 0.95)`;
      ctx.beginPath(); ctx.arc(p.x, p.y, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * h); ctx.stroke();
    }
  }
  ctx.restore();
}

// ─── Карта мышц для экрана итогов (SVG): вид спереди и сзади.
const mirror = (svg) => `<g transform="translate(220 0) scale(-1 1)">${svg}</g>`;
const pair = (svg) => svg + mirror(svg);

const SILHOUETTE = `
  <circle cx="110" cy="42" r="24"/>
  <path d="M100 62h20v24h-20z"/>
  <path d="M68 92 Q110 80 152 92 L146 200 Q140 224 148 248 L72 248 Q80 224 74 200 Z"/>
  ${pair(`<path d="M66 100 L52 190" class="limb" stroke-width="22"/>
          <path d="M52 190 L44 272" class="limb" stroke-width="17"/>
          <circle cx="42" cy="287" r="9"/>
          <path d="M90 252 L88 352" class="limb" stroke-width="34"/>
          <path d="M88 352 L88 436" class="limb" stroke-width="24"/>`)}`;

const FRONT = {
  traps: pair('<path d="M100 80 L74 95 L98 98 Z"/>'),
  deltoids: pair('<ellipse cx="68" cy="108" rx="14" ry="21" transform="rotate(14 68 108)"/>'),
  abs: '<rect x="94" y="118" width="32" height="98" rx="12"/><path class="line" d="M96 142h28M96 166h28M96 190h28M110 120v94"/>',
  iliopsoas: pair('<ellipse cx="97" cy="238" rx="6" ry="17" transform="rotate(-22 97 238)"/>'),
  quads: pair('<ellipse cx="86" cy="302" rx="14" ry="44"/>'),
  adductors: pair('<ellipse cx="101" cy="284" rx="5.5" ry="28" transform="rotate(-8 101 284)"/>'),
  obliques: pair('<ellipse cx="83" cy="172" rx="8.5" ry="28" transform="rotate(12 83 172)"/>'),
};
const BACK = {
  traps: '<path d="M110 70 L152 96 L110 172 L68 96 Z"/>',
  deltoids: pair('<ellipse cx="68" cy="108" rx="14" ry="21" transform="rotate(14 68 108)"/>'),
  erectors: pair('<rect x="97" y="140" width="9" height="98" rx="4.5"/>'),
  glutes: pair('<ellipse cx="93" cy="254" rx="17" ry="19"/>'),
  gmed: pair('<ellipse cx="85" cy="230" rx="10" ry="7" transform="rotate(-18 85 230)"/>'),
  ql: pair('<ellipse cx="89" cy="212" rx="5" ry="14"/>'),
  triceps: pair('<ellipse cx="58.5" cy="150" rx="7.5" ry="26" transform="rotate(9 58.5 150)"/>'),
  calves: pair('<ellipse cx="88" cy="382" rx="11" ry="25"/>'),
};

export function bodyMapSVG(load) {
  const max = Math.max(0.0001, ...Object.values(load));
  const layer = (map) => Object.entries(map).map(([id, svg]) => {
    const v = clamp((load[id] || 0) / max);
    return `<g class="m" style="--v:${v.toFixed(2)}"><title>${MUSCLES[id].ru}</title>${svg}</g>`;
  }).join('');
  return `<svg viewBox="0 0 480 490" role="img" aria-label="Нагрузка на мышцы за тренировку">
    <g transform="translate(10 0)"><g class="body">${SILHOUETTE}</g>${layer(FRONT)}
      <text x="110" y="478" text-anchor="middle">Спереди</text></g>
    <g transform="translate(250 0)"><g class="body">${SILHOUETTE}</g>${layer(BACK)}
      <text x="110" y="478" text-anchor="middle">Сзади</text></g>
  </svg>`;
}
