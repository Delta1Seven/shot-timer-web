const APP_VERSION = "1.0.10";

let audioContext;
let analyser;
let mic;
let micStream;
let dataArray;
let silentGain;
let processingRafId;
let visualizationRafId;
let delayTimeoutId;
let shotFlashTimeoutId;
let playbackSource;

let startTime = 0;
let shots = [];
let shotCount = 0;
let totalShots = 0;
let displayedShotIndex = -1;

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
const MIN_THRESHOLD = 0.1;
const MAX_THRESHOLD = 1;
const CALIBRATION_SHOTS_REQUIRED = 4;
const CALIBRATION_PEAK_WINDOW_MS = 160;
const CALIBRATION_PEAK_BUFFER = 0.9;
const BEEP_IGNORE_AFTER_MS = 100;
const BEEP_FFT_WINDOW_MS = 300;
const BEEP_FREQUENCY_MIN = 2200;
const BEEP_FREQUENCY_MAX = 2400;
const RECORD_DURATION_MS = 12000;
const IMPULSE_WINDOW_SIZE = 6;
const IMPULSE_RISE_THRESHOLD = 0.18;
const IMPULSE_PEAK_BOOST = 0.12;
const ECHO_REJECT_MS = 45;
const FAST_SPLIT_MIN_MS = 120;

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
const shotNavUpEl = document.getElementById("shotNavUp");
const shotNavDownEl = document.getElementById("shotNavDown");
const recordBtn = document.getElementById("recordBtn");
const uploadTestBtn = document.getElementById("uploadTestBtn");
const testAudioInput = document.getElementById("testAudioInput");

let activeTooltip = null;
let activeTooltipIcon = null;
let tooltipPositionHandler = null;

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
  lastNormalizedLevel: 0,
};

const shotDetector = {
  isActive: false,
  lastShotTime: -Infinity,
  lastBelowThresholdTime: -Infinity,
};

let lastRegisteredImpulseAt = -Infinity;

const recordingState = {
  isRecording: false,
  buffers: [],
  length: 0,
  processor: null,
  gain: null,
  stopTimeoutId: null,
};

let beepEndTime = -Infinity;

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
document.addEventListener("visibilitychange", handlePageHidden);
window.addEventListener("pagehide", handlePageHidden);

shotNavUpEl.addEventListener("click", () => navigateShots(-1));
shotNavDownEl.addEventListener("click", () => navigateShots(1));

updateDelayControls();

sensitivityEl.addEventListener("input", () => {
  audioState.isAboveThreshold = false;
});

document.getElementById("sampleBtn").onclick = recordSamples;
document.getElementById("startBtn").onclick = startTimer;
document.getElementById("resetBtn").onclick = resetTimer;
recordBtn.addEventListener("click", startRecording);
uploadTestBtn.addEventListener("click", () => testAudioInput.click());
testAudioInput.addEventListener("change", handleTestAudioSelection);

async function ensureAudioGraph() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: "interactive" });
  }

  if (!analyser) {
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
  }

  if (!dataArray && analyser) {
    dataArray = new Uint8Array(analyser.fftSize);
  }

  if (!silentGain && audioContext) {
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
  }

  if (analyser && silentGain) {
    analyser.disconnect();
    silentGain.disconnect();
    analyser.connect(silentGain);
    silentGain.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  startProcessing();
  startVisualization();
}

async function initAudio() {
  await ensureAudioGraph();
  if (mic) return;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  micStream = stream;

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  mic = audioContext.createMediaStreamSource(stream);
  mic.connect(analyser);
}

function stopMicInput() {
  stopRecording();
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (mic) {
    mic.disconnect();
    mic = null;
  }
}

function stopTestPlayback() {
  if (playbackSource) {
    playbackSource.onended = null;
    try {
      playbackSource.stop();
    } catch (error) {
      // Ignore if already stopped.
    }
    playbackSource.disconnect();
    playbackSource = null;
  }
  shotDetector.isActive = false;
}

async function handleTestAudioSelection(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  await startTestPlaybackFromFile(file);
}

async function startTestPlaybackFromFile(file) {
  stopTestPlayback();
  stopMicInput();
  clearPendingTimers();
  resetDetectionState();
  shots = [];
  shotCount = 0;
  totalShots = 0;
  displayedShotIndex = -1;
  updateDisplay();

  statusEl.textContent = "Decoding audio...";
  setIndicatorState({ listening: false, beep: false, shot: false });

  await ensureAudioGraph();

  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);

  playbackSource = source;

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  resetDetectionState();
  startTime = performance.now();
  shotDetector.isActive = true;
  statusEl.textContent = "Testing audio...";
  setIndicatorState({ listening: true, beep: false, shot: false });

  source.start();
  source.onended = handleTestPlaybackEnded;
}

function handleTestPlaybackEnded() {
  shotDetector.isActive = false;
  resetDetectionState();
  setIndicatorState({ listening: false, beep: false, shot: false });
  statusEl.textContent = "Idle";
  if (playbackSource) {
    playbackSource.disconnect();
    playbackSource = null;
  }
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
    const risingEdge = normalizedLevel - audioState.lastNormalizedLevel;
    audioState.lastNormalizedLevel = normalizedLevel;
    const recentAverage = calculateRecentAverage(audioState.history, IMPULSE_WINDOW_SIZE);

    audioState.history.push(normalizedLevel);
    if (audioState.history.length > HISTORY_LENGTH) {
      audioState.history.shift();
    }

    const threshold = getThreshold();
    const now = performance.now();
    const isAbove = normalizedLevel >= threshold;
    let beepLikeCrossing = false;

    if (isAbove && !audioState.isAboveThreshold) {
      audioState.crossingPulseUntil = now + CROSSING_FLASH_MS;
      audioState.lastCrossingLevel = normalizedLevel;
      if (isBeepFilterWindowActive(now) && isBeepLikeSignal()) {
        beepLikeCrossing = true;
      }
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
    const canRegisterShot =
      shotDetector.isActive &&
      timeSinceLastShot >= shotCooldownMs &&
      now > beepEndTime + BEEP_IGNORE_AFTER_MS;
    const silenceReady = timeSinceBelowThreshold >= minSilenceBeforeShotMs;
    const impulseDetected = detectImpulse(normalizedLevel, threshold, risingEdge, recentAverage);
    const timeSinceLastImpulse = now - lastRegisteredImpulseAt;
    const pastEchoReject = timeSinceLastImpulse >= ECHO_REJECT_MS;
    const pastFastSplitMin = now - shotDetector.lastShotTime >= FAST_SPLIT_MIN_MS;
    const impulseOk = impulseDetected && pastEchoReject;
    const silenceOk = !audioState.isAboveThreshold && silenceReady;
    const allowByImpulse = impulseOk && (pastFastSplitMin || silenceOk);

    if (!beepLikeCrossing && canRegisterShot && (silenceOk || allowByImpulse)) {
      lastRegisteredImpulseAt = now;
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
  displayedShotIndex = -1;
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

async function playGoBeep(frequency = 2300) {
  if (!audioContext) return;
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const now = audioContext.currentTime;
  const duration = 0.35;
  const beepEndTimestamp = performance.now() + duration * 1000;
  beepEndTime = beepEndTimestamp;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, now);

  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.linearRampToValueAtTime(0.3, now + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.start(now);
  oscillator.stop(now + duration);

  oscillator.onended = () => {
    oscillator.disconnect();
    gainNode.disconnect();
    beepEndTime = performance.now();
  };
}

async function startRecording() {
  try {
    await initAudio();
  } catch (error) {
    statusEl.textContent = "Microphone access blocked.";
    return;
  }
  if (!audioContext || recordingState.isRecording || !mic) return;

  recordingState.isRecording = true;
  recordingState.buffers = [];
  recordingState.length = 0;

  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const gain = audioContext.createGain();
  gain.gain.value = 0;

  processor.onaudioprocess = (event) => {
    if (!recordingState.isRecording) return;
    const inputBuffer = event.inputBuffer.getChannelData(0);
    recordingState.buffers.push(new Float32Array(inputBuffer));
    recordingState.length += inputBuffer.length;
  };

  mic.connect(processor);
  processor.connect(gain);
  gain.connect(audioContext.destination);

  recordingState.processor = processor;
  recordingState.gain = gain;
  recordBtn.disabled = true;
  recordBtn.textContent = "Recording Shot Audio...";

  recordingState.stopTimeoutId = window.setTimeout(() => {
    stopRecording();
  }, RECORD_DURATION_MS);
}

function stopRecording() {
  if (!recordingState.isRecording) return;
  recordingState.isRecording = false;

  if (recordingState.stopTimeoutId) {
    clearTimeout(recordingState.stopTimeoutId);
    recordingState.stopTimeoutId = null;
  }

  if (recordingState.processor) {
    recordingState.processor.disconnect();
    if (mic) {
      mic.disconnect(recordingState.processor);
    }
  }
  if (recordingState.gain) {
    recordingState.gain.disconnect();
  }

  const buffers = recordingState.buffers;
  const length = recordingState.length;
  recordingState.buffers = [];
  recordingState.length = 0;
  recordingState.processor = null;
  recordingState.gain = null;

  recordBtn.disabled = false;
  recordBtn.textContent = "Record Shot Audio";

  if (!length || !audioContext) return;
  const wavBuffer = encodeWav(buffers, length, audioContext.sampleRate);
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `shot-audio-calibration-${formatTimestamp(new Date())}.wav`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function registerShot(now) {
  const elapsed = (now - startTime) / 1000;
  shots.push(elapsed);
  if (shots.length > MAX_SHOT_HISTORY) {
    shots.shift();
  }
  totalShots += 1;
  shotCount = totalShots;
  displayedShotIndex = shots.length - 1;
  shotDetector.lastShotTime = now;
  audioState.shotPulseUntil = now + SHOT_FLASH_MS;
  updateDisplay();
  flashShotIndicator();
}

function updateDisplay() {
  const shotTotal = totalShots;
  if (!shots.length) {
    shotCountValueEl.textContent = shotTotal;
    elapsedTimeValueEl.textContent = formatTime(0);
    firstShotValueEl.textContent = formatTime(0);
    splitTimeValueEl.textContent = formatTime(0);
    displayedShotIndex = -1;
    updateShotNavControls();
    return;
  }

  if (displayedShotIndex < 0 || displayedShotIndex >= shots.length) {
    displayedShotIndex = shots.length - 1;
  }

  const lastShotTime = shots[displayedShotIndex];
  const firstShotTime = shots[0];
  const splitTime =
    displayedShotIndex >= 1 ? shots[displayedShotIndex] - shots[displayedShotIndex - 1] : 0;

  const displayedShotNumber = displayedShotIndex >= 0 ? displayedShotIndex + 1 : shotTotal;

  shotCountValueEl.textContent = displayedShotNumber;
  elapsedTimeValueEl.textContent = formatTime(lastShotTime);
  firstShotValueEl.textContent = formatTime(firstShotTime);
  splitTimeValueEl.textContent = formatTime(splitTime);
  updateShotNavControls();
}

function resetTimer() {
  clearPendingTimers();
  resetDetectionState();
  stopRecording();
  shots = [];
  shotCount = 0;
  totalShots = 0;
  displayedShotIndex = -1;
  updateDisplay();
  statusEl.textContent = "Idle";
  setIndicatorState({ listening: false, beep: false, shot: false });
}

function navigateShots(direction) {
  if (!shots.length) return;
  const nextIndex = clampNumber(displayedShotIndex + direction, 0, shots.length - 1);
  if (nextIndex === displayedShotIndex) return;
  displayedShotIndex = nextIndex;
  updateDisplay();
}

function updateShotNavControls() {
  const hasShots = shots.length > 0;
  shotNavUpEl.disabled = !hasShots || displayedShotIndex <= 0;
  shotNavDownEl.disabled = !hasShots || displayedShotIndex >= shots.length - 1;
}

function resetDetectionState() {
  shotDetector.isActive = false;
  shotDetector.lastShotTime = -Infinity;
  shotDetector.lastBelowThresholdTime = performance.now();
  lastRegisteredImpulseAt = -Infinity;
  audioState.isAboveThreshold = false;
  audioState.shotPulseUntil = 0;
  audioState.crossingPulseUntil = 0;
  audioState.lastNormalizedLevel = 0;
  startTime = 0;
  beepEndTime = -Infinity;
}

function clearPendingTimers() {
  if (delayTimeoutId) {
    clearTimeout(delayTimeoutId);
    delayTimeoutId = null;
  }
}

function handlePageHidden(event) {
  if (event.type === "visibilitychange" && !document.hidden) return;
  handleBackgrounded();
}

function handleBackgrounded() {
  clearPendingTimers();
  resetDetectionState();
  stopRecording();
  stopTestPlayback();
  setIndicatorState({ listening: false, beep: false, shot: false });
  statusEl.textContent = "Idle";
  stopAudioProcessing();
  releaseAudioResources();
  closeActiveTooltip();
}

function stopAudioProcessing() {
  if (processingRafId) {
    cancelAnimationFrame(processingRafId);
    processingRafId = null;
  }
  if (visualizationRafId) {
    cancelAnimationFrame(visualizationRafId);
    visualizationRafId = null;
  }
}

async function releaseAudioResources() {
  stopRecording();
  stopTestPlayback();
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (mic) {
    mic.disconnect();
    mic = null;
  }
  if (analyser) {
    analyser.disconnect();
    analyser = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  dataArray = null;
  if (audioContext) {
    const contextToClose = audioContext;
    audioContext = null;
    try {
      await contextToClose.close();
    } catch (error) {
      // Closing can fail on some browsers; ignore since we're already stopping tracks.
    }
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
  if (activeTooltipIcon === icon) {
    closeActiveTooltip();
    return;
  }
  openInfoTooltip(icon);
}

function closeInfoTooltips(event) {
  if (event.target.closest(".info-icon") || event.target.closest(".tooltip-overlay")) return;
  closeActiveTooltip();
}

function positionTooltip() {
  if (!activeTooltip || !activeTooltipIcon) return;
  const iconRect = activeTooltipIcon.getBoundingClientRect();
  const tooltipRect = activeTooltip.getBoundingClientRect();
  const viewportPadding = 8;
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;
  const preferredTop = iconRect.top + scrollY - tooltipRect.height - 10;
  const placeAbove = preferredTop >= scrollY + viewportPadding;

  let top = placeAbove ? preferredTop : iconRect.bottom + scrollY + 10;
  const maxTop = scrollY + window.innerHeight - tooltipRect.height - viewportPadding;
  top = clampNumber(top, scrollY + viewportPadding, Math.max(scrollY + viewportPadding, maxTop));

  let left = iconRect.left + scrollX + iconRect.width / 2 - tooltipRect.width / 2;
  const maxLeft = scrollX + window.innerWidth - tooltipRect.width - viewportPadding;
  left = clampNumber(left, scrollX + viewportPadding, Math.max(scrollX + viewportPadding, maxLeft));

  activeTooltip.style.top = `${top}px`;
  activeTooltip.style.left = `${left}px`;
}

function openInfoTooltip(icon) {
  closeActiveTooltip();
  const tooltipText = icon.dataset.tooltip;
  if (!tooltipText) return;

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip-overlay";
  tooltip.textContent = tooltipText;
  tooltip.addEventListener("click", (event) => event.stopPropagation());
  document.body.appendChild(tooltip);

  icon.classList.add("is-open");
  activeTooltip = tooltip;
  activeTooltipIcon = icon;
  tooltipPositionHandler = () => positionTooltip();
  positionTooltip();
  window.addEventListener("scroll", tooltipPositionHandler, { passive: true });
  window.addEventListener("resize", tooltipPositionHandler);
}

function closeActiveTooltip() {
  if (activeTooltip) {
    activeTooltip.remove();
  }
  if (activeTooltipIcon) {
    activeTooltipIcon.classList.remove("is-open");
  }
  if (tooltipPositionHandler) {
    window.removeEventListener("scroll", tooltipPositionHandler);
    window.removeEventListener("resize", tooltipPositionHandler);
  }
  activeTooltip = null;
  activeTooltipIcon = null;
  tooltipPositionHandler = null;
}

function isBeepFilterWindowActive(now) {
  return Number.isFinite(beepEndTime) && now <= beepEndTime + BEEP_FFT_WINDOW_MS;
}

function isBeepLikeSignal() {
  if (!analyser || !audioContext) return false;
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freqData);

  let sum = 0;
  let maxValue = 0;
  let maxIndex = 0;
  for (let i = 0; i < freqData.length; i++) {
    const value = freqData[i];
    sum += value;
    if (value > maxValue) {
      maxValue = value;
      maxIndex = i;
    }
  }

  if (sum === 0) return false;
  const dominantFrequency = (maxIndex * audioContext.sampleRate) / analyser.fftSize;
  const dominantRatio = maxValue / sum;

  let entropy = 0;
  for (let i = 0; i < freqData.length; i++) {
    const value = freqData[i];
    if (!value) continue;
    const p = value / sum;
    entropy -= p * Math.log2(p);
  }
  const normalizedEntropy = entropy / Math.log2(freqData.length);
  const isNarrowband = dominantRatio > 0.45 && normalizedEntropy < 0.55;
  const isInBeepBand =
    dominantFrequency >= BEEP_FREQUENCY_MIN && dominantFrequency <= BEEP_FREQUENCY_MAX;

  return isInBeepBand && isNarrowband;
}

function calculateRecentAverage(history, windowSize) {
  const count = Math.min(windowSize, history.length);
  if (!count) return 0;
  let sum = 0;
  for (let i = history.length - count; i < history.length; i++) {
    sum += history[i];
  }
  return sum / count;
}

function detectImpulse(level, threshold, risingEdge, recentAverage) {
  if (level < threshold) return false;
  const peakBoost = level - recentAverage;
  return risingEdge >= IMPULSE_RISE_THRESHOLD && peakBoost >= IMPULSE_PEAK_BOOST;
}

function smoothValue(previous, next, factor) {
  return previous + (next - previous) * factor;
}

function formatTime(value) {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function encodeWav(buffers, length, sampleRate) {
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (let i = 0; i < buffers.length; i++) {
    const channel = buffers[i];
    for (let j = 0; j < channel.length; j++) {
      const sample = Math.max(-1, Math.min(1, channel[j]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return buffer;
}

function getSensitivityValue() {
  return clampNumber(Number(sensitivityEl.value), 0, 1);
}

function getThreshold() {
  const sensitivityValue = getSensitivityValue();
  // Higher sensitivity should lower the detection threshold.
  const normalizedThreshold =
    MAX_THRESHOLD - sensitivityValue * (MAX_THRESHOLD - MIN_THRESHOLD);
  return clampNumber(normalizedThreshold, MIN_THRESHOLD, MAX_THRESHOLD);
}

function applySensitivityThreshold(threshold) {
  const sensitivityValue = clampNumber(
    (MAX_THRESHOLD - threshold) / (MAX_THRESHOLD - MIN_THRESHOLD),
    0,
    1
  );
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
