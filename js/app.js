import { createPolarChart } from "./polar.js";

const appEl = document.getElementById("app");

// Every sample -- short synthetic clip or long real recording -- is published by
// scripts/sync_gallery.py in the same run_infer.py layout, so these names are constant
// across the whole site instead of per-sample config.
const DOA_FILE = "doa_over_time.json";
const MIXTURE_STEM = "mic_ref";

let catalogPromise = null;
let activeAudio = null;
let activeVideo = null;
let galleryCharts = [];
let detailCleanup = null;

function getCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch("./samples.json")
      .then((res) => res.json())
      .then((json) => json.samples);
  }
  return catalogPromise;
}

function thetaTag(theta) {
  return Number.isInteger(theta) ? String(theta) : String(theta);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** A small floating "Loading…" box to drop into a `position: relative` container while its
 * resource (DOA json, mel image, …) is still being fetched. Call hideLoadingBox(id) once
 * ready -- it's hidden via opacity, not removed, so nothing shifts when it disappears. */
function loadingBoxHtml(id, label, extraClass = "") {
  return `
    <div class="loading-box ${extraClass}" id="${id}">
      <span class="loading-box__spinner" aria-hidden="true"></span>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function hideLoadingBox(id) {
  document.getElementById(id)?.classList.add("is-hidden");
}

function destroyGalleryCharts() {
  galleryCharts.forEach((chart) => chart.destroy());
  galleryCharts = [];
}

/** Highest top-candidate score across a doa_over_time.json's windows -- used to pick an
 * interesting-looking preview frame for gallery cards (falls back to the first window). */
function pickPreviewWindow(doaOverTime) {
  const windows = (doaOverTime && doaOverTime.windows) || [];
  if (!windows.length) return null;
  const topScore = (win) => {
    const candidates = win.candidates || [];
    return candidates.length ? Math.max(...candidates.map((c) => c.score)) : -Infinity;
  };
  let best = windows[0];
  let bestScore = topScore(best);
  for (const win of windows) {
    const score = topScore(win);
    if (score > bestScore) {
      bestScore = score;
      best = win;
    }
  }
  return best;
}

/** Index of the doa_over_time.json window that should be shown for playback time `t`.
 * Windows overlap (hop < window length), so among windows containing `t` we pick the one
 * whose center is closest; if `t` falls outside every window (e.g. past the last one due to
 * rounding) we fall back to the window with the nearest center overall. */
function findWindowIndex(windows, t) {
  let bestIdx = 0;
  let bestDist = Infinity;
  let found = false;
  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    if (t >= win.start_s && t < win.end_s) {
      const dist = Math.abs(t - (win.start_s + win.end_s) / 2);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
        found = true;
      }
    }
  }
  if (found) return bestIdx;
  bestDist = Infinity;
  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    const dist = Math.abs(t - (win.start_s + win.end_s) / 2);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Icons for the polar chart's ground-truth/detected-DOA markers: samples whose folder name
 * encoded known source directions (see scripts/sync_gallery.py) get fixed ground-truth icons
 * that don't flicker between windows; samples with no known ground truth (e.g. real
 * recordings) fall back to the live per-window detected candidate peaks instead. */
function groundTruthOrCandidates(sample, candidates) {
  const doaList = sample.doa_list || [];
  return doaList.length ? doaList : candidates.map((c) => c.theta);
}

async function route() {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }
  if (activeVideo) {
    activeVideo.pause();
    activeVideo = null;
  }
  if (detailCleanup) {
    detailCleanup();
    detailCleanup = null;
  }
  destroyGalleryCharts();
  const hash = window.location.hash || "#/";
  const match = hash.match(/^#\/sample\/([^/]+)/);
  if (match) {
    await renderDetail(decodeURIComponent(match[1]));
  } else {
    await renderList();
  }
}

async function renderList() {
  let samples;
  try {
    samples = await getCatalog();
  } catch (err) {
    appEl.innerHTML = `<p class="error-state">Could not load samples.json: ${escapeHtml(err.message)}</p>`;
    return;
  }

  // Every sample uses the same renderer/player (see renderDetail); "kind" only decides which
  // section a sample is grouped under on this page (set by scripts/sync_gallery.py based on
  // whether a lip video sibling was found for that recording).
  const avsrSamples = samples.filter((s) => s.kind === "avsr_doa");
  const staticSamples = samples.filter((s) => s.kind !== "avsr_doa");

  appEl.innerHTML = `
    <section class="hero">
      <h1 class="hero__title">Target Direction extraction</h1>
    </section>
    <section class="setup">
      <div class="section-label">Recording setup</div>
      <figure class="setup__figure">
        <img class="setup__img" src="./assets/record_device.jpeg" alt="XVF3800 4-mic array used to record the samples, with mic angles 45, 135, 225 and 315 degrees labeled on the device" />
        <figcaption class="setup__note">
          Samples were recorded with an <strong>XVF3800 4-mic array</strong>. Speaker and
          interferer sources were placed at known azimuths relative to the microphone
          positions labeled on the device (45&deg;, 135&deg;, 225&deg;, 315&deg;). Each
          gallery title encodes those ground-truth directions (e.g. &ldquo;45 And
          315&rdquo; means sources at 45&deg; and 315&deg;).
        </figcaption>
      </figure>
    </section>
    ${
      avsrSamples.length
        ? `
      <div class="section-label">AudioVisual-DOA Gallery</div>
      <div class="gallery-grid gallery-grid--single">
        ${avsrSamples.map(galleryCardHtml).join("")}
      </div>
    `
        : ""
    }
    <div class="section-label${avsrSamples.length ? " section-label--spaced" : ""}">Audio-DOA Gallery</div>
    <div class="gallery-grid">
      ${staticSamples.map(galleryCardHtml).join("")}
    </div>
  `;

  await Promise.all(samples.map((sample) => mountGalleryCard(sample)));
}

function galleryCardHtml(sample) {
  const isVideo = !!sample.video;
  // AVSR-DOA Gallery cards preview the recording itself (first video frame) instead of a
  // polar DOA chart; everyone else keeps the polar preview. The "#t=0.1" fragment makes the
  // browser decode/display that frame as a poster instead of leaving the <video> blank.
  const previewHtml = isVideo
    ? `<video class="gallery-card__preview-media" id="gallery-video-${escapeHtml(sample.id)}" src="${escapeHtml(sample.path)}/${escapeHtml(sample.video)}#t=0.1" muted playsinline preload="metadata"></video>`
    : `<canvas id="gallery-polar-${escapeHtml(sample.id)}"></canvas>`;
  return `
    <a class="gallery-card" href="#/sample/${encodeURIComponent(sample.id)}">
      <div class="gallery-card__preview${isVideo ? " gallery-card__preview--video" : ""}">
        ${previewHtml}
        ${loadingBoxHtml(`gallery-loading-${escapeHtml(sample.id)}`, "Loading\u2026")}
      </div>
      <div class="gallery-card__title">${escapeHtml(sample.title)}</div>
    </a>
  `;
}

async function mountGalleryCard(sample) {
  if (sample.video) {
    const videoEl = document.getElementById(`gallery-video-${sample.id}`);
    if (!videoEl) return;
    const reveal = () => hideLoadingBox(`gallery-loading-${sample.id}`);
    videoEl.addEventListener("loadeddata", reveal, { once: true });
    videoEl.addEventListener("error", reveal, { once: true });
    return;
  }

  const canvas = document.getElementById(`gallery-polar-${sample.id}`);
  if (!canvas) return;
  try {
    const doa = await fetch(`${sample.path}/${DOA_FILE}`).then((r) => r.json());
    const win = pickPreviewWindow(doa);
    const chart = createPolarChart(canvas, { showListenAllIcon: false });
    if (win) {
      const candidates = win.candidates || [];
      chart.render({
        spectrum: win.spectrum,
        azimuthDeg: win.azimuth_deg,
        peaks: candidates,
        thetas: sample.thetas || [],
        doaList: groundTruthOrCandidates(sample, candidates),
        selectedTheta: null,
      });
    }
    galleryCharts.push(chart);
  } catch {
    // leave blank canvas if DOA json is missing
  } finally {
    hideLoadingBox(`gallery-loading-${sample.id}`);
  }
}

async function renderDetail(id) {
  const samples = await getCatalog();
  const sample = samples.find((s) => s.id === id);
  if (!sample) {
    appEl.innerHTML = `<a class="detail__back" href="#/">&larr; Gallery</a><p class="error-state">Sample "${escapeHtml(id)}" not found.</p>`;
    return;
  }

  const videoSrc = sample.video ? `${sample.path}/${sample.video}` : null;

  appEl.innerHTML = `
    <a class="detail__back" href="#/">&larr; Gallery</a>
    <h2 class="detail__title">${escapeHtml(sample.title)}</h2>

    <div class="detail__grid">
      <div class="polar-wrap">
        <canvas id="polar-canvas"></canvas>
        <div class="doa-window-label" id="doa-window-label"></div>
        ${loadingBoxHtml("polar-loading", "Loading DOA data\u2026")}
      </div>
      <div class="controls-col">
        <div>
          <div class="section-label">Detected DOAs</div>
          <ul class="peaks-list" id="peaks-list"></ul>
        </div>
        <div>
          <div class="section-label">Listen at</div>
          <div class="theta-chips" id="theta-chips"></div>
        </div>
      </div>
    </div>

    <div class="section-label">Audio</div>
    <div class="player" id="player">
      <div class="player__body">
        <div class="player__toggle-row">
          <label class="toggle">
            <input type="checkbox" id="enhance-toggle" />
            <span class="toggle__track" aria-hidden="true"></span>
            <span class="toggle__label" id="enhance-label">Enhanced @ —</span>
          </label>
        </div>
        <div class="player__stage">
          <div class="player__media-col">
            ${
              videoSrc
                ? `
            <div class="player__video-wrap">
              <video class="player__video" id="lip-video" src="${escapeHtml(videoSrc)}" muted playsinline preload="auto"></video>
            </div>
            `
                : ""
            }
            <div class="player__mel-row">
              <button class="player__play" id="play-btn" aria-label="Play" disabled>&#9654;</button>
              <div class="player__mel" id="mel-seek" title="Click or drag to seek">
                <div class="player__mel-track" id="mel-track">
                  <img class="player__mel-img" id="mel-img" alt="Mel spectrogram" draggable="false" />
                </div>
                <div class="player__playhead" id="mel-playhead"></div>
                ${loadingBoxHtml("mel-loading", "Loading audio\u2026", "loading-box--dark")}
              </div>
            </div>
          </div>
        </div>
        <div class="player__footer-row">
          <div class="zoom-controls" id="zoom-controls">
            <button type="button" class="zoom-btn" id="zoom-out-btn" aria-label="Zoom out">&minus;</button>
            <input type="range" class="zoom-slider" id="zoom-slider" min="0" max="100" step="1" value="0" aria-label="Zoom level" />
            <button type="button" class="zoom-btn" id="zoom-in-btn" aria-label="Zoom in">+</button>
          </div>
          <div class="player__time" id="audio-time">0:00 / 0:00</div>
        </div>
      </div>
    </div>
  `;

  await setupDetail(sample);
}

async function setupDetail(sample) {
  const doaOverTime = await fetch(`${sample.path}/${DOA_FILE}`).then((r) => r.json());
  hideLoadingBox("polar-loading");
  const windows = doaOverTime.windows || [];

  const thetas = sample.thetas || [];
  // Mixture / "All directions" until Enhanced is turned on.
  let selectedTheta = null;
  let enhanced = false;
  let currentWindowIdx = -1;

  const peaksListEl = document.getElementById("peaks-list");
  const doaWindowLabelEl = document.getElementById("doa-window-label");

  function renderPeaksList(win) {
    const candidates = (win && win.candidates) || [];
    peaksListEl.innerHTML = candidates.length
      ? candidates
          .map((p) => `<li><span class="peak-theta">${Math.round(p.theta)}\u00b0</span><span>${p.score.toFixed(2)}</span></li>`)
          .join("")
      : "<li>No peaks detected</li>";
  }

  const chipsEl = document.getElementById("theta-chips");
  function renderChips() {
    const allActive = selectedTheta === null;
    const allChip = `<button class="chip${allActive ? " is-active" : ""}" data-theta="all">All directions</button>`;
    const thetaChips = thetas
      .map(
        (t) =>
          `<button class="chip${t === selectedTheta ? " is-active" : ""}" data-theta="${t}">${t}\u00b0</button>`
      )
      .join("");
    chipsEl.innerHTML = allChip + thetaChips;
    chipsEl.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        if (chip.dataset.theta === "all") selectAllDirections();
        else selectTheta(Number(chip.dataset.theta));
      });
    });
  }
  renderChips();

  const polarCanvas = document.getElementById("polar-canvas");
  const polarChart = createPolarChart(polarCanvas, {
    onSelect: (theta) => selectTheta(theta),
  });

  /** Redraw the polar + peaks list for a specific doa_over_time.json window. When the sample's
   * folder name encoded known ground-truth directions, those icons stay fixed across windows;
   * otherwise the window's candidate thetas double as `doaList`, so the animated sound.gif
   * icons track detected DOA peaks for the window currently under playback instead. */
  function renderPolarForWindow(win) {
    const candidates = (win && win.candidates) || [];
    polarChart.render({
      spectrum: win ? win.spectrum : [],
      azimuthDeg: win ? win.azimuth_deg : [],
      peaks: candidates,
      thetas,
      doaList: groundTruthOrCandidates(sample, candidates),
      selectedTheta,
      enhanced,
    });
    renderPeaksList(win);
    doaWindowLabelEl.textContent = win
      ? `DOA window ${formatTime(win.start_s)}\u2013${formatTime(win.end_s)}`
      : "";
  }

  function updateDoaForTime(t) {
    if (!windows.length) return;
    const idx = findWindowIndex(windows, t);
    if (idx !== currentWindowIdx) {
      currentWindowIdx = idx;
      renderPolarForWindow(windows[idx]);
    }
  }

  const playBtn = document.getElementById("play-btn");
  const enhanceToggle = document.getElementById("enhance-toggle");
  const enhanceLabel = document.getElementById("enhance-label");
  const melImg = document.getElementById("mel-img");
  const melTrack = document.getElementById("mel-track");
  const melSeek = document.getElementById("mel-seek");
  const melPlayhead = document.getElementById("mel-playhead");
  const timeEl = document.getElementById("audio-time");
  const videoEl = document.getElementById("lip-video");
  const zoomInBtn = document.getElementById("zoom-in-btn");
  const zoomOutBtn = document.getElementById("zoom-out-btn");
  const zoomSlider = document.getElementById("zoom-slider");

  const audio = new Audio();
  audio.preload = "auto";
  activeAudio = audio;
  activeVideo = videoEl || null;

  // The play button stays disabled until every initial resource -- audio metadata, the first
  // mel image, and video metadata if this sample has one -- has loaded, so the first click
  // always has something ready to actually play instead of silently buffering.
  let audioReady = false;
  let melReady = false;
  let videoReady = !videoEl;
  function maybeEnablePlayButton() {
    if (audioReady && melReady && videoReady) {
      playBtn.disabled = false;
    }
  }
  audio.addEventListener("loadedmetadata", () => {
    audioReady = true;
    maybeEnablePlayButton();
  }, { once: true });
  if (videoEl) {
    // The <video> tag's `src` starts loading as soon as renderDetail() injects the markup,
    // which is before this function even runs -- and the DOA fetch above yields control back
    // to the browser, so `loadedmetadata` can fire (e.g. a cached/fast video load) before we
    // get here to listen for it. Check readyState first so an already-loaded video doesn't
    // leave the play button disabled forever; also resolve on `error` so a broken video file
    // can't do the same.
    const markVideoReady = () => {
      videoReady = true;
      maybeEnablePlayButton();
    };
    if (videoEl.readyState >= 1 /* HAVE_METADATA */) {
      markVideoReady();
    } else {
      videoEl.addEventListener("loadedmetadata", markVideoReady, { once: true });
      videoEl.addEventListener("error", markVideoReady, { once: true });
    }
  }

  const mixtureWav = `${sample.path}/${MIXTURE_STEM}.wav`;

  function enhancedWav(theta) {
    return `${sample.path}/enhanced_theta${thetaTag(theta)}.wav`;
  }
  function enhancedPng(theta) {
    return `${sample.path}/enhanced_theta${thetaTag(theta)}.png`;
  }

  function currentWav() {
    return enhanced && selectedTheta !== null ? enhancedWav(selectedTheta) : mixtureWav;
  }

  function mixturePng() {
    return `${sample.path}/${MIXTURE_STEM}.png`;
  }

  function currentPng() {
    return enhanced && selectedTheta !== null ? enhancedPng(selectedTheta) : mixturePng();
  }

  function prefetchSampleAudio() {
    const urls = [mixtureWav, ...thetas.map((t) => enhancedWav(t))];
    urls.forEach((url) => {
      fetch(url).catch(() => {});
    });
  }

  function updateEnhanceLabel() {
    enhanceLabel.textContent =
      selectedTheta === null ? "Enhanced" : `Enhanced @ ${selectedTheta}\u00b0`;
  }

  function updatePlayIcon() {
    playBtn.innerHTML = audio.paused ? "&#9654;" : "&#10074;&#10074;";
    playBtn.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  }

  // Native on-screen width of the mel image at zoom 1x -- computed from the image's own
  // natural aspect ratio and the viewport's fixed CSS height, not measured off the (possibly
  // already-zoomed) <img> element, so it stays stable as zoomFactor changes. 0 means "no mel"
  // -- mixture mode.
  let melBaseWidth = 0;
  let zoomFactor = 1;
  const MAX_ZOOM = 8;

  function measureMel() {
    if (!melImg.naturalWidth || !melImg.naturalHeight) {
      melBaseWidth = 0;
      return;
    }
    const viewportHeight = melSeek.getBoundingClientRect().height;
    melBaseWidth = melImg.naturalWidth * (viewportHeight / melImg.naturalHeight);
  }

  // Zooming out beyond "the whole recording fits the viewport" would just add empty margin,
  // so the floor is whichever is smaller: 1x (native) or the fit-to-viewport ratio.
  function minZoomFactor() {
    if (!melBaseWidth || !audio.duration) return 0.05;
    const viewportWidth = melSeek.getBoundingClientRect().width;
    return Math.min(1, viewportWidth / melBaseWidth);
  }

  function clampZoom(z) {
    return Math.min(MAX_ZOOM, Math.max(minZoomFactor(), z));
  }

  function effectiveMelWidth() {
    return melBaseWidth * zoomFactor;
  }

  // The zoom slider is 0-100 mapped onto [minZoomFactor(), MAX_ZOOM] on a log scale (zooming
  // in/out changes perceived detail multiplicatively, so a linear slider would spend most of
  // its range on barely-perceptible differences at the high end).
  function zoomValueToFactor(v) {
    const min = minZoomFactor();
    if (MAX_ZOOM <= min) return min;
    const t = Math.min(1, Math.max(0, v / 100));
    return min * Math.pow(MAX_ZOOM / min, t);
  }

  function zoomFactorToValue(z) {
    const min = minZoomFactor();
    if (MAX_ZOOM <= min) return 0;
    const t = Math.log(z / min) / Math.log(MAX_ZOOM / min);
    return Math.round(Math.min(1, Math.max(0, t)) * 100);
  }

  function updateZoomControlsEnabled() {
    const disabled = !melBaseWidth;
    zoomInBtn.disabled = disabled;
    zoomOutBtn.disabled = disabled;
    zoomSlider.disabled = disabled;
  }

  // Current horizontal pan of .player__mel-track, in px (always <= 0). Kept in sync by
  // updateMelPosition() and read by computeSeekTime() so clicks map to the track position
  // that's actually on screen, regardless of how it got there.
  let melTranslateX = 0;

  /** Keep the mel track panned so the current playhead stays centered in the viewport
   * (DAW-style scrubbing) -- except near the very start/end of the recording, where
   * centering would leave empty space before 0:00 or after the end; there we clamp so the
   * mel always fills the viewport edge-to-edge, and slide the playhead marker itself toward
   * that edge instead (it's only centered when there's room to pan on both sides). No-op
   * (blank dark viewport, playhead centered) when there is no mel image. */
  function updateMelPosition() {
    const width = effectiveMelWidth();
    const viewportWidth = melSeek.getBoundingClientRect().width;
    if (!width) {
      melTranslateX = 0;
      melTrack.style.transform = "translateX(0px)";
      melPlayhead.style.left = "50%";
      return;
    }
    const dur = audio.duration;
    const ratio = dur && Number.isFinite(dur) ? audio.currentTime / dur : 0;
    const playheadX = ratio * width;
    const minTranslate = Math.min(0, viewportWidth - width);
    melTranslateX = Math.min(0, Math.max(minTranslate, viewportWidth / 2 - playheadX));
    melTrack.style.transform = `translateX(${melTranslateX}px)`;
    melPlayhead.style.left = `${playheadX + melTranslateX}px`;
  }

  /** Re-clamp and (re)apply the current zoom -- called after zoom button clicks, after a new
   * mel image loads, and on window resize (viewport size affects both melBaseWidth and the
   * zoom-out floor). */
  function applyZoom() {
    zoomFactor = clampZoom(zoomFactor);
    if (melBaseWidth) {
      melImg.style.width = `${effectiveMelWidth()}px`;
    }
    zoomSlider.value = String(zoomFactorToValue(zoomFactor));
    updateMelPosition();
  }

  function syncVideoTime(force = false) {
    if (!videoEl) return;
    const drift = Math.abs(videoEl.currentTime - audio.currentTime);
    if (force || drift > 0.05) {
      videoEl.currentTime = audio.currentTime;
    }
  }

  // The mel loading box only needs to appear for the very first image (subsequent theta
  // switches are quick enough that flashing it again would just be noise).
  let melLoadingHidden = false;
  function hideMelLoadingOnce() {
    if (melLoadingHidden) return;
    melLoadingHidden = true;
    hideLoadingBox("mel-loading");
    melReady = true;
    maybeEnablePlayButton();
  }

  // While true, ignore audio events that would paint a stale/reset (currentTime=0) state onto
  // the mel position during a src swap — position holds until onReady restores it.
  let restoringSource = false;

  function updateProgress() {
    if (restoringSource) return;
    const dur = audio.duration;
    const t = audio.currentTime;
    timeEl.textContent = `${formatTime(t)} / ${formatTime(dur || 0)}`;
    updateMelPosition();
    updateDoaForTime(t);
  }

  /**
   * Swap WAV (+ matching mel PNG, if any) while preserving the current timestamp.
   * If we were playing, resume after the new source is ready.
   */
  function applySource({ preserveTime = true, autoplay = null } = {}) {
    const wasPlaying = autoplay === null ? !audio.paused : autoplay;
    const t = preserveTime ? audio.currentTime || 0 : 0;
    const wav = currentWav();
    const png = currentPng();

    if (png) {
      melImg.onload = () => {
        measureMel();
        updateZoomControlsEnabled();
        applyZoom();
        hideMelLoadingOnce();
      };
      // Mixture mel PNGs aren't generated for every sample yet -- fall back to a blank
      // viewport instead of leaving a broken image / stale zoom state around.
      melImg.onerror = () => {
        melImg.onerror = null;
        melImg.removeAttribute("src");
        melImg.style.width = "";
        melBaseWidth = 0;
        updateZoomControlsEnabled();
        updateMelPosition();
        hideMelLoadingOnce();
      };
      melImg.src = png;
    } else {
      melImg.removeAttribute("src");
      melImg.style.width = "";
      melBaseWidth = 0;
      updateZoomControlsEnabled();
      updateMelPosition();
      hideMelLoadingOnce();
    }

    const onReady = () => {
      audio.removeEventListener("loadedmetadata", onReady);
      if (preserveTime && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(t, Math.max(0, audio.duration - 0.01));
      }
      syncVideoTime(true);
      restoringSource = false;
      updateProgress();
      if (wasPlaying) {
        audio.play().catch(() => {});
      }
      updatePlayIcon();
    };

    let same = false;
    try {
      same = new URL(audio.src, window.location.href).pathname.endsWith(`/${wav}`);
    } catch {
      same = false;
    }

    if (same && audio.readyState >= 1) {
      updateProgress();
      updatePlayIcon();
      return;
    }

    restoringSource = true;
    audio.addEventListener("loadedmetadata", onReady);
    audio.src = wav;
    audio.load();
  }

  function syncEnhanceUi() {
    enhanceToggle.checked = enhanced;
    updateEnhanceLabel();
    renderChips();
    polarChart.render({ selectedTheta, enhanced });
  }

  function selectAllDirections() {
    selectedTheta = null;
    enhanced = false;
    syncEnhanceUi();
    applySource({ preserveTime: true });
  }

  function selectTheta(theta) {
    selectedTheta = theta;
    // A specific listen angle implies Enhanced; turn it on if needed.
    if (!enhanced) {
      enhanced = true;
    }
    syncEnhanceUi();
    applySource({ preserveTime: true });
  }

  playBtn.addEventListener("click", () => {
    if (!audio.src) {
      applySource({ preserveTime: false, autoplay: true });
      return;
    }
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
    updatePlayIcon();
  });

  enhanceToggle.addEventListener("change", () => {
    enhanced = enhanceToggle.checked;
    if (!enhanced) {
      // Mixture mode: listen in all directions.
      selectedTheta = null;
    } else if (selectedTheta === null && thetas.length) {
      selectedTheta = thetas[0];
    }
    syncEnhanceUi();
    applySource({ preserveTime: true });
  });

  // Seeking maps a click/drag position directly against the track's current on-screen pan
  // (melTranslateX), so it stays correct whether or not the playhead happens to be centered
  // (e.g. clamped near the start/end of the recording).
  let seeking = false;

  function computeSeekTime(localX) {
    if (!audio.duration || !Number.isFinite(audio.duration)) return null;
    const width = effectiveMelWidth();
    if (width > 0) {
      const ratio = Math.min(1, Math.max(0, (localX - melTranslateX) / width));
      return ratio * audio.duration;
    }
    const viewportWidth = melSeek.getBoundingClientRect().width;
    const ratio = Math.min(1, Math.max(0, localX / viewportWidth));
    return ratio * audio.duration;
  }

  function seekFromEvent(evt) {
    const rect = melSeek.getBoundingClientRect();
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const localX = clientX - rect.left;
    const t = computeSeekTime(localX);
    if (t !== null) {
      audio.currentTime = t;
      updateProgress();
      syncVideoTime(true);
    }
  }

  melSeek.addEventListener("pointerdown", (evt) => {
    seeking = true;
    melSeek.setPointerCapture(evt.pointerId);
    seekFromEvent(evt);
  });
  melSeek.addEventListener("pointermove", (evt) => {
    if (seeking) seekFromEvent(evt);
  });
  melSeek.addEventListener("pointerup", () => {
    seeking = false;
  });
  melSeek.addEventListener("pointercancel", () => {
    seeking = false;
  });

  zoomInBtn.addEventListener("click", () => {
    zoomFactor = clampZoom(zoomFactor * 1.5);
    applyZoom();
  });
  zoomOutBtn.addEventListener("click", () => {
    zoomFactor = clampZoom(zoomFactor / 1.5);
    applyZoom();
  });
  zoomSlider.addEventListener("input", () => {
    zoomFactor = zoomValueToFactor(Number(zoomSlider.value));
    applyZoom();
  });

  audio.addEventListener("timeupdate", updateProgress);
  audio.addEventListener("play", () => {
    if (videoEl) videoEl.play().catch(() => {});
    updatePlayIcon();
  });
  audio.addEventListener("pause", () => {
    if (videoEl) videoEl.pause();
    updatePlayIcon();
  });
  audio.addEventListener("ended", () => {
    if (videoEl) videoEl.pause();
    updatePlayIcon();
  });
  audio.addEventListener("loadedmetadata", updateProgress);

  function handleResize() {
    measureMel();
    updateZoomControlsEnabled();
    applyZoom();
  }
  window.addEventListener("resize", handleResize);
  detailCleanup = () => {
    window.removeEventListener("resize", handleResize);
  };

  updateEnhanceLabel();
  enhanceToggle.checked = false;
  updateZoomControlsEnabled();
  applyZoom();
  prefetchSampleAudio();
  applySource({ preserveTime: false, autoplay: false });
  updatePlayIcon();
  updateDoaForTime(0);
}

window.addEventListener("hashchange", route);
route();
