// Камера и модель MediaPipe Pose Landmarker. Всё работает в браузере, видео никуда не отправляется.

// Если основная версия библиотеки не загрузится с CDN, пробуем запасную.
const MP_VERSIONS = ['1.0.1', '0.10.35'];
const MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

// На телефоне берём лёгкую модель, на компьютере — точнее. Можно переопределить: ?model=lite
export function pickModel() {
  const forced = new URLSearchParams(location.search).get('model');
  if (forced && MODELS[forced]) return forced;
  return matchMedia('(pointer: coarse)').matches ? 'lite' : 'full';
}

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('no-camera-api'), { code: 'no-camera-api' });
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    throw Object.assign(new Error(e.name), { code: e.name === 'NotAllowedError' ? 'denied' : 'no-camera' });
  }
  video.srcObject = stream;
  await video.play();
  if (video.readyState < 2) await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
  return stream;
}

async function loadVision() {
  let lastError;
  for (const v of MP_VERSIONS) {
    const base = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}`;
    try {
      const mod = await import(`${base}/vision_bundle.mjs`);
      const fileset = await mod.FilesetResolver.forVisionTasks(`${base}/wasm`);
      return { PoseLandmarker: mod.PoseLandmarker, fileset };
    } catch (e) {
      console.warn(`MediaPipe ${v} не загрузился`, e);
      lastError = e;
    }
  }
  throw Object.assign(lastError || new Error('model'), { code: 'model' });
}

export async function createPoseDetector(kind = pickModel()) {
  const { PoseLandmarker, fileset } = await loadVision();
  const options = (model, delegate) => ({
    baseOptions: { modelAssetPath: MODELS[model], delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  // GPU → CPU, и если точная модель не загрузилась — лёгкая.
  const attempts = [[kind, 'GPU'], [kind, 'CPU']];
  if (kind !== 'lite') attempts.push(['lite', 'GPU'], ['lite', 'CPU']);
  let lastError;
  for (const [model, delegate] of attempts) {
    try {
      return await PoseLandmarker.createFromOptions(fileset, options(model, delegate));
    } catch (e) {
      console.warn(`Модель ${model} на ${delegate} не запустилась`, e);
      lastError = e;
    }
  }
  throw Object.assign(lastError || new Error('model'), { code: 'model' });
}
