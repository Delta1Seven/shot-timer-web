const APP_VERSION = "1.1.0";

let audioContext;
let analyser;
let mic;
let dataArray;
let detectionRafId;
let visualizationRafId;
let delayTimeoutId;
let parTimeoutId;
let shotFlashTimeoutId;

let samplePeaks = [];
let averagePeak = null;
let peakHistory = [];
let latestPeak = 0;

let startTime = 0;
let shots = [];
let lastShotTime = -Infinity;
let shotCount = 0;
let envelope = 0;
let lastEnvelope = 0;
let noiseFloor = 0;

let sampleShotCount = 0;
let sampleStartTime = 0;
let sampleBaseline = 0;

const SHOT_COOLDOWN_MS = 160;
const SAMPLE_SHOTS_NEEDED = 4;
const SAMPLE_BASELINE_MS = 500;
const PEAK_HISTORY_LENGTH = 120;
const DEFAULT_DELAY_MIN = 1;
const DEFAULT_DELAY_MAX = 4;
const DEFAULT_FIXED_DELAY = 2;
const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 4;
const ENVELOPE_ATTACK = 0.55;
const ENVELOPE_DECAY = 0.72;
const NOISE_FLOOR_ALPHA = 0.08;
const NOISE_MULTIPLIER = 2.8;
const IMPULSE_RISE_THRESHOLD = 6;
const SHOT_FLASH_MS = 160;

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const shotCountEl = document.getElementById("shotCount");
const sensitivityEl = document.getElementById("sensitivity");
const waveformCanvas = document.getElementById("waveform");
const waveformCtx = waveformCanvas.getContext("2d");
const randomDelayEl = document.getElementById("randomDelay");
const minDelayEl = document.getElementById("minDelay");
const maxDelayEl = document.getElementById("maxDelay");
const fixedDelayEl = document.getElementById("fixedDelay");
const parEnabledEl = document.getElementById("parEnabled");
const parTimeEl = document.getElementById("parTime");
const listeningIndicator = document.getElementById("indicatorListening");
const beepIndicator = document.getElementById("indicatorBeep");
const shotIndicator = document.getElementById("indicatorShot");

resizeWaveformCanvas();
window.addEventListener("resize", resizeWaveformCanvas);

minDelayEl.value = DEFAULT_DELAY_MIN;
maxDelayEl.value = DEFAULT_DELAY_MAX;
fixedDelayEl.value = DEFAULT_FIXED_DELAY;

randomDelayEl.addEventListener("change", updateDelayControls);
minDelayEl.addEventListener("input", clampDelayInputs);
maxDelayEl.addEventListener("input", clampDelayInputs);

updateDelayControls();

document.getElementById("sampleBtn").onclick = recordSamples;
document.getElementById("startBtn").onclick = startTimer;
document.getElementById("resetBtn").onclick = resetTimer;

async function initAudio() {
  if (audioContext) return;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextClass({ latencyHint: "interactive" });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  mic = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;

  dataArray = new Uint8Array(analyser.fftSize);
  mic.connect(analyser);
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  analyser.connect(silentGain);
  silentGain.connect(audioContext.destination);
  startVisualization();
}

async function recordSamples() {
  await initAudio();
  resetDetectionState();
  samplePeaks = [];
  averagePeak = null;
  sampleShotCount = 0;
  sampleStartTime = performance.now();
  sampleBaseline = 0;

  statusEl.textContent = `Recording samples... (0/${SAMPLE_SHOTS_NEEDED})`;
  setIndicatorState({ listening: true, beep: false, shot: false });
  collectSamples();
}

function collectSamples() {
  analyser.getByteTimeDomainData(dataArray);

  const peak = calculatePeak();
  latestPeak = peak;
  updateEnvelope(peak);

  samplePeaks.push(peak);
  const now = performance.now();
  if (now - sampleStartTime < SAMPLE_BASELINE_MS) {
    sampleBaseline = samplePeaks.reduce((a, b) => a + b, 0) / samplePeaks.length;
  } else {
    const baselineThreshold = Math.max(sampleBaseline * 3, 12);
    if (peak > baselineThreshold && now - lastShotTime >= SHOT_COOLDOWN_MS) {
      sampleShotCount += 1;
      lastShotTime = now;
      statusEl.textContent = `Recording samples... (${sampleShotCount}/${SAMPLE_SHOTS_NEEDED})`;
    }
  }

  if (sampleShotCount >= SAMPLE_SHOTS_NEEDED) {
    cancelAnimationFrame(detectionRafId);
    averagePeak = samplePeaks.reduce((a, b) => a + b, 0) / samplePeaks.length;
    statusEl.textContent = "Sample captured ✔";
    setIndicatorState({ listening: false, beep: false, shot: false });
    return;
  }

  detectionRafId = requestAnimationFrame(collectSamples);
}

function resizeWaveformCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = waveformCanvas.clientWidth || 0;
  const height = waveformCanvas.clientHeight || 0;

  waveformCanvas.width = width * dpr;
  waveformCanvas.height = height * dpr;
  waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  waveformCtx.fillStyle = "#000";
  waveformCtx.fillRect(0, 0, width, height);
}

function startVisualization() {
  if (visualizationRafId) return;

  const draw = () => {
    const width = waveformCanvas.clientWidth;
    const height = waveformCanvas.clientHeight;

    if (!analyser || width === 0 || height === 0) {
      visualizationRafId = requestAnimationFrame(draw);
      return;
    }

    analyser.getByteTimeDomainData(dataArray);
    const peak = calculatePeak();
    latestPeak = peak;
    peakHistory.push(peak);
    if (peakHistory.length > PEAK_HISTORY_LENGTH) {
      peakHistory.shift();
    }

    waveformCtx.fillStyle = "#000";
    waveformCtx.fillRect(0, 0, width, height);

    const mid = height / 2;
    const referencePeak = getReferencePeak();
    if (referencePeak > 0) {
      const referenceOffset = Math.min(referencePeak, 128) / 128 * mid * 0.9;
      const referenceY = mid - referenceOffset;
      waveformCtx.strokeStyle = "#f8fafc";
      waveformCtx.lineWidth = 1;
      waveformCtx.beginPath();
      waveformCtx.moveTo(0, referenceY);
      waveformCtx.lineTo(width, referenceY);
      waveformCtx.stroke();
    }

    if (peakHistory.length > 1) {
      waveformCtx.strokeStyle = "#f59e0b";
      waveformCtx.lineWidth = 1.2;
      waveformCtx.beginPath();
      const peakSliceWidth = width / (peakHistory.length - 1);
      for (let i = 0; i < peakHistory.length; i++) {
        const peakOffset = Math.min(peakHistory[i], 128) / 128 * mid * 0.9;
        const y = mid - peakOffset;
        const x = i * peakSliceWidth;
        if (i === 0) {
          waveformCtx.moveTo(x, y);
        } else {
          waveformCtx.lineTo(x, y);
        }
      }
      waveformCtx.stroke();
    }

    waveformCtx.strokeStyle = "#30d158";
    waveformCtx.lineWidth = 1.5;
    waveformCtx.beginPath();

    const sliceWidth = width / (dataArray.length - 1);
    for (let i = 0; i < dataArray.length; i++) {
      const normalized = (dataArray[i] - 128) / 128;
      const y = mid + normalized * mid * 0.9;
      const x = i * sliceWidth;
      if (i === 0) {
        waveformCtx.moveTo(x, y);
      } else {
        waveformCtx.lineTo(x, y);
      }
    }
    waveformCtx.stroke();
    visualizationRafId = requestAnimationFrame(draw);
  };

  draw();
}

async function startTimer() {
  if (!averagePeak) {
    statusEl.textContent = "Record sample shots first";
    return;
  }

  await initAudio();
  clearPendingTimers();
  resetDetectionState();
  shots = [];
  resultsEl.textContent = "";
  shotCount = 0;
  sampleShotCount = 0;
  shotCountEl.textContent = "Shots: 0";

  statusEl.textContent = "Stand by...";
  setIndicatorState({ listening: true, beep: false, shot: false });

  const delayMs = getStartDelayMs();
  delayTimeoutId = window.setTimeout(() => {
    startTime = performance.now();
    statusEl.textContent = "BEEP!";
    setIndicatorState({ listening: true, beep: true, shot: false });
    playGoBeep();
    scheduleParBeep();
    detectShots();
  }, delayMs);
}

function getStartDelayMs() {
  const fixedDelaySeconds = clampNumber(Number(fixedDelayEl.value), MIN_DELAY_SECONDS, MAX_DELAY_SECONDS);
  if (!randomDelayEl.checked) {
    return fixedDelaySeconds * 1000;
  }

  const minDelaySeconds = clampNumber(Number(minDelayEl.value), MIN_DELAY_SECONDS, MAX_DELAY_SECONDS);
  const maxDelaySeconds = clampNumber(Number(maxDelayEl.value), minDelaySeconds, MAX_DELAY_SECONDS);
  const randomDelay = minDelaySeconds + Math.random() * (maxDelaySeconds - minDelaySeconds);
  return randomDelay * 1000;
}

function scheduleParBeep() {
  if (!parEnabledEl.checked) return;
  const parSeconds = Math.max(0, Number(parTimeEl.value));
  if (!parSeconds) return;

  parTimeoutId = window.setTimeout(() => {
    playGoBeep(1600);
  }, parSeconds * 1000);
}

async function playGoBeep(frequency = 1800) {
  if (!audioContext) return;
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const now = audioContext.currentTime;
  const duration = 0.08;

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(frequency, now);

  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.linearRampToValueAtTime(0.32, now + 0.004);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.start(now);
  oscillator.stop(now + duration);

  oscillator.onended = () => {
    oscillator.disconnect();
    gainNode.disconnect();
  };
}

function detectShots() {
  analyser.getByteTimeDomainData(dataArray);

  const peak = calculatePeak();
  latestPeak = peak;
  updateEnvelope(peak);

  const threshold = getDynamicThreshold();
  const now = performance.now();

  if (envelope > threshold &&
      envelope - lastEnvelope > IMPULSE_RISE_THRESHOLD &&
      now - lastShotTime >= SHOT_COOLDOWN_MS) {
    const t = (now - startTime) / 1000;
    shots.push(t);
    shotCount = shots.length;
    lastShotTime = now;
    shotCountEl.textContent = `Shots: ${shotCount}`;
    updateResults();
    flashShotIndicator();
  }

  lastEnvelope = envelope;
  detectionRafId = requestAnimationFrame(detectShots);
}

function updateEnvelope(peak) {
  if (peak > envelope) {
    envelope += (peak - envelope) * ENVELOPE_ATTACK;
  } else {
    envelope *= ENVELOPE_DECAY;
  }

  if (!noiseFloor || envelope < noiseFloor) {
    noiseFloor = envelope;
  }
  noiseFloor += (envelope - noiseFloor) * NOISE_FLOOR_ALPHA;
}

function getDynamicThreshold() {
  const sensitivity = mapSensitivity(Number(sensitivityEl.value));
  const baseThreshold = averagePeak ? averagePeak * sensitivity : 0;
  const noiseThreshold = noiseFloor * NOISE_MULTIPLIER;
  return Math.max(baseThreshold, noiseThreshold, 10);
}

function mapSensitivity(value) {
  const clamped = Math.max(0, Math.min(1, value));
  const curve = Math.pow(clamped, 1.5);
  return 2.0 - curve * 1.5;
}

function calculatePeak() {
  let peak = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = Math.abs(dataArray[i] - 128);
    if (v > peak) peak = v;
  }
  return peak;
}

function getReferencePeak() {
  const sensitivity = Number(sensitivityEl.value);
  const basePeak = averagePeak
    ?? (peakHistory.length
      ? peakHistory.reduce((sum, value) => sum + value, 0) / peakHistory.length
      : latestPeak);
  return basePeak * mapSensitivity(sensitivity);
}

function updateResults() {
  resultsEl.textContent = shots
    .map((t, i) =>
      i === 0
        ? `First Shot: ${t.toFixed(2)}s`
        : `Split ${i}: ${(t - shots[i - 1]).toFixed(2)}s`
    )
    .join("\n");
}

function resetTimer() {
  clearPendingTimers();
  resetDetectionState();
  shots = [];
  shotCount = 0;
  resultsEl.textContent = "";
  shotCountEl.textContent = "Shots: 0";
  statusEl.textContent = "Idle";
  setIndicatorState({ listening: false, beep: false, shot: false });
}

function resetDetectionState() {
  cancelAnimationFrame(detectionRafId);
  envelope = 0;
  lastEnvelope = 0;
  noiseFloor = 0;
  lastShotTime = -Infinity;
}

function clearPendingTimers() {
  if (delayTimeoutId) {
    clearTimeout(delayTimeoutId);
    delayTimeoutId = null;
  }
  if (parTimeoutId) {
    clearTimeout(parTimeoutId);
    parTimeoutId = null;
  }
}

function updateDelayControls() {
  const isRandom = randomDelayEl.checked;
  minDelayEl.disabled = !isRandom;
  maxDelayEl.disabled = !isRandom;
  fixedDelayEl.disabled = isRandom;
}

function clampDelayInputs() {
  const minValue = clampNumber(Number(minDelayEl.value), MIN_DELAY_SECONDS, MAX_DELAY_SECONDS);
  const maxValue = clampNumber(Number(maxDelayEl.value), minValue, MAX_DELAY_SECONDS);
  minDelayEl.value = minValue;
  maxDelayEl.value = maxValue;
}

function clampNumber(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function setIndicatorState({ listening, beep, shot }) {
  setIndicator(listeningIndicator, listening);
  setIndicator(beepIndicator, beep);
  setIndicator(shotIndicator, shot);
}

function setIndicator(element, isActive) {
  element.classList.toggle("active", isActive);
}

function flashShotIndicator() {
  setIndicator(shotIndicator, true);
  if (shotFlashTimeoutId) {
    clearTimeout(shotFlashTimeoutId);
  }
  shotFlashTimeoutId = window.setTimeout(() => {
    setIndicator(shotIndicator, false);
  }, SHOT_FLASH_MS);
}

function updateParControlState() {
  parTimeEl.disabled = !parEnabledEl.checked;
}

parEnabledEl.addEventListener("change", updateParControlState);
updateParControlState();
