// Камера и модель MediaPipe Pose Landmarker. Всё работает в браузере, видео никуда не отправляется.

const MP_VERSION = '1.0.1'; // если CDN не отдаёт эту версию — поменяй на '0.10.35'
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
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

export async function createPoseDetector(kind = pickModel()) {
  let vision;
  try {
    vision = await import(`${MP_URL}/vision_bundle.mjs`);
  } catch (e) {
    throw Object.assign(e, { code: 'model' });
  }
  const { FilesetResolver, PoseLandmarker } = vision;
  const fileset = await FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODELS[kind], delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (e) {
    console.warn('GPU недоступен, работаю на CPU', e);
    try {
      return await PoseLandmarker.createFromOptions(fileset, options('CPU'));
    } catch (e2) {
      throw Object.assign(e2, { code: 'model' });
    }
  }
}
