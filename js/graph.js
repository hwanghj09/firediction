const data = window.FIREDICTION_DATA;

const state = {
  selectedId: "",
};

const els = {
  regionSelect: document.querySelector("#regionSelect"),
  selectedSummary: document.querySelector("#selectedSummary"),
  chart: document.querySelector("#riskChart"),
};

const levelColors = new Map();
const regionById = new Map();

function formatNumber(value, digits = 1) {
  return Number(value).toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function init() {
  if (!data || !Array.isArray(data.regions)) {
    document.body.innerHTML = "<main class='graph-shell'><p>그래프 데이터를 불러오지 못했습니다.</p></main>";
    return;
  }

  data.legend.forEach((item) => levelColors.set(item.level, item.color));
  data.regions.forEach((region) => regionById.set(region.id, region));

  const params = new URLSearchParams(window.location.search);
  const requestedId = params.get("region");
  state.selectedId = regionById.has(requestedId) ? requestedId : data.regions[0].id;

  renderRegionSelect();
  bindEvents();
  render();
}

function renderRegionSelect() {
  const sorted = [...data.regions].sort((a, b) =>
    `${a.province} ${a.city}`.localeCompare(`${b.province} ${b.city}`, "ko"),
  );

  els.regionSelect.innerHTML = sorted
    .map(
      (region) =>
        `<option value="${region.id}">${escapeHtml(region.province)} ${escapeHtml(region.city)}</option>`,
    )
    .join("");
  els.regionSelect.value = state.selectedId;
}

function bindEvents() {
  els.regionSelect.addEventListener("change", (event) => {
    state.selectedId = event.target.value;
    window.history.replaceState(null, "", `graph.html?region=${encodeURIComponent(state.selectedId)}`);
    render();
  });
}

function getMonthlyScores(region) {
  const months = data.source.predictionMonths || [];
  return months.map((month) => {
    const key = `m${String(month).padStart(2, "0")}`;
    return {
      month,
      ...region.risk[key],
    };
  });
}

function render() {
  const region = regionById.get(state.selectedId);
  const points = getMonthlyScores(region);
  renderSummary(region, points);
  renderChart(points);
}

function renderSummary(region, points) {
  const max = points.reduce((best, point) => (point.score > best.score ? point : best), points[0]);
  const min = points.reduce((best, point) => (point.score < best.score ? point : best), points[0]);
  const average = points.reduce((sum, point) => sum + point.score, 0) / points.length;

  els.selectedSummary.innerHTML = `
    <span class="summary-chip">${escapeHtml(region.province)} ${escapeHtml(region.city)}</span>
    <span class="summary-chip">평균 ${formatNumber(average)}점</span>
    <span class="summary-chip">최고 ${max.month}월 ${formatNumber(max.score)}점</span>
    <span class="summary-chip">최저 ${min.month}월 ${formatNumber(min.score)}점</span>
  `;
}

function renderChart(points) {
  const width = 1000;
  const height = 560;
  const margin = { top: 52, right: 44, bottom: 68, left: 64 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const xFor = (index) => margin.left + (plotWidth / Math.max(1, points.length - 1)) * index;
  const yFor = (score) => margin.top + plotHeight - (score / 100) * plotHeight;
  const coords = points.map((point, index) => ({
    ...point,
    x: xFor(index),
    y: yFor(point.score),
  }));

  const linePath = coords.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join("");
  const areaPath = `${linePath}L${coords[coords.length - 1].x} ${height - margin.bottom}L${coords[0].x} ${
    height - margin.bottom
  }Z`;

  const grid = [0, 25, 50, 75, 100]
    .map((score) => {
      const y = yFor(score);
      return `
        <line class="grid-line" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" />
        <text class="chart-label" x="${margin.left - 14}" y="${y + 5}" text-anchor="end">${score}</text>
      `;
    })
    .join("");

  const dots = coords
    .map((point) => {
      const color = levelColors.get(point.level) || "#167a45";
      return `
        <circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="8" fill="${color}" />
        <text class="score-label" x="${point.x}" y="${point.y - 16}">${formatNumber(point.score)}</text>
        <text class="chart-label" x="${point.x}" y="${height - margin.bottom + 34}" text-anchor="middle">${point.month}월</text>
      `;
    })
    .join("");

  els.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  els.chart.innerHTML = `
    ${grid}
    <line class="axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${
      height - margin.bottom
    }" />
    <line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" />
    <path class="chart-area" d="${areaPath}" />
    <path class="chart-line" d="${linePath}" />
    ${dots}
  `;
}

init();
