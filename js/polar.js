// Canvas polar spectrum plot: matches doa/visualization.py convention
// (0 deg at East, counterclockwise) so on-screen angles line up with the
// PNGs produced by demo_infer.py.

const TWO_PI = Math.PI * 2;

function toXY(cx, cy, radius, thetaDeg) {
  const rad = (thetaDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy - radius * Math.sin(rad),
  };
}

function toThetaDeg(cx, cy, x, y) {
  const dx = x - cx;
  const dy = cy - y; // flip canvas-y back to math convention (up = positive)
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

function angularDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}

/** Intersection of the DOA ray with the canvas rectangle, inset so an icon fits. */
function rectBorderPoint(cx, cy, w, h, thetaDeg, inset) {
  const rad = (thetaDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad); // canvas Y
  const left = inset;
  const right = w - inset;
  const top = inset;
  const bottom = h - inset;
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (right - cx) / dx);
  else if (dx < -1e-9) t = Math.min(t, (left - cx) / dx);
  if (dy > 1e-9) t = Math.min(t, (bottom - cy) / dy);
  else if (dy < -1e-9) t = Math.min(t, (top - cy) / dy);
  if (!Number.isFinite(t) || t < 0) t = 0;
  return { x: cx + t * dx, y: cy + t * dy };
}

function nearestTheta(deg, thetas, toleranceDeg) {
  let best = null;
  let bestDiff = Infinity;
  for (const t of thetas) {
    const diff = Math.abs(angularDiff(deg, t));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }
  return bestDiff <= toleranceDeg ? best : null;
}

// Canvas drawImage() only ever samples a static frame of a GIF, so animated
// icons are real <img> elements overlaid on top of the canvas instead — the
// browser animates those natively. We wrap the canvas in a positioned
// container so the icons can be placed with CSS transforms that track the
// canvas's on-screen size exactly.
const SOUND_ICON_SRC = new URL("../assets/sound.gif", import.meta.url).href;
const EAR_ICON_SRC = new URL("../assets/listening.png", import.meta.url).href;
const LISTEN_ALL_ICON_SRC = new URL("../assets/listen_all.png", import.meta.url).href;

function makeOverlayImg(className, src, alt) {
  const img = document.createElement("img");
  img.className = className;
  img.src = src;
  img.alt = alt;
  img.decoding = "async";
  img.style.position = "absolute";
  img.style.left = "0";
  img.style.top = "0";
  img.style.pointerEvents = "none";
  img.style.userSelect = "none";
  img.style.display = "none";
  return img;
}

function ensureOverlay(canvas) {
  const parent = canvas.parentElement;
  if (parent && parent.classList.contains("polar-overlay-wrap")) {
    return {
      iconLayer: parent.querySelector(".polar-icon-layer"),
      earIcon: parent.querySelector(".polar-ear-icon"),
      listenAllIcon: parent.querySelector(".polar-listen-all-icon"),
    };
  }
  const wrap = document.createElement("div");
  wrap.className = "polar-overlay-wrap";
  wrap.style.position = "relative";
  wrap.style.display = "block";
  wrap.style.width = "100%";
  wrap.style.height = "100%";
  parent.insertBefore(wrap, canvas);
  wrap.appendChild(canvas);

  const iconLayer = document.createElement("div");
  iconLayer.className = "polar-icon-layer";
  iconLayer.style.position = "absolute";
  iconLayer.style.inset = "0";
  iconLayer.style.pointerEvents = "none";
  wrap.appendChild(iconLayer);

  // Center icons: omnidirectional listen vs steered enhanced ear.
  const listenAllIcon = makeOverlayImg(
    "polar-listen-all-icon",
    LISTEN_ALL_ICON_SRC,
    "Listening in all directions"
  );
  const earIcon = makeOverlayImg("polar-ear-icon", EAR_ICON_SRC, "Enhanced listening direction");
  wrap.appendChild(listenAllIcon);
  wrap.appendChild(earIcon);

  return { iconLayer, earIcon, listenAllIcon };
}

export function createPolarChart(
  canvas,
  { onSelect, hitToleranceDeg = 8, showListenAllIcon = true } = {}
) {
  const ctx = canvas.getContext("2d");
  const { iconLayer, earIcon, listenAllIcon } = ensureOverlay(canvas);
  let state = null;
  let iconEls = []; // one <img> per doaList entry, kept in sync via ensureIconElements

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(1, Math.round(rect.width * dpr));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
  }

  function labelCoveredByIcon(deg, doaList) {
    return doaList.some((t) => Math.abs(angularDiff(deg, t)) < 12);
  }

  // Rebuild the <img> pool only when the set of ground-truth angles changes,
  // so resizing/redrawing never restarts the GIF's animation.
  function ensureIconElements(doaList) {
    const key = doaList.join(",");
    if (iconLayer.dataset.key === key) return;
    iconLayer.dataset.key = key;
    iconLayer.innerHTML = "";
    iconEls = doaList.map((theta) => {
      const img = document.createElement("img");
      img.src = SOUND_ICON_SRC;
      img.alt = `Source at ${theta}\u00b0`;
      img.decoding = "async";
      img.style.position = "absolute";
      img.style.left = "0";
      img.style.top = "0";
      img.style.pointerEvents = "none";
      img.style.userSelect = "none";
      iconLayer.appendChild(img);
      return { theta, img };
    });
  }

  // Position/rotate the live speaker icons on the canvas's rectangular border,
  // cone pointing inward toward the center. sound.gif faces +X (0°) by default;
  // inward at theta is theta+180, so the CSS rotation is -(theta+180).
  function positionIcons(doaList) {
    ensureIconElements(doaList);
    if (!iconEls.length) return;
    const rect = canvas.getBoundingClientRect();
    const cw = rect.width || canvas.width;
    const ch = rect.height || canvas.height;
    const cx = cw / 2;
    const cy = ch / 2;
    const iconSize = Math.max(36, Math.round(cw * 0.13));
    const soundSize = Math.max(30, Math.round(iconSize * 0.85));
    const inset = soundSize / 2 + Math.max(2, cw * 0.004);
    iconEls.forEach(({ theta, img }) => {
      const pos = rectBorderPoint(cx, cy, cw, ch, theta, inset);
      img.style.width = `${soundSize}px`;
      img.style.height = `${soundSize}px`;
      img.style.transform = `translate(${pos.x - soundSize / 2}px, ${pos.y - soundSize / 2}px) rotate(${-(theta + 180)}deg)`;
    });
  }

  function placeCenterIcon(img, sizePx, rotateDeg = 0) {
    const rect = canvas.getBoundingClientRect();
    const cw = rect.width || canvas.width;
    const ch = rect.height || canvas.height;
    const cx = cw / 2;
    const cy = ch / 2;
    img.style.display = "block";
    img.style.width = `${sizePx}px`;
    img.style.height = `${sizePx}px`;
    img.style.transform = `translate(${cx - sizePx / 2}px, ${cy - sizePx / 2}px) rotate(${rotateDeg}deg)`;
  }

  // Center icon: listen_all when mixture / All directions; steered ear when Enhanced.
  // ear.gif faces +X (0°) by default, same outward convention as sound.gif.
  function positionCenterIcons(enhanced, selectedTheta) {
    const rect = canvas.getBoundingClientRect();
    const cw = rect.width || canvas.width;
    // Keep the center icon inside the innermost P=0.2 ring.
    const size = Math.max(28, Math.round(cw * 0.09));
    if (enhanced && selectedTheta !== null) {
      listenAllIcon.style.display = "none";
      placeCenterIcon(earIcon, size, -selectedTheta);
    } else {
      earIcon.style.display = "none";
      if (showListenAllIcon) placeCenterIcon(listenAllIcon, size);
      else listenAllIcon.style.display = "none";
    }
  }

  function draw() {
    if (!state) return;
    const {
      spectrum,
      azimuthDeg,
      peaks = [],
      thetas = [],
      doaList = [],
      selectedTheta = null,
      enhanced = false,
    } = state;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    // Reserve rim for degree labels so nothing is clipped near the edge.
    const iconSize = Math.max(36, Math.round(w * 0.13));
    const labelSize = Math.max(10, Math.round(w * 0.026));
    const rim = iconSize * 0.65 + labelSize * 0.9 + Math.max(8, w * 0.016);
    const maxR = Math.max(8, Math.min(w, h) / 2 - rim);

    ctx.clearRect(0, 0, w, h);

    // Radial probability rings (P(θ) ∈ [0, 1]), matching the matplotlib DOA plot.
    const radialTicks = [0.2, 0.4, 0.6, 0.8, 1.0];
    const angleTicks = w < 280 ? [0, 90, 180, 270] : [0, 45, 90, 135, 180, 225, 270, 315];

    radialTicks.forEach((frac) => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * frac, 0, TWO_PI);
      ctx.strokeStyle = frac === 1 ? "rgba(23,24,28,0.28)" : "rgba(23,24,28,0.12)";
      ctx.lineWidth = Math.max(1, w * 0.002);
      ctx.stroke();
    });

    // Radial spokes
    angleTicks.forEach((deg) => {
      const outer = toXY(cx, cy, maxR, deg);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(outer.x, outer.y);
      ctx.strokeStyle = "rgba(23,24,28,0.10)";
      ctx.lineWidth = Math.max(1, w * 0.0018);
      ctx.stroke();
    });

    // Angle labels (skip ticks under ground-truth speaker icons)
    ctx.fillStyle = "rgba(23,24,28,0.55)";
    ctx.font = `${labelSize}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    angleTicks.forEach((deg) => {
      const tickInner = toXY(cx, cy, maxR, deg);
      const tickOuter = toXY(cx, cy, maxR + Math.max(3, w * 0.008), deg);
      ctx.strokeStyle = "rgba(23,24,28,0.22)";
      ctx.beginPath();
      ctx.moveTo(tickInner.x, tickInner.y);
      ctx.lineTo(tickOuter.x, tickOuter.y);
      ctx.stroke();
      if (labelCoveredByIcon(deg, doaList)) return;
      const label = toXY(cx, cy, maxR + labelSize * 0.9, deg);
      ctx.fillText(`${deg}\u00b0`, label.x, label.y);
    });

    // P(θ) probability labels along a quiet radial (between 0° and 45°)
    const radialLabelAngle = 22;
    const radialFont = Math.max(9, Math.round(labelSize * 0.85));
    ctx.font = `${radialFont}px "JetBrains Mono", monospace`;
    ctx.fillStyle = "rgba(23,24,28,0.45)";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    radialTicks.forEach((frac) => {
      const p = toXY(cx, cy, maxR * frac, radialLabelAngle);
      ctx.fillText(frac.toFixed(1), p.x + 3, p.y);
    });

    if (spectrum && azimuthDeg && spectrum.length) {
      ctx.beginPath();
      for (let i = 0; i < azimuthDeg.length; i++) {
        const r = maxR * Math.max(0, Math.min(1, spectrum[i]));
        const p = toXY(cx, cy, r, azimuthDeg[i]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.strokeStyle = "#1f5fa8";
      ctx.lineWidth = Math.max(1.5, w * 0.0038);
      ctx.stroke();
    }

    thetas.forEach((theta) => {
      const isSelected = selectedTheta !== null && Math.abs(angularDiff(theta, selectedTheta)) < 0.01;
      const p = toXY(cx, cy, maxR, theta);
      // Green listen-at ray only when Enhanced is on for the selected direction.
      if (enhanced && isSelected) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = "#1f8a4c";
        ctx.lineWidth = Math.max(2, w * 0.0055);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, isSelected ? Math.max(3.5, w * 0.01) : Math.max(2.5, w * 0.007), 0, TWO_PI);
      ctx.fillStyle = isSelected ? "#1f8a4c" : "rgba(23,24,28,0.32)";
      ctx.fill();
    });

    peaks.forEach((peak) => {
      const r = maxR * Math.max(0, Math.min(1, peak.score));
      const p = toXY(cx, cy, r, peak.theta);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, w * 0.009), 0, TWO_PI);
      ctx.fillStyle = "#c23b3b";
      ctx.fill();
    });

    // origin marker
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1.5, w * 0.004), 0, TWO_PI);
    ctx.fillStyle = "rgba(23,24,28,0.4)";
    ctx.fill();

    positionIcons(doaList);
    positionCenterIcons(enhanced, selectedTheta);
  }

  function render(data) {
    state = { ...state, ...data };
    resize();
    draw();
  }

  function pointerTheta(evt) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const point = evt.touches && evt.touches.length ? evt.touches[0] : evt;
    const x = (point.clientX - rect.left) * dpr;
    const y = (point.clientY - rect.top) * dpr;
    return toThetaDeg(canvas.width / 2, canvas.height / 2, x, y);
  }

  function handlePointer(evt) {
    if (!state || !state.thetas || !state.thetas.length) return;
    const deg = pointerTheta(evt);
    const match = nearestTheta(deg, state.thetas, hitToleranceDeg);
    if (match !== null && onSelect) {
      onSelect(match);
    }
  }

  canvas.addEventListener("click", handlePointer);
  canvas.addEventListener(
    "touchstart",
    (evt) => {
      handlePointer(evt);
    },
    { passive: true }
  );

  const resizeObserver = new ResizeObserver(() => {
    resize();
    draw();
  });
  resizeObserver.observe(canvas);

  return {
    render,
    destroy() {
      resizeObserver.disconnect();
      canvas.removeEventListener("click", handlePointer);
    },
  };
}
