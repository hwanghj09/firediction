const data = window.FIREDICTION_DATA;

const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  riskKey: "",
  selectedId: data?.regions?.[0]?.id || "",
  viewBox: null,
  defaultViewBox: null,
  isPanning: false,
  panStart: null,
  didPan: false,
  pendingViewBox: null,
  viewBoxFrame: 0,
  wheelFrame: 0,
  wheelDelta: 0,
  wheelPoint: null,
  detailLevel: "",
};

const els = {
  sourceInfo: document.querySelector("#sourceInfo"),
  monthSelect: document.querySelector("#monthSelect"),
  koreaMap: document.querySelector("#koreaMap"),
  mapRegions: document.querySelector("#mapRegions"),
  tooltip: document.querySelector("#tooltip"),
  legend: document.querySelector("#legend"),
};

const regionById = new Map();
const pathById = new Map();
const pathLodById = new Map();
const levelColors = new Map();

function formatNumber(value, digits = 0) {
  return Number(value).toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getRisk(region) {
  return region.risk[state.riskKey] || Object.values(region.risk)[0];
}

function colorFor(region) {
  return levelColors.get(getRisk(region).level) || "#9aa69a";
}

function simplifyPathData(pathData, stride) {
  if (stride <= 1) return pathData;

  const tokens = pathData.match(/[MLZ]|-?\d+(?:\.\d+)?/g) || [];
  let index = 0;
  const rings = [];

  while (index < tokens.length) {
    const token = tokens[index++];
    if (token !== "M") continue;

    const ring = [];
    ring.push([Number(tokens[index++]), Number(tokens[index++])]);
    while (index < tokens.length && tokens[index] !== "Z" && tokens[index] !== "M") {
      if (tokens[index] === "L") {
        index += 1;
      }
      ring.push([Number(tokens[index++]), Number(tokens[index++])]);
    }
    if (tokens[index] === "Z") {
      index += 1;
    }
    rings.push(ring);
  }

  return rings
    .map((ring) => {
      if (ring.length <= 8) {
        return serializeRing(ring);
      }

      const simplified = [ring[0]];
      for (let pointIndex = stride; pointIndex < ring.length - 1; pointIndex += stride) {
        simplified.push(ring[pointIndex]);
      }
      const last = ring[ring.length - 1];
      const previous = simplified[simplified.length - 1];
      if (previous[0] !== last[0] || previous[1] !== last[1]) {
        simplified.push(last);
      }
      return serializeRing(simplified);
    })
    .join("");
}

function serializeRing(points) {
  const [first, ...rest] = points;
  return `M${first[0]} ${first[1]}${rest.map(([x, y]) => `L${x} ${y}`).join("")}Z`;
}

function init() {
  if (!data || !Array.isArray(data.regions)) {
    document.body.innerHTML = "<main class='app-shell'><p>지도 데이터를 불러오지 못했습니다.</p></main>";
    return;
  }

  data.legend.forEach((item) => levelColors.set(item.level, item.color));
  data.regions.forEach((region) => regionById.set(region.id, region));
  state.riskKey = getAvailableMonths()[0]?.key || Object.keys(data.regions[0].risk)[0];

  renderSourceInfo();
  renderControls();
  renderLegend();
  renderMap();
  bindEvents();
  refresh();
}

function renderSourceInfo() {
  els.sourceInfo.textContent = `AI 정확도 ${formatPercent(data.model.accuracy)}`;
}

function renderControls() {
  els.monthSelect.innerHTML = getAvailableMonths()
    .map(({ key, month }) => `<option value="${key}">${month}월</option>`)
    .join("");
  els.monthSelect.value = state.riskKey;
}

function getAvailableMonths() {
  if (Array.isArray(data.source?.predictionMonths) && data.source.predictionMonths.length) {
    return data.source.predictionMonths.map((month) => ({
      key: `m${String(month).padStart(2, "0")}`,
      month,
    }));
  }

  return Object.entries(data.regions[0].risk)
    .map(([key, risk]) => ({ key, month: risk.month }))
    .filter((item) => Number.isFinite(item.month))
    .sort((a, b) => a.month - b.month);
}

function renderLegend() {
  els.legend.innerHTML = data.legend
    .map(
      (item) => `
        <li>
          <i style="background:${item.color}"></i>
          <span>${escapeHtml(item.level)} ${escapeHtml(item.range)}</span>
        </li>
      `,
    )
    .join("");
}

function renderMap() {
  state.defaultViewBox = {
    x: Number(data.viewBox[0]),
    y: Number(data.viewBox[1]),
    width: Number(data.viewBox[2]),
    height: Number(data.viewBox[3]),
  };
  state.viewBox = { ...state.defaultViewBox };
  applyViewBox();
  els.koreaMap.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const fragment = document.createDocumentFragment();

  data.regions.forEach((region) => {
    const path = document.createElementNS(SVG_NS, "path");
    const lod = {
      low: simplifyPathData(region.path, 9),
      medium: simplifyPathData(region.path, 4),
      high: region.path,
    };
    pathLodById.set(region.id, lod);
    path.setAttribute("d", lod.low);
    path.setAttribute("class", "region");
    path.setAttribute("tabindex", "0");
    path.setAttribute("role", "button");
    path.dataset.id = region.id;
    path.style.fill = colorFor(region);
    path.addEventListener("click", (event) => {
      if (state.didPan) {
        event.preventDefault();
        return;
      }
      selectRegion(region.id);
    });
    path.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRegion(region.id);
      }
    });
    path.addEventListener("pointerenter", (event) => showTooltip(event, region));
    path.addEventListener("pointermove", moveTooltip);
    path.addEventListener("pointerleave", hideTooltip);
    pathById.set(region.id, path);
    fragment.append(path);
  });

  els.mapRegions.replaceChildren(fragment);
  updateMapDetailLevel(true);
}

function bindEvents() {
  els.monthSelect.addEventListener("change", (event) => {
    state.riskKey = event.target.value;
    refresh();
  });

  els.koreaMap.addEventListener("pointerdown", startPan);
  els.koreaMap.addEventListener("pointermove", panMap);
  els.koreaMap.addEventListener("pointerup", endPan);
  els.koreaMap.addEventListener("pointercancel", endPan);
  els.koreaMap.addEventListener("pointerleave", endPan);
  els.koreaMap.addEventListener("wheel", zoomMap, { passive: false });
  els.koreaMap.addEventListener("dblclick", resetMapView);
}

function refresh() {
  updateMapStyles();
}

function updateMapStyles() {
  data.regions.forEach((region) => {
    const path = pathById.get(region.id);
    const risk = getRisk(region);
    path.style.fill = colorFor(region);
    path.classList.toggle("selected", region.id === state.selectedId);
    path.setAttribute(
      "aria-label",
      `${region.province} ${region.city} 산불 위험도 ${risk.score}점 ${risk.level}`,
    );
  });
}

function applyViewBox() {
  const box = state.viewBox;
  els.koreaMap.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  updateMapDetailLevel();
}

function currentViewBox() {
  return state.pendingViewBox || state.viewBox;
}

function scheduleViewBox(nextViewBox) {
  state.pendingViewBox = nextViewBox;
  if (state.viewBoxFrame) return;
  state.viewBoxFrame = window.requestAnimationFrame(() => {
    state.viewBoxFrame = 0;
    state.viewBox = state.pendingViewBox;
    state.pendingViewBox = null;
    applyViewBox();
  });
}

function pointInSvg(event) {
  const rect = els.koreaMap.getBoundingClientRect();
  const box = currentViewBox();
  return {
    x: box.x + ((event.clientX - rect.left) / rect.width) * box.width,
    y: box.y + ((event.clientY - rect.top) / rect.height) * box.height,
  };
}

function startPan(event) {
  if (event.button !== 0) return;
  els.koreaMap.setPointerCapture(event.pointerId);
  const point = pointInSvg(event);
  state.isPanning = true;
  state.didPan = false;
  state.panStart = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    x: point.x,
    y: point.y,
    viewBox: { ...state.viewBox },
  };
  els.koreaMap.classList.add("panning");
}

function panMap(event) {
  if (!state.isPanning || !state.panStart || state.panStart.pointerId !== event.pointerId) return;
  event.preventDefault();
  const rect = els.koreaMap.getBoundingClientRect();
  const dx = ((event.clientX - state.panStart.clientX) / rect.width) * state.panStart.viewBox.width;
  const dy = ((event.clientY - state.panStart.clientY) / rect.height) * state.panStart.viewBox.height;

  if (Math.hypot(event.clientX - state.panStart.clientX, event.clientY - state.panStart.clientY) > 4) {
    state.didPan = true;
    els.tooltip.hidden = true;
    els.tooltip.dataset.pinned = "false";
  }

  scheduleViewBox({
    ...state.panStart.viewBox,
    x: state.panStart.viewBox.x - dx,
    y: state.panStart.viewBox.y - dy,
  });
}

function endPan(event) {
  if (!state.isPanning) return;
  if (state.panStart?.pointerId === event.pointerId && els.koreaMap.hasPointerCapture(event.pointerId)) {
    els.koreaMap.releasePointerCapture(event.pointerId);
  }
  state.isPanning = false;
  state.panStart = null;
  els.koreaMap.classList.remove("panning");
  setTimeout(() => {
    state.didPan = false;
  }, 0);
}

function zoomMap(event) {
  event.preventDefault();
  state.wheelDelta += event.deltaY;
  state.wheelPoint = pointInSvg(event);
  if (state.wheelFrame) return;

  state.wheelFrame = window.requestAnimationFrame(() => {
    state.wheelFrame = 0;
    const cursor = state.wheelPoint;
    const delta = state.wheelDelta;
    state.wheelDelta = 0;
    state.wheelPoint = null;
    applyZoom(delta, cursor);
  });
}

function applyZoom(delta, cursor) {
  if (!cursor) return;
  const box = currentViewBox();
  const factor = Math.exp(Math.sign(delta) * Math.min(0.62, Math.abs(delta) / 210));
  const minWidth = state.defaultViewBox.width * 0.08;
  const maxWidth = state.defaultViewBox.width * 2.4;
  const nextWidth = Math.max(minWidth, Math.min(maxWidth, box.width * factor));
  const nextHeight = nextWidth * (state.defaultViewBox.height / state.defaultViewBox.width);
  const scaleX = (cursor.x - box.x) / box.width;
  const scaleY = (cursor.y - box.y) / box.height;

  scheduleViewBox({
    x: cursor.x - nextWidth * scaleX,
    y: cursor.y - nextHeight * scaleY,
    width: nextWidth,
    height: nextHeight,
  });
  if (els.tooltip.dataset.pinned === "true") {
    els.tooltip.hidden = true;
    els.tooltip.dataset.pinned = "false";
  }
}

function resetMapView() {
  if (state.viewBoxFrame) {
    window.cancelAnimationFrame(state.viewBoxFrame);
    state.viewBoxFrame = 0;
  }
  if (state.wheelFrame) {
    window.cancelAnimationFrame(state.wheelFrame);
    state.wheelFrame = 0;
  }
  state.pendingViewBox = null;
  state.wheelDelta = 0;
  state.wheelPoint = null;
  state.viewBox = { ...state.defaultViewBox };
  applyViewBox();
}

function getDetailLevel() {
  const zoom = state.defaultViewBox.width / currentViewBox().width;
  if (zoom < 1.45) return "low";
  if (zoom < 2.55) return "medium";
  return "high";
}

function updateMapDetailLevel(force = false) {
  if (!state.defaultViewBox || !state.viewBox) return;
  const nextLevel = getDetailLevel();
  if (!force && nextLevel === state.detailLevel) return;

  state.detailLevel = nextLevel;
  data.regions.forEach((region) => {
    const path = pathById.get(region.id);
    const lod = pathLodById.get(region.id);
    if (path && lod) {
      path.setAttribute("d", lod[nextLevel]);
    }
  });
}

function selectRegion(id) {
  if (!id || !regionById.has(id)) return;
  state.selectedId = id;
  updateMapStyles();
  showPinnedTooltip(regionById.get(id));
}

function renderTooltipContent(region) {
  const risk = getRisk(region);
  const color = colorFor(region);
  return `
    <div class="tooltip-head">
      <strong>${escapeHtml(region.city)}</strong>
      <span style="background:${color}">${escapeHtml(risk.level)}</span>
    </div>
    <p>${escapeHtml(region.province)} · ${risk.month}월 예측</p>
    <div class="tooltip-score">${formatNumber(risk.score, 1)}점</div>
    <div class="tooltip-track" aria-hidden="true">
      <i style="width:${risk.score}%; background:${color}"></i>
    </div>
  `;
}

function showTooltip(event, region) {
  if (state.isPanning || state.didPan) return;
  els.tooltip.innerHTML = renderTooltipContent(region);
  els.tooltip.dataset.pinned = "false";
  els.tooltip.hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  if (els.tooltip.hidden || state.isPanning) return;
  const pad = 14;
  const box = els.tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;

  if (x + box.width > window.innerWidth - 8) {
    x = event.clientX - box.width - pad;
  }
  if (y + box.height > window.innerHeight - 8) {
    y = event.clientY - box.height - pad;
  }

  els.tooltip.style.left = `${Math.max(8, x)}px`;
  els.tooltip.style.top = `${Math.max(8, y)}px`;
}

function hideTooltip() {
  if (els.tooltip.dataset.pinned === "true") return;
  els.tooltip.hidden = true;
}

function showPinnedTooltip(region) {
  els.tooltip.innerHTML = renderTooltipContent(region);
  els.tooltip.dataset.pinned = "true";
  els.tooltip.hidden = false;
  const rect = pathById.get(region.id).getBoundingClientRect();
  const syntheticEvent = {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  moveTooltip(syntheticEvent);
}

init();
