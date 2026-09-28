// Звук: короткие сигналы (Web Audio) и голосовые подсказки (Web Speech API).
// Голос важен: во время упражнения человек стоит далеко и не всегда смотрит на экран.

let ctx = null;
let muted = false;
let voice = null;
const lastSaid = new Map();

function pickVoice() {
  const all = window.speechSynthesis?.getVoices?.() || [];
  const ru = all.filter((v) => /^ru/i.test(v.lang));
  voice = ru.find((v) => /google|milena|yuri|irina|pavel|svetlana|dmitry/i.test(v.name)) || ru[0] || null;
}

// Вызывать по клику пользователя: браузеры не дают играть звук без жеста.
export function initAudio() {
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; }
  if ('speechSynthesis' in window) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }
}

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  if (m) window.speechSynthesis?.cancel();
}

const NOTES = { good: [880], bad: [311], done: [660, 880, 1320], select: [523, 784] };

export function tone(kind) {
  if (muted || !ctx) return;
  const notes = NOTES[kind] || [660];
  const start = ctx.currentTime;
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t0 = start + i * 0.1;
    o.type = kind === 'bad' ? 'triangle' : 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + 0.25);
  });
}

// urgent — перебить то, что говорится сейчас (подсказки по технике важнее счёта).
export function say(text, { urgent = false, cooldown = 4000 } = {}) {
  if (muted || !text || !('speechSynthesis' in window)) return;
  const now = performance.now();
  if (now - (lastSaid.get(text) ?? -Infinity) < cooldown) return;
  const synth = window.speechSynthesis;
  if (synth.speaking && !urgent) return;
  if (urgent) synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ru-RU';
  if (voice) u.voice = voice;
  u.rate = 1.08;
  synth.speak(u);
  lastSaid.set(text, now);
}
