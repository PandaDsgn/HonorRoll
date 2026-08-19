import { useEffect, useRef, useState, useCallback } from 'react';

// Client-side ML webcam proctoring: everything below runs entirely in the
// browser via MediaPipe Tasks Vision — the raw video frame never leaves the
// device, only derived flag events (a type + timestamp + a short detail
// string) are ever sent to the server. Two models, loaded lazily from
// Google's CDN (not bundled — keeps the GitHub Pages build small, and these
// are only ever needed on a webcam_required exam):
//   - FaceLandmarker: head-pose (via the facial transformation matrix) and
//     a gaze-away proxy (via eyeLookOut/In blendshape scores), plus two
//     "unnatural movement" signals derived from the same pose data — a
//     sudden/jerky head-motion spike (frame-to-frame angular velocity,
//     distinct from the slow sustained turn head_turned already covers)
//     and a second face entering frame (someone else in the room) — all
//     four MINOR. Also whether a face is visible at all — feeds the
//     face_absent MAJOR flag.
//   - ObjectDetector (EfficientDet-Lite0 / COCO classes): looks for a
//     "cell phone" in frame — feeds the phone_detected MAJOR flag.
//   - AudioClassifier (YAMNet, from the separate @mediapipe/tasks-audio
//     package — its own wasm runtime, not shared with the vision tasks
//     above): listens to the microphone for a "Speech" sound event —
//     feeds the speech_detected MINOR flag. Deliberately not attempting
//     speaker identification/transcription — just "is someone talking
//     right now", which is all a proctoring signal needs and keeps this
//     from ever touching anything privacy-sensitive like actual audio
//     content.
//
// Thresholds/durations below are a starting point, not a tuned result —
// there's no way to validate real head-turns/gaze/phone-holding/speech
// against this model from an automated environment. Expect to retune after
// trying it with a real camera and microphone.
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';
const OBJECT_MODEL_URL = 'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite';
const AUDIO_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@latest/wasm';
const AUDIO_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';

const HEAD_YAW_DEG_THRESHOLD = 20;
// Yaw alone (left-right) misses the single most common "looking away"
// posture — glancing DOWN at notes/a phone on the desk with the head
// barely turning sideways at all. Pitch closes that gap.
const HEAD_PITCH_DEG_THRESHOLD = 18;
const HEAD_TURNED_SUSTAIN_MS = 1200;
// Isolated eye-blendshape scores (independent of head pose) rarely reach
// very high values even when someone is visibly looking elsewhere, because
// people naturally move their head along with their eyes — 0.6 was too
// strict a bar in practice. Also see HEAD_PITCH/YAW above, which now catch
// most real "looking away" cases even when this one doesn't fire.
const GAZE_AWAY_SCORE_THRESHOLD = 0.35;
const GAZE_AWAY_SUSTAIN_MS = 1200;
const FACE_ABSENT_SUSTAIN_MS = 4000;
const MULTIPLE_FACES_SUSTAIN_MS = 1500;
const PHONE_SCORE_THRESHOLD = 0.5;
const MINOR_FLAG_COOLDOWN_MS = 10000;
const OBJECT_DETECT_INTERVAL_MS = 1000;
// Throttled console output of the live scores this hook is actually
// computing — the fastest way to tell whether a flag isn't firing because
// the behavior genuinely didn't cross the threshold, vs. something being
// broken. Look for "[proctoring]" in devtools while testing.
const DEBUG_LOG_INTERVAL_MS = 1000;

// A "jerky/sudden movement" spike is a large angular jump in a short window
// — distinct from head_turned, which fires on a slow sustained turn. Both
// the magnitude (so tiny fast jitter from landmark noise alone doesn't
// count) and the velocity have to clear their threshold, and it has to
// happen on two consecutive detection frames in a row (a single-frame
// landmark glitch almost never repeats twice back to back; real motion does).
const RAPID_MOVEMENT_MIN_DELTA_DEG = 12;
const RAPID_MOVEMENT_VELOCITY_DEG_PER_SEC = 150;
const RAPID_MOVEMENT_STREAK_FRAMES = 2;
const RAPID_MOVEMENT_MAX_FRAME_GAP_MS = 500; // ignore deltas across a big gap (e.g. face just reappeared)

// YAMNet's plain "Speech" class is trained on typical conversational tone —
// shouting/yelling often scores more strongly under its own AudioSet
// classes ("Shout", "Yell", "Screaming") than under "Speech" itself, so
// only allow-listing "Speech" was too narrow. Any of these crossing the
// threshold counts as a vocalization.
const SPEECH_CATEGORIES = ['Speech', 'Shout', 'Yell', 'Screaming', 'Conversation', 'Babbling'];
const SPEECH_SCORE_THRESHOLD = 0.3;
const SPEECH_SUSTAIN_MS = 1500;
const AUDIO_BUFFER_SIZE = 16384; // ~0.3-0.4s of audio per classification, at typical mic sample rates

// Cached at module scope: the wasm fileset + both models are expensive to
// load (several MB) and don't need re-fetching if the student's exam
// session touches proctoring more than once (e.g. a re-mount in dev).
let visionPromise = null;
function getVisionFileset() {
  if (!visionPromise) {
    visionPromise = import('@mediapipe/tasks-vision').then(({ FilesetResolver }) => (
      FilesetResolver.forVisionTasks(WASM_BASE)
    ));
  }
  return visionPromise;
}

let faceLandmarkerPromise = null;
function getFaceLandmarker() {
  if (!faceLandmarkerPromise) {
    faceLandmarkerPromise = (async () => {
      const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
      const vision = await getVisionFileset();
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_MODEL_URL },
        runningMode: 'VIDEO',
        // 2, not 1 — the whole point of multi-face detection here is
        // noticing when there's more than one, so capping at 1 would make
        // that structurally impossible to ever see.
        numFaces: 2,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    })();
  }
  return faceLandmarkerPromise;
}

let objectDetectorPromise = null;
function getObjectDetector() {
  if (!objectDetectorPromise) {
    objectDetectorPromise = (async () => {
      const { ObjectDetector } = await import('@mediapipe/tasks-vision');
      const vision = await getVisionFileset();
      return ObjectDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: OBJECT_MODEL_URL },
        runningMode: 'VIDEO',
        maxResults: 5,
        scoreThreshold: PHONE_SCORE_THRESHOLD,
      });
    })();
  }
  return objectDetectorPromise;
}

// @mediapipe/tasks-audio is a separate package from tasks-vision, with its
// own FilesetResolver/wasm runtime — not interchangeable with getVisionFileset.
let audioFilesetPromise = null;
function getAudioFileset() {
  if (!audioFilesetPromise) {
    audioFilesetPromise = import('@mediapipe/tasks-audio').then(({ FilesetResolver }) => (
      FilesetResolver.forAudioTasks(AUDIO_WASM_BASE)
    ));
  }
  return audioFilesetPromise;
}

let audioClassifierPromise = null;
function getAudioClassifier() {
  if (!audioClassifierPromise) {
    audioClassifierPromise = (async () => {
      const { AudioClassifier } = await import('@mediapipe/tasks-audio');
      const fileset = await getAudioFileset();
      return AudioClassifier.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: AUDIO_MODEL_URL },
        // Only ever care about these — cheaper than scoring all 521
        // AudioSet classes YAMNet knows about on every chunk.
        categoryAllowlist: SPEECH_CATEGORIES,
      });
    })();
  }
  return audioClassifierPromise;
}

// Standard XYZ Tait-Bryan decomposition of the rotation submatrix inside
// MediaPipe's 16-element row-major facial transformation matrix. This is an
// approximation of true head yaw/pitch, not a calibrated measurement — good
// enough to distinguish "facing the screen" from "turned well away".
function yawPitchDegreesFromMatrix(m) {
  const r11 = m[0], r12 = m[1];
  const r21 = m[4], r22 = m[5];
  const r31 = m[8];
  const toDeg = (rad) => (rad * 180) / Math.PI;

  let yaw, pitch;
  if (Math.abs(r31) < 0.999999) {
    pitch = Math.asin(-r31);
    yaw = Math.atan2(r21, r11);
  } else {
    pitch = r31 <= -1 ? Math.PI / 2 : -Math.PI / 2;
    yaw = Math.atan2(-r12, r22);
  }
  return { yaw: toDeg(yaw), pitch: toDeg(pitch) };
}

function categoryScore(categories, name) {
  const cat = (categories || []).find((c) => c.categoryName === name);
  return cat ? cat.score : 0;
}

export function useProctoring({ enabled, onMinorFlag, onMajorFlag }) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const onMinorFlagRef = useRef(onMinorFlag);
  const onMajorFlagRef = useRef(onMajorFlag);
  useEffect(() => { onMinorFlagRef.current = onMinorFlag; }, [onMinorFlag]);
  useEffect(() => { onMajorFlagRef.current = onMajorFlag; }, [onMajorFlag]);

  // Per-flag-type sustain/cooldown state, so a single noisy frame doesn't
  // fire a flag and a real sustained condition doesn't spam one every frame.
  const sustainRef = useRef({});
  const checkSustained = useCallback((key, isTrue, sustainMs, cooldownMs, now) => {
    const state = sustainRef.current[key] || { since: null, cooldownUntil: 0, fired: false };
    if (!isTrue) {
      state.since = null;
      state.fired = false;
    } else {
      if (state.since === null) state.since = now;
      if (!state.fired && now - state.since >= sustainMs && now >= state.cooldownUntil) {
        state.fired = true;
        state.cooldownUntil = now + cooldownMs;
        sustainRef.current[key] = state;
        return true;
      }
    }
    sustainRef.current[key] = state;
    return false;
  }, []);

  // Simpler cooldown-only gate for a one-shot event (like a movement
  // spike) rather than a level that's continuously true/false — there's no
  // "false" state to reset a latch with, so checkSustained's fired-until-
  // explicitly-cleared model doesn't fit; this just rate-limits repeats.
  const cooldownRef = useRef({});
  const checkCooldownEvent = useCallback((key, cooldownMs, now) => {
    const until = cooldownRef.current[key] || 0;
    if (now < until) return false;
    cooldownRef.current[key] = now + cooldownMs;
    return true;
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let stream = null;
    let rafId = null;
    let lastObjectDetectAt = 0;
    let lastPose = null; // { yaw, pitch, time } from the previous frame with a face, for velocity
    let rapidStreak = 0;
    let audioCtx = null;
    let micSource = null;
    let audioProcessor = null;
    let lastVisualDebugLogAt = 0;
    let lastAudioDebugLogAt = 0;
    sustainRef.current = {};
    cooldownRef.current = {};

    const start = async () => {
      try {
        // One combined request — a single permission prompt covers both
        // camera and microphone, rather than asking twice.
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch {
        if (!cancelled) setError('Camera/microphone permission was denied, or no camera or microphone is available.');
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }

      let faceLandmarker;
      let objectDetector;
      try {
        [faceLandmarker, objectDetector] = await Promise.all([getFaceLandmarker(), getObjectDetector()]);
      } catch {
        if (!cancelled) setError('Could not load the proctoring model. Check your connection and try again.');
        return;
      }
      if (cancelled) return;

      // Audio is additive, not load-bearing the way the video models are —
      // if it fails to load (flaky connection, etc.) proctoring still runs
      // on camera alone rather than blocking the whole exam over it.
      try {
        const audioClassifier = await getAudioClassifier();
        if (!cancelled) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          micSource = audioCtx.createMediaStreamSource(stream);
          audioProcessor = audioCtx.createScriptProcessor(AUDIO_BUFFER_SIZE, 1, 1);
          audioProcessor.onaudioprocess = (event) => {
            if (cancelled) return;
            const now = performance.now();
            const samples = new Float32Array(event.inputBuffer.getChannelData(0));
            let categories;
            try {
              const results = audioClassifier.classify(samples, audioCtx.sampleRate);
              categories = results[0]?.classifications?.[0]?.categories;
            } catch (err) {
              console.error('[proctoring] audio classify() failed:', err);
              return; // best-effort — one failed chunk shouldn't break the stream
            }
            const speechScore = Math.max(0, ...SPEECH_CATEGORIES.map((name) => categoryScore(categories, name)));
            if (checkSustained('speech_detected', speechScore > SPEECH_SCORE_THRESHOLD, SPEECH_SUSTAIN_MS, MINOR_FLAG_COOLDOWN_MS, now)) {
              onMinorFlagRef.current?.('speech_detected', `Speech/vocalization detected (score ${speechScore.toFixed(2)}).`);
            }
            if (now - lastAudioDebugLogAt > DEBUG_LOG_INTERVAL_MS) {
              lastAudioDebugLogAt = now;
              console.log(`[proctoring] speech score=${speechScore.toFixed(2)} (threshold ${SPEECH_SCORE_THRESHOLD})`, categories);
            }
          };
          // ScriptProcessorNode only fires onaudioprocess once connected all
          // the way to a destination — route through a muted gain node so
          // the mic is analyzed but never actually played back.
          const silentGain = audioCtx.createGain();
          silentGain.gain.value = 0;
          micSource.connect(audioProcessor);
          audioProcessor.connect(silentGain);
          silentGain.connect(audioCtx.destination);
        }
      } catch {
        // No mic flag this session, but video-based proctoring continues.
      }

      setReady(true);

      const tick = () => {
        if (cancelled) return;
        const el = videoRef.current;
        const now = performance.now();

        if (el && el.readyState >= 2) {
          const faceResult = faceLandmarker.detectForVideo(el, now);
          const faceCount = faceResult.faceLandmarks ? faceResult.faceLandmarks.length : 0;
          const hasFace = faceCount > 0;

          if (checkSustained('face_absent', !hasFace, FACE_ABSENT_SUSTAIN_MS, 0, now)) {
            onMajorFlagRef.current?.('face_absent', 'No face detected in frame for several seconds.');
          }

          if (checkSustained('multiple_faces', faceCount > 1, MULTIPLE_FACES_SUSTAIN_MS, MINOR_FLAG_COOLDOWN_MS, now)) {
            onMinorFlagRef.current?.('multiple_faces', `${faceCount} faces detected in frame at once.`);
          }

          if (hasFace) {
            let yaw = null;
            let pitch = null;
            let gazeAway = null;

            const matrix = faceResult.facialTransformationMatrixes?.[0]?.data;
            if (matrix) {
              ({ yaw, pitch } = yawPitchDegreesFromMatrix(matrix));

              // Yaw (left-right) OR pitch (up-down) — glancing down at
              // notes/a phone on the desk is mostly a pitch change with
              // little yaw, and would never have fired on yaw alone.
              const isTurnedAway = Math.abs(yaw) > HEAD_YAW_DEG_THRESHOLD || Math.abs(pitch) > HEAD_PITCH_DEG_THRESHOLD;
              if (checkSustained('head_turned', isTurnedAway, HEAD_TURNED_SUSTAIN_MS, MINOR_FLAG_COOLDOWN_MS, now)) {
                onMinorFlagRef.current?.('head_turned', `Head turned/tilted away (yaw ~${Math.round(yaw)}°, pitch ~${Math.round(pitch)}°).`);
              }

              if (lastPose && now - lastPose.time < RAPID_MOVEMENT_MAX_FRAME_GAP_MS) {
                const dtSec = (now - lastPose.time) / 1000;
                const delta = Math.hypot(yaw - lastPose.yaw, pitch - lastPose.pitch);
                const velocity = dtSec > 0 ? delta / dtSec : 0;
                const isSpikeFrame = delta > RAPID_MOVEMENT_MIN_DELTA_DEG && velocity > RAPID_MOVEMENT_VELOCITY_DEG_PER_SEC;
                rapidStreak = isSpikeFrame ? rapidStreak + 1 : 0;

                if (rapidStreak >= RAPID_MOVEMENT_STREAK_FRAMES
                    && checkCooldownEvent('rapid_movement', MINOR_FLAG_COOLDOWN_MS, now)) {
                  onMinorFlagRef.current?.('rapid_movement', `Sudden head movement (~${Math.round(velocity)}°/s).`);
                  rapidStreak = 0;
                }
              }
              lastPose = { yaw, pitch, time: now };
            }

            const categories = faceResult.faceBlendshapes?.[0]?.categories;
            if (categories) {
              gazeAway = Math.max(
                categoryScore(categories, 'eyeLookOutLeft'),
                categoryScore(categories, 'eyeLookOutRight')
              );
              if (checkSustained('gaze_away', gazeAway > GAZE_AWAY_SCORE_THRESHOLD, GAZE_AWAY_SUSTAIN_MS, MINOR_FLAG_COOLDOWN_MS, now)) {
                onMinorFlagRef.current?.('gaze_away', `Sustained gaze away from screen (score ${gazeAway.toFixed(2)}).`);
              }
            }

            if (now - lastVisualDebugLogAt > DEBUG_LOG_INTERVAL_MS) {
              lastVisualDebugLogAt = now;
              console.log(`[proctoring] yaw=${yaw?.toFixed(1)}° (th ${HEAD_YAW_DEG_THRESHOLD}) pitch=${pitch?.toFixed(1)}° (th ${HEAD_PITCH_DEG_THRESHOLD}) gazeAway=${gazeAway?.toFixed(2)} (th ${GAZE_AWAY_SCORE_THRESHOLD})`);
            }
          } else {
            lastPose = null; // face reappearing shouldn't compute velocity across the gap
            rapidStreak = 0;
          }

          if (now - lastObjectDetectAt > OBJECT_DETECT_INTERVAL_MS) {
            lastObjectDetectAt = now;
            const objectResult = objectDetector.detectForVideo(el, now);
            const phone = (objectResult.detections || []).find((d) => {
              const name = d.categories?.[0]?.categoryName || '';
              return name.toLowerCase().includes('phone');
            });
            if (phone) {
              onMajorFlagRef.current?.('phone_detected', `Phone detected (confidence ${phone.categories[0].score.toFixed(2)}).`);
            }
          }
        }

        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    };

    start();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (audioProcessor) audioProcessor.disconnect();
      if (micSource) micSource.disconnect();
      if (audioCtx) audioCtx.close().catch(() => {});
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setReady(false);
    };
  }, [enabled, checkSustained, checkCooldownEvent]);

  return { videoRef, ready, error };
}
