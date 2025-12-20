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

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const sensitivityEl = document.getElementById("sensitivity");
const waveformCanvas = document.getElementById("waveform");
const waveformCtx = waveformCanvas.getContext("2d");
let waveformLastY = 0;

resizeWaveformCanvas();
window.addEventListener("resize", resizeWaveformCanvas);

document.getElementById("sampleBtn").onclick = recordSamples;
document.getElementById("startBtn").onclick = startTimer;

async function initAudio() {
  if (audioContext) return;

  audioContext = new AudioContext({ latencyHint: "interactive" });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  mic = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;

  dataArray = new Uint8Array(analyser.fftSize);
  mic.connect(analyser);
  startVisualization();
}

async function recordSamples() {
  await initAudio();
  samplePeaks = [];
  averagePeak = null;

  statusEl.textContent = "Recording samples...";
  collectSamples();

  setTimeout(() => {
    cancelAnimationFrame(rafId);
    averagePeak = samplePeaks.reduce((a,b) => a+b, 0) / samplePeaks.length;
    statusEl.textContent = "Sample captured ✔";
  }, 3000);
}

function collectSamples() {
  analyser.getByteTimeDomainData(dataArray);

  let peak = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = Math.abs(dataArray[i] - 128);
    if (v > peak) peak = v;
  }

  samplePeaks.push(peak);
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
  waveformLastY = height / 2;
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

    waveformCtx.drawImage(waveformCanvas, -1, 0);
    waveformCtx.fillStyle = "#000";
    waveformCtx.fillRect(width - 1, 0, 1, height);

    const mid = height / 2;
    const sampleIndex = Math.floor(dataArray.length * 0.5);
    const normalized = (dataArray[sampleIndex] - 128) / 128;
    const y = mid + normalized * mid * 0.8;

    waveformCtx.strokeStyle = "#30d158";
    waveformCtx.lineWidth = 1.5;
    waveformCtx.beginPath();
    waveformCtx.moveTo(width - 2, waveformLastY);
    waveformCtx.lineTo(width - 1, y);
    waveformCtx.stroke();

    waveformLastY = y;
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

  statusEl.textContent = "Stand by...";
  await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

  startTime = performance.now();
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

  const threshold = averagePeak * sensitivityEl.value;

  if (peak > threshold) {
    const t = (performance.now() - startTime) / 1000;
    shots.push(t);
    updateResults();
  }

  rafId = requestAnimationFrame(detectShots);
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
