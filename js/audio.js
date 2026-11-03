/**
 * Alert audio that tries NOT to steal focus from media / nav apps.
 * Uses Audio Session "transient"/"ambient" when available (Chrome),
 * short Web Audio chirps, and SpeechSynthesis for voice prompts.
 */

let sharedCtx = null;
let chirpTimer = null;
let alertActive = false;

function setAudioSessionTransient() {
  try {
    if (navigator.audioSession) {
      // Prefer transient (brief) or ambient (mixes with other audio)
      navigator.audioSession.type = "transient";
    }
  } catch {
    /* ignore */
  }
}

function setAudioSessionAmbient() {
  try {
    if (navigator.audioSession) {
      navigator.audioSession.type = "ambient";
    }
  } catch {
    /* ignore */
  }
}

function getCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    // Avoid long-lived exclusive media session where possible
    try {
      sharedCtx = new Ctx({ latencyHint: "interactive" });
    } catch {
      sharedCtx = new Ctx();
    }
  }
  if (sharedCtx.state === "suspended") {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

/** Soft notification chirp — should duck, not kill, other players. */
export function playAlertChirp(volume01 = 0.7) {
  if (volume01 <= 0) return;
  setAudioSessionTransient();
  try {
    const ctx = getCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.15);
    const peak = Math.max(0.001, volume01 * 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  } catch (err) {
    console.warn("Chirp failed", err);
  }
}

/**
 * Start repeating soft chirps. Interval is longer on purpose so Android
 * head units don't repeatedly grab AUDIOFOCUS and kill media apps (AOM, etc.).
 */
export function startAlertLoop(volume01 = 0.7) {
  if (alertActive) return;
  if (volume01 <= 0) return;
  alertActive = true;
  playAlertChirp(volume01);
  // 2.2s — less focus thrashing than sub-second loops
  chirpTimer = setInterval(() => playAlertChirp(volume01), 2200);
}

export function stopAlertLoop() {
  if (chirpTimer) {
    clearInterval(chirpTimer);
    chirpTimer = null;
  }
  alertActive = false;
  setAudioSessionAmbient();
}

export function isAlertLoopActive() {
  return alertActive;
}

/** Spoken prompt via system TTS — usually mixes better than Web Audio on cars. */
export function speak(text, volume01 = 1) {
  if (!window.speechSynthesis || !text) return;
  setAudioSessionTransient();
  try {
    // Don't cancel mid-utterance from other apps aggressively if possible;
    // only clear our own queue.
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = Math.max(0, Math.min(1, volume01));
    u.lang = "en-US";
    // Prefer a clear English voice when available
    const voices = speechSynthesis.getVoices();
    const en = voices.find((v) => /en(-|_|$)/i.test(v.lang) && /google|microsoft|samsung|android/i.test(v.name))
      || voices.find((v) => /en(-|_|$)/i.test(v.lang));
    if (en) u.voice = en;
    speechSynthesis.speak(u);
  } catch (err) {
    console.warn("TTS failed", err);
  }
}

/** Warm up voices list (async on some Android WebViews). */
export function warmUpSpeech() {
  if (!window.speechSynthesis) return;
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener("voiceschanged", () => {
    speechSynthesis.getVoices();
  });
}
