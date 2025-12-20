let audioContext;
let analyser;
let mic;
let dataArray;
let rafId;

let samplePeaks = [];
let averagePeak = null;

let startTime = 0;
let shots = [];

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const sensitivityEl = document.getElementById("sensitivity");

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

  detectShots();
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
