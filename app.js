const APP_VERSION = "1.2.0";

let audioContext;
let analyser;
let mic;
let dataArray;
let processingRafId;
let visualizationRafId;
let delayTimeoutId;
let parTimeoutId;
let shotFlashTimeoutId;

let startTime = 0;
let shots = [];
let shotCount = 0;

const SHOT_COOLDOWN_MS = 160;
const DEFAULT_DELAY_MIN = 1;
const DEFAULT_DELAY_MAX = 4;
const DEFAULT_FIXED_DELAY = 2;
const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 4;
const HISTORY_LENGTH = 180;
const AMPLITUDE_SMOOTHING = 0.2;
const AUTO_GAIN_TARGET = 0.7;
const AUTO_GAIN_SMOOTHING = 0.08;
const AUTO_GAIN_LERP = 0.2;
const AUTO_GAIN_MIN = 1;
const AUTO_GAIN_MAX = 8;
const CROSSING_FLASH_MS = 120;
const SHOT_FLASH_MS = 180;

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

const audioState = {
  rawLevel: 0,
  smoothedLevel: 0,
  normalizedLevel: 0,
  autoGainLevel: 0,
  autoGain: 1,
  history: [],
  isAboveThreshold: false,
  crossingPulseUntil: 0,
  lastCrossingLevel: 0,
  shotPulseUntil: 0,
};

const shotDetector = {
  isActive: false,
  lastShotTime: -Infinity,
};

resizeWaveformCanvas();
window.addEventListener("resize", resizeWaveformCanvas);

minDelayEl.value = DEFAULT_DELAY_MIN;
maxDelayEl.value = DEFAULT_DELAY_MAX;
fixedDelayEl.value = DEFAULT_FIXED_DELAY;

randomDelayEl.addEventListener("change", updateDelayControls);
minDelayEl.addEventListener("input", clampDelayInputs);
maxDelayEl.addEventListener("input", clampDelayInputs);

updateDelayControls();

sensitivityEl.addEventListener("input", () => {
  audioState.isAboveThreshold = false;
});

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
  startProcessing();
  startVisualization();
}

async function recordSamples() {
  await initAudio();
  resetDetectionState();

  statusEl.textContent = "Calibrating ambient level...";
  setIndicatorState({ listening: true, beep: false, shot: false });

  const calibrationStart = performance.now();
  const calibrationLevels = [];

  const sample = () => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(dataArray);
    const peak = calculatePeakNormalized(dataArray);
    calibrationLevels.push(peak);

    if (performance.now() - calibrationStart < 600) {
      requestAnimationFrame(sample);
      return;
    }

    const averageLevel = calibrationLevels.reduce((sum, value) => sum + value, 0) / calibrationLevels.length;
    audioState.autoGainLevel = averageLevel;
    audioState.autoGain = clampNumber(AUTO_GAIN_TARGET / Math.max(averageLevel, 0.02), AUTO_GAIN_MIN, AUTO_GAIN_MAX);
    statusEl.textContent = "Calibration complete ✔";
    setIndicatorState({ listening: false, beep: false, shot: false });
  };

  sample();
}

function resizeWaveformCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = waveformCanvas.clientWidth || 0;
  const height = waveformCanvas.clientHeight || 0;

  waveformCanvas.width = width * dpr;
  waveformCanvas.height = height * dpr;
  waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  waveformCtx.fillStyle = "#05070d";
  waveformCtx.fillRect(0, 0, width, height);
}

function startProcessing() {
  if (processingRafId) return;

  const process = () => {
    if (!analyser) {
      processingRafId = requestAnimationFrame(process);
      return;
    }

    analyser.getByteTimeDomainData(dataArray);
    const rawPeak = calculatePeakNormalized(dataArray);
    audioState.rawLevel = rawPeak;
    audioState.smoothedLevel = smoothValue(audioState.smoothedLevel, rawPeak, AMPLITUDE_SMOOTHING);

    audioState.autoGainLevel = smoothValue(audioState.autoGainLevel, audioState.smoothedLevel, AUTO_GAIN_SMOOTHING);
    const desiredGain = AUTO_GAIN_TARGET / Math.max(audioState.autoGainLevel, 0.02);
    audioState.autoGain = smoothValue(
      audioState.autoGain,
      clampNumber(desiredGain, AUTO_GAIN_MIN, AUTO_GAIN_MAX),
      AUTO_GAIN_LERP
    );

    const normalizedLevel = clampNumber(audioState.smoothedLevel * audioState.autoGain, 0, 1);
    audioState.normalizedLevel = normalizedLevel;

    audioState.history.push(normalizedLevel);
    if (audioState.history.length > HISTORY_LENGTH) {
      audioState.history.shift();
    }

    const threshold = getThreshold();
    const now = performance.now();
    const isAbove = normalizedLevel >= threshold;

    if (isAbove && !audioState.isAboveThreshold) {
      audioState.crossingPulseUntil = now + CROSSING_FLASH_MS;
      audioState.lastCrossingLevel = normalizedLevel;
    }

    if (!isAbove) {
      audioState.isAboveThreshold = false;
      processingRafId = requestAnimationFrame(process);
      return;
    }

    if (shotDetector.isActive && !audioState.isAboveThreshold && now - shotDetector.lastShotTime >= SHOT_COOLDOWN_MS) {
      registerShot(now);
    }

    audioState.isAboveThreshold = true;
    processingRafId = requestAnimationFrame(process);
  };

  process();
}

function startVisualization() {
  if (visualizationRafId) return;

  const draw = () => {
    const width = waveformCanvas.clientWidth;
    const height = waveformCanvas.clientHeight;

    if (!width || !height) {
      visualizationRafId = requestAnimationFrame(draw);
      return;
    }

    const now = performance.now();
    const shotPulseActive = now < audioState.shotPulseUntil;

    waveformCtx.fillStyle = shotPulseActive ? "#0b1f16" : "#05070d";
    waveformCtx.fillRect(0, 0, width, height);

    drawAmplitudeHistory(width, height);
    drawThresholdLine(width, height);
    drawCrossingPulse(width, height);

    if (shotPulseActive) {
      drawShotPulse(width, height);
    }

    visualizationRafId = requestAnimationFrame(draw);
  };

  draw();
}

function drawAmplitudeHistory(width, height) {
  const history = audioState.history;
  if (!history.length) return;

  waveformCtx.strokeStyle = "#22f2e8";
  waveformCtx.lineWidth = 2;
  waveformCtx.beginPath();

  const sliceWidth = width / Math.max(history.length - 1, 1);
  history.forEach((level, index) => {
    const x = index * sliceWidth;
    const y = height - level * height;
    if (index === 0) {
      waveformCtx.moveTo(x, y);
    } else {
      waveformCtx.lineTo(x, y);
    }
  });

  waveformCtx.stroke();
}

function drawThresholdLine(width, height) {
  const threshold = getThreshold();
  const y = height - threshold * height;

  waveformCtx.strokeStyle = "#ffffff";
  waveformCtx.lineWidth = 1.5;
  waveformCtx.beginPath();
  waveformCtx.moveTo(0, y);
  waveformCtx.lineTo(width, y);
  waveformCtx.stroke();
}

function drawCrossingPulse(width, height) {
  if (performance.now() > audioState.crossingPulseUntil) return;

  waveformCtx.fillStyle = "#ffffff";
  const x = width - 8;
  const y = height - audioState.lastCrossingLevel * height;
  waveformCtx.beginPath();
  waveformCtx.arc(x, y, 4, 0, Math.PI * 2);
  waveformCtx.fill();
}

function drawShotPulse(width, height) {
  waveformCtx.strokeStyle = "#4ade80";
  waveformCtx.lineWidth = 2.5;
  waveformCtx.strokeRect(1, 1, width - 2, height - 2);
}

async function startTimer() {
  await initAudio();
  clearPendingTimers();
  resetDetectionState();
  shots = [];
  resultsEl.textContent = "";
  shotCount = 0;
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
    shotDetector.isActive = true;
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

function registerShot(now) {
  const elapsed = (now - startTime) / 1000;
  shots.push(elapsed);
  shotCount = shots.length;
  shotDetector.lastShotTime = now;
  audioState.shotPulseUntil = now + SHOT_FLASH_MS;
  shotCountEl.textContent = `Shots: ${shotCount}`;
  updateResults();
  flashShotIndicator();
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
  shotDetector.isActive = false;
  shotDetector.lastShotTime = -Infinity;
  audioState.isAboveThreshold = false;
  audioState.shotPulseUntil = 0;
  audioState.crossingPulseUntil = 0;
  startTime = 0;
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

function smoothValue(previous, next, factor) {
  return previous + (next - previous) * factor;
}

function getSensitivityValue() {
  return clampNumber(Number(sensitivityEl.value), 0, 1);
}

function getThreshold() {
  const sensitivityValue = getSensitivityValue();
  const normalizedThreshold = 0.1 + (1 - sensitivityValue) * 0.9;
  return clampNumber(normalizedThreshold, 0.1, 1);
}

function calculatePeakNormalized(buffer) {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = Math.abs(buffer[i] - 128);
    if (v > peak) peak = v;
  }
  return peak / 128;
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
