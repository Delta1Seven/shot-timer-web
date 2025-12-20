const APP_VERSION = "1.0.1";

let audioContext;
let analyser;
let mic;
let dataArray;
let rafId;
let visualizationRafId;

let samplePeaks = [];
let averagePeak = null;

let startTime = 0;
let shots = [];
let lastShotTime = -Infinity;
let shotCount = 0;

let sampleShotCount = 0;
let sampleStartTime = 0;
let sampleBaseline = 0;

const SHOT_COOLDOWN_MS = 150;
const SAMPLE_SHOTS_NEEDED = 4;
const SAMPLE_BASELINE_MS = 500;

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const shotCountEl = document.getElementById("shotCount");
const sensitivityEl = document.getElementById("sensitivity");
const waveformCanvas = document.getElementById("waveform");
const waveformCtx = waveformCanvas.getContext("2d");

resizeWaveformCanvas();
window.addEventListener("resize", resizeWaveformCanvas);

document.getElementById("sampleBtn").onclick = recordSamples;
document.getElementById("startBtn").onclick = startTimer;

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
  samplePeaks = [];
  averagePeak = null;
  sampleShotCount = 0;
  sampleStartTime = performance.now();
  sampleBaseline = 0;
  lastShotTime = -Infinity;

  statusEl.textContent = `Recording samples... (0/${SAMPLE_SHOTS_NEEDED})`;
  collectSamples();
}

function collectSamples() {
  analyser.getByteTimeDomainData(dataArray);

  let peak = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = Math.abs(dataArray[i] - 128);
    if (v > peak) peak = v;
  }

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
    cancelAnimationFrame(rafId);
    averagePeak = samplePeaks.reduce((a, b) => a + b, 0) / samplePeaks.length;
    statusEl.textContent = "Sample captured ✔";
    return;
  }

  rafId = requestAnimationFrame(collectSamples);
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

    waveformCtx.fillStyle = "#000";
    waveformCtx.fillRect(0, 0, width, height);

    const mid = height / 2;
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

  shots = [];
  resultsEl.textContent = "";
  shotCount = 0;
  sampleShotCount = 0;
  shotCountEl.textContent = "Shots: 0";

  statusEl.textContent = "Stand by...";
  await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

  startTime = performance.now();
  lastShotTime = -Infinity;
  statusEl.textContent = "GO!";
  await playGoBeep();

  detectShots();
}

async function playGoBeep() {
  if (!audioContext) return;
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const now = audioContext.currentTime;
  const duration = 0.1;

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(1200, now);

  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(0.25, now + 0.005);
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

  let peak = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = Math.abs(dataArray[i] - 128);
    if (v > peak) peak = v;
  }

  const threshold = averagePeak * mapSensitivity(Number(sensitivityEl.value));

  const now = performance.now();
  if (peak > threshold && now - lastShotTime >= SHOT_COOLDOWN_MS) {
    const t = (performance.now() - startTime) / 1000;
    shots.push(t);
    shotCount = shots.length;
    lastShotTime = now;
    shotCountEl.textContent = `Shots: ${shotCount}`;
    updateResults();
  }

  rafId = requestAnimationFrame(detectShots);
}

function mapSensitivity(value) {
  const clamped = Math.max(0, Math.min(1, value));
  const curve = Math.pow(clamped, 1.5);
  return 2.0 - curve * 1.5;
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
