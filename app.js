const APP_VERSION = "1.0.7";

let audioContext;
let analyser;
let mic;
let dataArray;
let processingRafId;
let visualizationRafId;
let delayTimeoutId;
let shotFlashTimeoutId;

let startTime = 0;
let shots = [];
let shotCount = 0;
let totalShots = 0;

const SHOT_COOLDOWN_DEFAULT_MS = 160;
const SHOT_COOLDOWN_MIN_MS = 1;
const SHOT_COOLDOWN_MAX_MS = 500;
const SILENCE_RESET_DEFAULT_MS = 40;
const SILENCE_RESET_MIN_MS = 1;
const SILENCE_RESET_MAX_MS = 500;
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
const MAX_SHOT_HISTORY = 60;
const CALIBRATION_SHOTS_REQUIRED = 4;
const CALIBRATION_PEAK_WINDOW_MS = 160;
const CALIBRATION_PEAK_BUFFER = 0.9;

const statusEl = document.getElementById("status");
const shotCountValueEl = document.getElementById("shotCountValue");
const elapsedTimeValueEl = document.getElementById("elapsedTimeValue");
const firstShotValueEl = document.getElementById("firstShotValue");
const splitTimeValueEl = document.getElementById("splitTimeValue");
const sensitivityEl = document.getElementById("sensitivity");
const waveformCanvas = document.getElementById("waveform");
const waveformCtx = waveformCanvas.getContext("2d");
const randomDelayEl = document.getElementById("randomDelay");
const minDelayEl = document.getElementById("minDelay");
const maxDelayEl = document.getElementById("maxDelay");
const fixedDelayEl = document.getElementById("fixedDelay");
const advancedToggleEl = document.getElementById("advancedToggle");
const advancedPanelEl = document.getElementById("advancedPanel");
const shotCooldownEl = document.getElementById("shotCooldown");
const silenceResetEl = document.getElementById("silenceReset");
const infoIcons = document.querySelectorAll(".info-icon");
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
  lastBelowThresholdTime: -Infinity,
};

let shotCooldownMs = SHOT_COOLDOWN_DEFAULT_MS;
let minSilenceBeforeShotMs = SILENCE_RESET_DEFAULT_MS;

resizeWaveformCanvas();
window.addEventListener("resize", resizeWaveformCanvas);

minDelayEl.value = DEFAULT_DELAY_MIN;
maxDelayEl.value = DEFAULT_DELAY_MAX;
fixedDelayEl.value = DEFAULT_FIXED_DELAY;
shotCooldownEl.value = shotCooldownMs;
silenceResetEl.value = minSilenceBeforeShotMs;

randomDelayEl.addEventListener("change", updateDelayControls);
minDelayEl.addEventListener("input", clampDelayInputs);
maxDelayEl.addEventListener("input", clampDelayInputs);
advancedToggleEl.addEventListener("click", toggleAdvancedSettings);
shotCooldownEl.addEventListener("input", handleShotCooldownInput);
shotCooldownEl.addEventListener("blur", commitShotCooldown);
shotCooldownEl.addEventListener("change", commitShotCooldown);
silenceResetEl.addEventListener("input", handleSilenceResetInput);
silenceResetEl.addEventListener("blur", commitSilenceReset);
silenceResetEl.addEventListener("change", commitSilenceReset);
infoIcons.forEach((icon) => icon.addEventListener("click", handleInfoToggle));
document.addEventListener("click", closeInfoTooltips);

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

  statusEl.textContent = "Fire 4 shots to calibrate...";
  setIndicatorState({ listening: true, beep: false, shot: false });

  const calibrationPeaks = [];
  let wasAboveThreshold = false;
  let lastShotTime = -Infinity;
  let peakCapture = null;

  const sample = () => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(dataArray);
    const peak = calculatePeakNormalized(dataArray);
    const normalizedLevel = clampNumber(peak * audioState.autoGain, 0, 1);
    const now = performance.now();

    if (peakCapture) {
      peakCapture.peak = Math.max(peakCapture.peak, normalizedLevel);
      if (now - peakCapture.startedAt >= CALIBRATION_PEAK_WINDOW_MS) {
        finalizeCalibrationShot(peakCapture.peak);
        peakCapture = null;
      }
    }

    const threshold = getThreshold();
    const isAbove = normalizedLevel >= threshold;
    if (isAbove && !wasAboveThreshold && !peakCapture && now - lastShotTime >= shotCooldownMs) {
      peakCapture = { startedAt: now, peak: normalizedLevel };
      lastShotTime = now;
    }
    wasAboveThreshold = isAbove;

    if (calibrationPeaks.length < CALIBRATION_SHOTS_REQUIRED) {
      requestAnimationFrame(sample);
    }
  };

  const finalizeCalibrationShot = (shotPeak) => {
    const targetThreshold = clampNumber(shotPeak * CALIBRATION_PEAK_BUFFER, 0.1, 1);
    applySensitivityThreshold(targetThreshold);
    calibrationPeaks.push(shotPeak);
    statusEl.textContent = `Shot ${calibrationPeaks.length}/${CALIBRATION_SHOTS_REQUIRED} captured...`;

    if (calibrationPeaks.length === CALIBRATION_SHOTS_REQUIRED) {
      const averagePeak =
        calibrationPeaks.reduce((sum, value) => sum + value, 0) / calibrationPeaks.length;
      const averageThreshold = clampNumber(averagePeak * CALIBRATION_PEAK_BUFFER, 0.1, 1);
      applySensitivityThreshold(averageThreshold);
      statusEl.textContent = "Calibration complete ✔";
      setIndicatorState({ listening: false, beep: false, shot: false });
    }
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

    const levelForDetection = Math.max(rawPeak, audioState.smoothedLevel);
    const normalizedLevel = clampNumber(levelForDetection * audioState.autoGain, 0, 1);
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
      // Track the moment audio falls below the threshold for silence timing.
      if (audioState.isAboveThreshold) {
        shotDetector.lastBelowThresholdTime = now;
      }
      audioState.isAboveThreshold = false;
      processingRafId = requestAnimationFrame(process);
      return;
    }

    const timeSinceLastShot = now - shotDetector.lastShotTime;
    const timeSinceBelowThreshold = now - shotDetector.lastBelowThresholdTime;
    // Require both cooldown and a minimum silence window before a new shot.
    const canRegisterShot =
      shotDetector.isActive &&
      timeSinceLastShot >= shotCooldownMs &&
      timeSinceBelowThreshold >= minSilenceBeforeShotMs;

    if (!audioState.isAboveThreshold && canRegisterShot) {
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
  clearPendingTimers();
  resetDetectionState();
  shots = [];
  shotCount = 0;
  totalShots = 0;
  updateDisplay();

  statusEl.textContent = "Requesting microphone...";
  setIndicatorState({ listening: true, beep: false, shot: false });

  try {
    await initAudio();
  } catch (error) {
    statusEl.textContent = "Microphone access blocked.";
    setIndicatorState({ listening: false, beep: false, shot: false });
    return;
  }

  statusEl.textContent = "Stand by...";
  const delayMs = getStartDelayMs();
  delayTimeoutId = window.setTimeout(() => {
    startTime = performance.now();
    statusEl.textContent = "BEEP!";
    setIndicatorState({ listening: true, beep: true, shot: false });
    playGoBeep();
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
  if (shots.length > MAX_SHOT_HISTORY) {
    shots.shift();
  }
  totalShots += 1;
  shotCount = totalShots;
  shotDetector.lastShotTime = now;
  audioState.shotPulseUntil = now + SHOT_FLASH_MS;
  updateDisplay();
  flashShotIndicator();
}

function updateDisplay() {
  const shotTotal = totalShots;
  const lastShotTime = shots.length ? shots[shots.length - 1] : 0;
  const firstShotTime = shots.length ? shots[0] : 0;
  const splitTime =
    shots.length >= 2 ? shots[shots.length - 1] - shots[shots.length - 2] : 0;

  shotCountValueEl.textContent = shotTotal;
  elapsedTimeValueEl.textContent = formatTime(lastShotTime);
  firstShotValueEl.textContent = formatTime(firstShotTime);
  splitTimeValueEl.textContent = formatTime(splitTime);
}

function resetTimer() {
  clearPendingTimers();
  resetDetectionState();
  shots = [];
  shotCount = 0;
  totalShots = 0;
  updateDisplay();
  statusEl.textContent = "Idle";
  setIndicatorState({ listening: false, beep: false, shot: false });
}

function resetDetectionState() {
  shotDetector.isActive = false;
  shotDetector.lastShotTime = -Infinity;
  shotDetector.lastBelowThresholdTime = performance.now();
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

function toggleAdvancedSettings() {
  const isExpanded = advancedToggleEl.getAttribute("aria-expanded") === "true";
  advancedToggleEl.setAttribute("aria-expanded", String(!isExpanded));
  advancedPanelEl.classList.toggle("is-open", !isExpanded);
}

function handleShotCooldownInput() {
  const value = Number(shotCooldownEl.value);
  if (Number.isFinite(value)) {
    shotCooldownEl.dataset.rawValue = String(value);
  }
}

function commitShotCooldown() {
  // Validate on blur/change to avoid interrupting typing.
  const rawValue = Number(shotCooldownEl.value);
  const nextValue = Number.isFinite(rawValue)
    ? clampNumber(rawValue, SHOT_COOLDOWN_MIN_MS, SHOT_COOLDOWN_MAX_MS)
    : shotCooldownMs;
  shotCooldownMs = nextValue;
  shotCooldownEl.value = nextValue;
}

function handleSilenceResetInput() {
  const value = Number(silenceResetEl.value);
  if (Number.isFinite(value)) {
    silenceResetEl.dataset.rawValue = String(value);
  }
}

function commitSilenceReset() {
  // Validate on blur/change to avoid interrupting typing.
  const rawValue = Number(silenceResetEl.value);
  const nextValue = Number.isFinite(rawValue)
    ? clampNumber(rawValue, SILENCE_RESET_MIN_MS, SILENCE_RESET_MAX_MS)
    : minSilenceBeforeShotMs;
  minSilenceBeforeShotMs = nextValue;
  silenceResetEl.value = nextValue;
}

function handleInfoToggle(event) {
  event.stopPropagation();
  const icon = event.currentTarget;
  const shouldOpen = !icon.classList.contains("is-open");
  infoIcons.forEach((item) => item.classList.remove("is-open"));
  if (shouldOpen) {
    icon.classList.add("is-open");
  }
}

function closeInfoTooltips(event) {
  if (event.target.closest(".info-icon")) return;
  infoIcons.forEach((item) => item.classList.remove("is-open"));
}

function smoothValue(previous, next, factor) {
  return previous + (next - previous) * factor;
}

function formatTime(value) {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

function getSensitivityValue() {
  return clampNumber(Number(sensitivityEl.value), 0, 1);
}

function getThreshold() {
  const sensitivityValue = getSensitivityValue();
  const normalizedThreshold = 0.1 + (1 - sensitivityValue) * 0.9;
  return clampNumber(normalizedThreshold, 0.1, 1);
}

function applySensitivityThreshold(threshold) {
  const sensitivityValue = clampNumber((1 - threshold) / 0.9, 0, 1);
  sensitivityEl.value = sensitivityValue.toFixed(2);
  sensitivityEl.dispatchEvent(new Event("input", { bubbles: true }));
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
