// Геометрия и утилиты. Без DOM — поэтому логику можно тестировать в Node.

// Индексы точек MediaPipe Pose (33 точки). "Левый" = левый у человека.
export const L = {
  NOSE: 0,
  L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_INDEX: 19, R_INDEX: 20,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a, b) => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
});
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Угол в точке b (в градусах) между лучами b→a и b→c, в плоскости кадра.
export function angle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!d) return 180;
  return (Math.acos(clamp((v1x * v2x + v1y * v2y) / d, -1, 1)) * 180) / Math.PI;
}

// Отклонение вектора from→to от вертикали, в градусах.
export function tiltFromVertical(from, to) {
  return (Math.atan2(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 180) / Math.PI;
}

// Точка видна и находится в кадре.
export function seen(P, i, frame, th = 0.5) {
  const p = P?.[i];
  if (!p || (p.visibility ?? 1) < th) return false;
  if (!frame) return true;
  const m = 0.02; // небольшой допуск у краёв кадра
  return p.x >= -frame.w * m && p.x <= frame.w * (1 + m) && p.y >= -frame.h * m && p.y <= frame.h * (1 + m);
}
export const allSeen = (P, idx, frame, th) => idx.every((i) => seen(P, i, frame, th));

// Экспоненциальное сглаживание (убирает дрожание точек).
export class Ema {
  constructor(alpha = 0.5) { this.alpha = alpha; this.v = null; }
  next(x) { this.v = this.v === null ? x : this.v + (x - this.v) * this.alpha; return this.v; }
  reset() { this.v = null; }
}

// Эталон «в покое» (например, длина бедра стоя): максимум, который медленно
// затухает. Если человек подошёл ближе — эталон сразу растёт, отошёл — плавно уменьшается.
export class DecayingMax {
  constructor(decayPerSec = 0.03) { this.decay = decayPerSec; this.v = 0; }
  update(x, dt) {
    this.v = Math.max(x, this.v * (1 - this.decay * dt));
    return this.v;
  }
}

// Сколько кадров подряд держится условие — чтобы одиночный «шум» не считался ошибкой.
export class Streak {
  constructor() { this.n = 0; }
  push(cond) { this.n = cond ? this.n + 1 : 0; return this.n; }
}
