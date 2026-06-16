const data = window.FIREDICTION_DATA;

const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  riskKey: "",
  selectedId: "",
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
  filterLevel: "all",
  searchHitId: "",
  monthAnimationTimer: 0,
};

const els = {
  sourceInfo: document.querySelector("#sourceInfo"),
  monthSelect: document.querySelector("#monthSelect"),
  riskFilter: document.querySelector("#riskFilter"),
  regionSearch: document.querySelector("#regionSearch"),
  regionSearchButton: document.querySelector("#regionSearchButton"),
  regionSuggestions: document.querySelector("#regionSuggestions"),
  resetViewButton: document.querySelector("#resetViewButton"),
  graphLink: document.querySelector("#graphLink"),
  koreaMap: document.querySelector("#koreaMap"),
  mapRegions: document.querySelector("#mapRegions"),
  detailPanel: document.querySelector("#detailPanel"),
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

function getRegionRisks(region) {
  return getAvailableMonths()
    .map(({ key, month }) => ({ key, month, risk: region.risk[key] }))
    .filter((item) => item.risk);
}

function colorFor(region) {
  return levelColors.get(getRisk(region).level) || "#9aa69a";
}

function regionLabel(region) {
  return `${region.province} ${region.city}`;
}

function normalizeSearch(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function isRegionVisibleByFilter(region) {
  return state.filterLevel === "all" || getRisk(region).level === state.filterLevel;
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
  els.riskFilter.value = state.filterLevel;
  els.regionSuggestions.innerHTML = data.regions
    .map((region) => `<option value="${escapeHtml(regionLabel(region))}"></option>`)
    .join("");
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
    path.style.setProperty("--month-delay", `${monthAnimationDelay(region)}ms`);
    path.style.fill = colorFor(region);
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
    changeMonth(event.target.value);
  });

  els.riskFilter.addEventListener("change", (event) => {
    state.filterLevel = event.target.value;
    refresh();
  });

  els.regionSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchRegion();
    }
  });
  els.regionSearchButton.addEventListener("click", searchRegion);

  els.koreaMap.addEventListener("pointerdown", startPan);
  els.koreaMap.addEventListener("pointermove", panMap);
  els.koreaMap.addEventListener("pointerup", endPan);
  els.koreaMap.addEventListener("pointercancel", endPan);
  els.koreaMap.addEventListener("pointerleave", endPan);
  els.koreaMap.addEventListener("wheel", zoomMap, { passive: false });
  els.koreaMap.addEventListener("dblclick", resetMapView);
  els.resetViewButton.addEventListener("click", resetMapView);
}

function refresh() {
  updateMapStyles();
  updateGraphLink();
  renderDetailPanel();
  updatePinnedTooltip();
}

function changeMonth(nextRiskKey) {
  if (nextRiskKey === state.riskKey) return;
  if (state.monthAnimationTimer) {
    window.clearTimeout(state.monthAnimationTimer);
  }

  els.koreaMap.classList.add("month-changing");
  state.riskKey = nextRiskKey;
  refresh();
  state.monthAnimationTimer = window.setTimeout(() => {
    els.koreaMap.classList.remove("month-changing");
    state.monthAnimationTimer = 0;
  }, 920);
}

function updateMapStyles() {
  data.regions.forEach((region) => {
    const path = pathById.get(region.id);
    const risk = getRisk(region);
    path.style.fill = colorFor(region);
    path.classList.toggle("selected", region.id === state.selectedId);
    path.classList.toggle("search-hit", region.id === state.searchHitId);
    path.classList.toggle("filtered-out", !isRegionVisibleByFilter(region));
    path.setAttribute(
      "aria-label",
      `${region.province} ${region.city} 산불 위험도 ${risk.score}점 ${risk.level}`,
    );
  });
}

function renderDetailPanel() {
  const region = regionById.get(state.selectedId);
  if (!region) {
    els.detailPanel.innerHTML = `
      <p class="detail-empty">지도를 클릭하면 선택 지역 상세 정보가 표시됩니다.</p>
    `;
    return;
  }

  const risk = getRisk(region);
  const weather = risk.weather || {};
  const color = colorFor(region);
  const yearlyCounts = Object.entries(region.yearlyFireCounts || {});
  const latestYear = yearlyCounts[yearlyCounts.length - 1];
  const latestYearText = latestYear ? `${latestYear[0]}년 ${formatNumber(latestYear[1])}건` : "자료 없음";

  els.detailPanel.innerHTML = `
    <div class="detail-head">
      <div>
        <p class="detail-kicker">선택 지역 상세</p>
        <h2>${escapeHtml(region.city)}</h2>
        <p>${escapeHtml(region.province)} · ${risk.month}월 예측</p>
      </div>
      <span class="detail-level" style="background:${color}">${escapeHtml(risk.level)}</span>
    </div>

    <div class="detail-score-row">
      <strong>${formatNumber(risk.score, 1)}점</strong>
      <span>위험도</span>
    </div>
    <div class="detail-track" aria-hidden="true">
      <i style="width:${risk.score}%; background:${color}"></i>
    </div>

    <div class="detail-chart">
      <div class="detail-section-title">
        <strong>월별 변화</strong>
        <span>6월~12월</span>
      </div>
      ${renderMiniLineChart(region)}
    </div>

    <div class="detail-grid" aria-label="선택 지역 기상 요약">
      <div>
        <span>기온</span>
        <strong>${formatNumber(weather.airTemperature, 1)}°C</strong>
      </div>
      <div>
        <span>습도</span>
        <strong>${formatNumber(weather.humidity, 1)}%</strong>
      </div>
      <div>
        <span>강수량</span>
        <strong>${formatNumber(weather.rainfall, 1)}mm</strong>
      </div>
    </div>

    <div class="detail-history">
      <div class="detail-section-title">
        <strong>산불 이력 요약</strong>
      </div>
      <dl>
        <div>
          <dt>발생 이력</dt>
          <dd>${formatNumber(region.fireCount)}건</dd>
        </div>
        <div>
          <dt>피해면적 합계</dt>
          <dd>${formatNumber(region.fireArea, 2)}ha</dd>
        </div>
        <div>
          <dt>집중 월</dt>
          <dd>${region.peakMonth ? `${region.peakMonth}월` : "자료 없음"}</dd>
        </div>
        <div>
          <dt>최근 연도</dt>
          <dd>${escapeHtml(latestYearText)}</dd>
        </div>
      </dl>
    </div>
  `;
}

function renderMiniLineChart(region) {
  const items = getRegionRisks(region);
  if (!items.length) return "<p class='detail-empty'>월별 위험도 자료가 없습니다.</p>";

  const width = 260;
  const height = 90;
  const pad = 12;
  const maxScore = Math.max(100, ...items.map((item) => item.risk.score));
  const step = items.length > 1 ? (width - pad * 2) / (items.length - 1) : 0;
  const points = items.map((item, index) => {
    const x = pad + step * index;
    const y = height - pad - (item.risk.score / maxScore) * (height - pad * 2);
    return { ...item, x, y };
  });
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");

  return `
    <svg class="detail-mini-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="선택 지역 월별 위험도 변화">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" />
      <polyline points="${polyline}" />
      ${points
        .map(
          (point) => `
            <g class="${point.key === state.riskKey ? "active" : ""}">
              <circle cx="${point.x}" cy="${point.y}" r="${point.key === state.riskKey ? 4.2 : 3}" />
              <text x="${point.x}" y="${height - 1}">${point.month}</text>
            </g>
          `,
        )
        .join("")}
    </svg>
  `;
}

function monthAnimationDelay(region) {
  if (!state.defaultViewBox) return 0;
  const xRatio = region.centroid[0] / Math.max(1, state.defaultViewBox.width);
  const yRatio = region.centroid[1] / Math.max(1, state.defaultViewBox.height);
  return Math.round(yRatio * 170 + xRatio * 90);
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
  const regionPath = event.target.closest?.(".region");
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
    regionId: regionPath?.dataset.id || "",
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
  const selectedId = event.type === "pointerup" && !state.didPan ? state.panStart?.regionId : "";
  if (state.panStart?.pointerId === event.pointerId && els.koreaMap.hasPointerCapture(event.pointerId)) {
    els.koreaMap.releasePointerCapture(event.pointerId);
  }
  state.isPanning = false;
  state.panStart = null;
  els.koreaMap.classList.remove("panning");
  if (selectedId) {
    selectRegion(selectedId);
  }
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

function focusRegion(region) {
  if (!region?.centroid || !state.defaultViewBox) return;
  const zoomWidth = state.defaultViewBox.width * 0.28;
  const zoomHeight = zoomWidth * (state.defaultViewBox.height / state.defaultViewBox.width);
  scheduleViewBox({
    x: region.centroid[0] - zoomWidth / 2,
    y: region.centroid[1] - zoomHeight / 2,
    width: zoomWidth,
    height: zoomHeight,
  });
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
  updateGraphLink();
  renderDetailPanel();
  showPinnedTooltip(regionById.get(id));
}

function findRegion(query) {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return null;

  return (
    data.regions.find((region) => normalizeSearch(regionLabel(region)) === normalizedQuery) ||
    data.regions.find((region) => normalizeSearch(region.city) === normalizedQuery) ||
    data.regions.find((region) => normalizeSearch(regionLabel(region)).includes(normalizedQuery)) ||
    data.regions.find((region) => normalizeSearch(region.province).includes(normalizedQuery))
  );
}

function searchRegion() {
  const region = findRegion(els.regionSearch.value);
  if (!region) {
    els.regionSearch.setAttribute("aria-invalid", "true");
    els.regionSearch.focus();
    return;
  }

  els.regionSearch.removeAttribute("aria-invalid");
  els.regionSearch.value = regionLabel(region);
  state.searchHitId = region.id;
  if (!isRegionVisibleByFilter(region)) {
    state.filterLevel = "all";
    els.riskFilter.value = "all";
  }
  selectRegion(region.id);
  focusRegion(region);
}

function updateGraphLink() {
  els.graphLink.href = state.selectedId ? `graph.html?region=${encodeURIComponent(state.selectedId)}` : "graph.html";
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

function updatePinnedTooltip() {
  if (els.tooltip.dataset.pinned !== "true") return;
  const region = regionById.get(state.selectedId);
  if (region) {
    showPinnedTooltip(region);
  }
}

init();
