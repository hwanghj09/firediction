#!/usr/bin/env python3
"""Build the static dataset used by the Firediction web app.

The script intentionally uses only the Python standard library. It reads:
- Korea Forest Service wildfire history CSV
- drought status/forecast shapefiles exported from drought.go.kr

It then trains a small one-hidden-layer neural network from scratch and writes
web-ready JSON/JS data for the browser map.
"""

from __future__ import annotations

import csv
import datetime as dt
import json
import math
import random
import re
import statistics
import struct
import time
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
FIRE_CSV = next(ROOT.glob("산림청_산불통계데이터_*.csv"))
STATUS_ZIP = ROOT / "______20260614.zip"
MONTH_ZIP = ROOT / "______202605.zip"
DATA_DIR = ROOT / "data"
OUT_JSON = DATA_DIR / "risk-data.json"
OUT_JS = DATA_DIR / "risk-data.js"
API_MD = ROOT / "api.md"

RANDOM_SEED = 20260615
SIMPLIFY_TOLERANCE_METERS = 850
KMA_BASELINE_YEAR = 2025
KMA_API_SPECS = {
    "airTemperature": {
        "endpoint": "sts_ta.php",
        "fields": ["TA_MAVG", "TMX_MAVG", "TMN_MAVG", "TMX"],
    },
    "surfaceTemperature": {
        "endpoint": "sts_ts.php",
        "fields": ["TS_MAVG", "TS_MAX", "TS_MIN"],
    },
    "grassTemperature": {
        "endpoint": "sts_tg.php",
        "fields": ["TG_MIN"],
    },
    "soilTemperature": {
        "endpoint": "sts_te.php",
        "fields": [
            "TE005_MAVG",
            "TE010_MAVG",
            "TE020_MAVG",
            "TE030_MAVG",
            "TE050_MAVG",
            "TE100_MAVG",
            "TE150_MAVG",
            "TE300_MAVG",
        ],
    },
    "humidity": {
        "endpoint": "sts_rhm.php",
        "fields": ["RHM_MAVG", "RHM_MIN"],
    },
    "rainfall": {
        "endpoint": "sts_rn.php",
        "fields": ["RN_MSUM", "RN_MAX_1HR", "RN_MAX_6HR", "RN_MAX_10M"],
    },
}

SHORT_TO_FULL_SIDO = {
    "서울": "서울특별시",
    "부산": "부산광역시",
    "대구": "대구광역시",
    "인천": "인천광역시",
    "광주": "광주광역시",
    "대전": "대전광역시",
    "울산": "울산광역시",
    "세종": "세종특별자치시",
    "경기": "경기도",
    "강원": "강원도",
    "충북": "충청북도",
    "충남": "충청남도",
    "전북": "전라북도",
    "전남": "전라남도",
    "경북": "경상북도",
    "경남": "경상남도",
    "제주": "제주특별자치도",
}

DROUGHT_SCORE = {
    "정상": 0,
    "관심": 1,
    "주의": 2,
    "경계": 3,
    "심각": 4,
}

LEVELS = (
    (75, "매우 위험"),
    (50, "위험"),
    (25, "경고"),
    (0, "안전"),
)


def norm_sido(value: str | None) -> str:
    text = re.sub(r"\s+", "", value or "")
    return SHORT_TO_FULL_SIDO.get(text, text)


def city_base(value: str | None) -> str:
    text = re.sub(r"\s+", "", value or "")
    for suffix in ("특별자치시", "특별자치도", "자치구", "출장소", "시", "군", "구"):
        if text.endswith(suffix) and len(text) > len(suffix) + 1:
            return text[: -len(suffix)]
    return text


def parse_float(value: str | None) -> float:
    if not value:
        return 0.0
    value = value.replace(",", "").strip()
    if value in {"=", "-"}:
        return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def extract_kma_api_urls() -> dict[str, str]:
    text = API_MD.read_text(encoding="utf-8")
    urls: dict[str, str] = {}
    for match in re.finditer(r"https://apihub\.kma\.go\.kr/api/typ01/url/([a-z0-9_]+\.php)\?[^\s]+", text):
        endpoint = match.group(1)
        urls[endpoint] = match.group(0)

    missing = [spec["endpoint"] for spec in KMA_API_SPECS.values() if spec["endpoint"] not in urls]
    if missing:
        raise ValueError(f"Missing KMA API URLs in api.md: {', '.join(missing)}")
    return urls


def kma_url_for_month(template_url: str, yyyymm: str) -> str:
    parts = urlparse(template_url)
    query = parse_qs(parts.query)
    query["tm1"] = [yyyymm]
    query["tm2"] = [yyyymm]
    query["stn_id"] = ["0"]
    query["help"] = ["0"]
    query["disp"] = ["0"]
    return urlunparse(parts._replace(query=urlencode(query, doseq=True)))


def fetch_kma_text(template_url: str, endpoint: str, yyyymm: str) -> str:
    cache_dir = DATA_DIR / "kma-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{endpoint.replace('.php', '')}-{yyyymm}.csv"
    if cache_path.exists():
        return cache_path.read_text(encoding="utf-8")

    url = kma_url_for_month(template_url, yyyymm)
    request = Request(url, headers={"User-Agent": "firediction-builder/1.0"})
    with urlopen(request, timeout=30) as response:
        text = response.read().decode("utf-8", errors="replace")
    cache_path.write_text(text, encoding="utf-8")
    time.sleep(0.12)
    return text


def parse_kma_table(text: str) -> tuple[list[str], list[dict[str, str]]]:
    header: list[str] = []
    rows: list[dict[str, str]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            tokens = line.lstrip("#").replace("=", "").split()
            if tokens and tokens[0] in {"TM", "YEAR", "YM", "YMD"}:
                header = tokens
            continue
        if not header:
            continue

        values = [value.strip() for value in line.split(",")]
        if values and values[-1] == "=":
            values = values[:-1]
        if len(values) < len(header):
            continue
        rows.append(dict(zip(header, values)))
    return header, rows


def average_kma_fields(rows: list[dict[str, str]], fields: list[str]) -> dict[str, float]:
    averaged: dict[str, float] = {}
    for field in fields:
        values = [parse_float(row.get(field)) for row in rows if row.get(field) not in (None, "", "=")]
        values = [value for value in values if math.isfinite(value)]
        averaged[field] = round(statistics.mean(values), 3) if values else 0.0
    return averaged


def load_kma_monthly_climate(year: int = KMA_BASELINE_YEAR) -> dict[str, Any]:
    urls = extract_kma_api_urls()
    by_month: dict[int, dict[str, float]] = {month: {} for month in range(1, 13)}
    calls: list[dict[str, Any]] = []

    for api_name, spec in KMA_API_SPECS.items():
        endpoint = spec["endpoint"]
        template_url = urls[endpoint]
        for month in range(1, 13):
            yyyymm = f"{year}{month:02d}"
            status = "ok"
            error = ""
            try:
                text = fetch_kma_text(template_url, endpoint, yyyymm)
                _, rows = parse_kma_table(text)
            except HTTPError as exc:
                status = f"http-{exc.code}"
                error = "KMA API request was rejected"
                rows = []
            except (URLError, TimeoutError) as exc:
                status = "network-error"
                error = exc.__class__.__name__
                rows = []
            averaged = average_kma_fields(rows, spec["fields"])
            by_month[month].update(averaged)
            call = {
                "name": api_name,
                "endpoint": endpoint,
                "month": yyyymm,
                "status": status,
                "stationCount": len(rows),
                "fields": spec["fields"],
            }
            if error:
                call["error"] = error
            calls.append(call)

    return {
        "year": year,
        "byMonth": by_month,
        "calls": calls,
        "apiCount": len(KMA_API_SPECS),
    }


def climate_value(climate: dict[str, Any], month: int, field: str) -> float:
    values_by_month = climate.get("byMonth", {})
    month_values = values_by_month.get(month, {})
    if field in month_values:
        return parse_float(str(month_values[field]))

    values = [parse_float(str(values.get(field))) for values in values_by_month.values() if field in values]
    return statistics.mean(values) if values else 0.0


def normalized_climate_value(climate: dict[str, Any], month: int, field: str, inverse: bool = False) -> float:
    values_by_month = climate.get("byMonth", {})
    values = [parse_float(str(month_values.get(field))) for month_values in values_by_month.values() if field in month_values]
    values = [value for value in values if math.isfinite(value)]
    if not values:
        return 0.0
    value = climate_value(climate, month, field)
    min_value = min(values)
    max_value = max(values)
    if max_value == min_value:
        normalized = 0.5
    else:
        normalized = (value - min_value) / (max_value - min_value)
    return 1.0 - normalized if inverse else normalized


def read_dbf_from_zip(zip_path: Path) -> list[dict[str, str]]:
    with zipfile.ZipFile(zip_path) as zf:
        dbf_name = next(name for name in zf.namelist() if name.endswith(".dbf"))
        data = zf.read(dbf_name)

    record_count = struct.unpack("<I", data[4:8])[0]
    header_length = struct.unpack("<H", data[8:10])[0]
    record_length = struct.unpack("<H", data[10:12])[0]

    fields: list[tuple[str, int]] = []
    pos = 32
    while data[pos] != 0x0D:
        descriptor = data[pos : pos + 32]
        name = descriptor[:11].split(b"\0", 1)[0].decode("ascii", errors="ignore")
        length = descriptor[16]
        fields.append((name, length))
        pos += 32

    rows: list[dict[str, str]] = []
    offset = header_length
    for _ in range(record_count):
        record = data[offset : offset + record_length]
        offset += record_length
        if not record or record[:1] == b"*":
            continue

        row: dict[str, str] = {}
        field_offset = 1
        for name, length in fields:
            raw = record[field_offset : field_offset + length]
            field_offset += length
            row[name] = raw.decode("euc-kr", errors="replace").strip()
        rows.append(row)

    return rows


def read_shp_polygons_from_zip(zip_path: Path) -> tuple[tuple[float, float, float, float], list[dict[str, Any]]]:
    with zipfile.ZipFile(zip_path) as zf:
        shp_name = next(name for name in zf.namelist() if name.endswith(".shp"))
        data = zf.read(shp_name)

    shape_type = struct.unpack("<i", data[32:36])[0]
    if shape_type != 5:
        raise ValueError(f"Expected polygon shapefile, got shape type {shape_type}")

    file_bbox = struct.unpack("<4d", data[36:68])
    polygons: list[dict[str, Any]] = []
    pos = 100
    while pos < len(data):
        if pos + 8 > len(data):
            break
        _, content_words = struct.unpack(">2i", data[pos : pos + 8])
        pos += 8
        content = data[pos : pos + content_words * 2]
        pos += content_words * 2
        if len(content) < 4:
            continue

        record_shape = struct.unpack("<i", content[:4])[0]
        if record_shape == 0:
            polygons.append({"bbox": None, "rings": []})
            continue
        if record_shape != 5:
            raise ValueError(f"Unexpected record shape type {record_shape}")

        bbox = struct.unpack("<4d", content[4:36])
        part_count, point_count = struct.unpack("<2i", content[36:44])
        parts_start = 44
        points_start = parts_start + part_count * 4
        parts = list(struct.unpack(f"<{part_count}i", content[parts_start:points_start]))
        points = [
            struct.unpack("<2d", content[points_start + i * 16 : points_start + (i + 1) * 16])
            for i in range(point_count)
        ]

        rings: list[list[tuple[float, float]]] = []
        for idx, start in enumerate(parts):
            end = parts[idx + 1] if idx + 1 < len(parts) else len(points)
            rings.append(points[start:end])
        polygons.append({"bbox": bbox, "rings": rings})

    return file_bbox, polygons


def simplify_ring(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    if len(points) <= 12:
        return points

    kept = [points[0]]
    last_x, last_y = points[0]
    tolerance_sq = tolerance * tolerance
    for x, y in points[1:-1]:
        dx = x - last_x
        dy = y - last_y
        if dx * dx + dy * dy >= tolerance_sq:
            kept.append((x, y))
            last_x, last_y = x, y

    if len(kept) < 4:
        stride = max(1, len(points) // 12)
        kept = points[::stride]

    if kept[-1] != points[-1]:
        kept.append(points[-1])
    return kept


def polygon_to_path(
    rings: list[list[tuple[float, float]]],
    min_x: float,
    max_y: float,
    tolerance: float = SIMPLIFY_TOLERANCE_METERS,
) -> str:
    commands: list[str] = []
    for ring in rings:
        simple = simplify_ring(ring, tolerance)
        if len(simple) < 4:
            continue

        transformed = [(round(x - min_x), round(max_y - y)) for x, y in simple]
        first_x, first_y = transformed[0]
        parts = [f"M{first_x} {first_y}"]
        parts.extend(f"L{x} {y}" for x, y in transformed[1:])
        parts.append("Z")
        commands.append("".join(parts))
    return "".join(commands)


def load_fire_history() -> dict[str, Any]:
    region_count: Counter[tuple[str, str]] = Counter()
    region_area: defaultdict[tuple[str, str], float] = defaultdict(float)
    region_month_count: Counter[tuple[str, str, int]] = Counter()
    region_year_count: Counter[tuple[str, str, int]] = Counter()
    province_count: Counter[str] = Counter()
    province_area: defaultdict[str, float] = defaultdict(float)
    month_count: Counter[int] = Counter()
    event_months: set[tuple[str, str, int, int]] = set()
    year_values: list[int] = []
    total_area = 0.0

    with FIRE_CSV.open(encoding="cp949", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                year = int(row.get("발생일시_년") or 0)
                month = int(row.get("발생일시_월") or 0)
            except ValueError:
                continue
            if not year or not month:
                continue

            sido = norm_sido(row.get("발생장소_시도"))
            city = city_base(row.get("발생장소_시군구"))
            area = parse_float(row.get("피해면적_합계"))

            key = (sido, city)
            region_count[key] += 1
            region_area[key] += area
            region_month_count[(sido, city, month)] += 1
            region_year_count[(sido, city, year)] += 1
            province_count[sido] += 1
            province_area[sido] += area
            month_count[month] += 1
            event_months.add((sido, city, year, month))
            year_values.append(year)
            total_area += area

    return {
        "region_count": region_count,
        "region_area": region_area,
        "region_month_count": region_month_count,
        "region_year_count": region_year_count,
        "province_count": province_count,
        "province_area": province_area,
        "month_count": month_count,
        "event_months": event_months,
        "years": sorted(set(year_values)),
        "total_events": len(year_values),
        "total_area": total_area,
    }


def month_after(base_month: int, horizon: int) -> int:
    return ((base_month - 1 + horizon) % 12) + 1


def level_for(score: float) -> str:
    for threshold, label in LEVELS:
        if score >= threshold:
            return label
    return "안전"


def sigmoid(value: float) -> float:
    if value < -60:
        return 0.0
    if value > 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-value))


class TinyNeuralNet:
    def __init__(self, input_size: int, hidden_size: int = 18, seed: int = RANDOM_SEED) -> None:
        rng = random.Random(seed)
        self.w1 = [[rng.uniform(-0.35, 0.35) for _ in range(input_size)] for _ in range(hidden_size)]
        self.b1 = [rng.uniform(-0.05, 0.05) for _ in range(hidden_size)]
        self.w2 = [rng.uniform(-0.35, 0.35) for _ in range(hidden_size)]
        self.b2 = rng.uniform(-0.05, 0.05)

    def predict(self, x: list[float]) -> float:
        hidden = [sigmoid(sum(w * v for w, v in zip(weights, x)) + bias) for weights, bias in zip(self.w1, self.b1)]
        return sigmoid(sum(w * h for w, h in zip(self.w2, hidden)) + self.b2)

    def fit(self, samples: list[tuple[list[float], int]], epochs: int = 130, learning_rate: float = 0.055) -> None:
        rng = random.Random(RANDOM_SEED + 11)
        for epoch in range(epochs):
            rng.shuffle(samples)
            lr = learning_rate * (0.985 ** epoch)
            for x, y in samples:
                hidden = [
                    sigmoid(sum(w * v for w, v in zip(weights, x)) + bias)
                    for weights, bias in zip(self.w1, self.b1)
                ]
                output = sigmoid(sum(w * h for w, h in zip(self.w2, hidden)) + self.b2)
                output_delta = output - y

                old_w2 = self.w2[:]
                for idx, h in enumerate(hidden):
                    self.w2[idx] -= lr * output_delta * h
                self.b2 -= lr * output_delta

                for h_idx, h in enumerate(hidden):
                    hidden_delta = output_delta * old_w2[h_idx] * h * (1 - h)
                    for x_idx, value in enumerate(x):
                        self.w1[h_idx][x_idx] -= lr * hidden_delta * value
                    self.b1[h_idx] -= lr * hidden_delta


def evaluate(model: TinyNeuralNet, samples: list[tuple[list[float], int]]) -> dict[str, float | int]:
    if not samples:
        return {"accuracy": 0.0, "balancedAccuracy": 0.0, "testSize": 0}

    correct = 0
    true_positive = true_negative = false_positive = false_negative = 0
    for x, y in samples:
        pred = 1 if model.predict(x) >= 0.5 else 0
        correct += pred == y
        if y == 1 and pred == 1:
            true_positive += 1
        elif y == 0 and pred == 0:
            true_negative += 1
        elif y == 0 and pred == 1:
            false_positive += 1
        else:
            false_negative += 1

    positive_recall = true_positive / max(1, true_positive + false_negative)
    negative_recall = true_negative / max(1, true_negative + false_positive)
    return {
        "accuracy": correct / len(samples),
        "balancedAccuracy": (positive_recall + negative_recall) / 2,
        "testSize": len(samples),
    }


def build_feature_factory(regions: list[dict[str, Any]], history: dict[str, Any], climate: dict[str, Any]):
    max_region_count = max(1.0, math.log1p(max(history["region_count"].values() or [0])))
    max_region_area = max(1.0, math.log1p(max(history["region_area"].values() or [0.0])))
    max_province_count = max(1.0, math.log1p(max(history["province_count"].values() or [0])))
    max_month_count = max(1.0, max(history["month_count"].values() or [0]))

    width = max(region["centroid"][0] for region in regions) or 1
    height = max(region["centroid"][1] for region in regions) or 1

    def features(region: dict[str, Any], month: int, horizon: int = 0) -> list[float]:
        key = region["matchKey"]
        province = region["province"]
        drought = region["droughtScores"][min(horizon, 3)] / 4
        month_rate = history["month_count"][month] / max_month_count
        region_rate = math.log1p(history["region_count"][key]) / max_region_count
        province_rate = math.log1p(history["province_count"][province]) / max_province_count
        damage_rate = math.log1p(history["region_area"][key]) / max_region_area
        seasonal_angle = 2 * math.pi * (month - 1) / 12
        x_norm = region["centroid"][0] / width
        y_norm = region["centroid"][1] / height
        spring_peak = 1.0 if month in (2, 3, 4) else 0.35 if month in (1, 5, 11, 12) else 0.0
        air_hot = normalized_climate_value(climate, month, "TA_MAVG")
        air_max_hot = normalized_climate_value(climate, month, "TMX")
        surface_hot = normalized_climate_value(climate, month, "TS_MAX")
        grass_dry_cold = normalized_climate_value(climate, month, "TG_MIN", inverse=True)
        soil_hot = normalized_climate_value(climate, month, "TE005_MAVG")
        deep_soil_hot = normalized_climate_value(climate, month, "TE300_MAVG")
        humidity_dry = normalized_climate_value(climate, month, "RHM_MAVG", inverse=True)
        rainfall_dry = normalized_climate_value(climate, month, "RN_MSUM", inverse=True)
        return [
            math.sin(seasonal_angle),
            math.cos(seasonal_angle),
            month_rate,
            region_rate,
            province_rate,
            damage_rate,
            drought,
            spring_peak,
            x_norm,
            y_norm,
            air_hot,
            air_max_hot,
            surface_hot,
            grass_dry_cold,
            soil_hot,
            deep_soil_hot,
            humidity_dry,
            rainfall_dry,
        ]

    return features


def train_model(
    regions: list[dict[str, Any]],
    history: dict[str, Any],
    feature_for: Any,
) -> tuple[TinyNeuralNet, dict[str, float | int]]:
    samples: list[tuple[list[float], int]] = []
    region_lookup = {(region["province"], region["cityBase"]): region for region in regions}

    for region in regions:
        for year in history["years"]:
            for month in range(1, 13):
                label = 1 if (region["province"], region["cityBase"], year, month) in history["event_months"] else 0
                samples.append((feature_for(region, month, 0), label))

    positives = [sample for sample in samples if sample[1] == 1]
    negatives = [sample for sample in samples if sample[1] == 0]
    rng = random.Random(RANDOM_SEED + 23)
    rng.shuffle(positives)
    rng.shuffle(negatives)
    balanced = positives + negatives[: max(len(positives), min(len(negatives), len(positives) * 2))]
    rng.shuffle(balanced)

    split = max(1, int(len(balanced) * 0.8))
    train_samples = balanced[:split]
    test_samples = balanced[split:]

    model = TinyNeuralNet(input_size=len(train_samples[0][0]))
    model.fit(train_samples)
    metrics = evaluate(model, test_samples)
    metrics["trainSize"] = len(train_samples)
    metrics["positiveSamples"] = len(positives)
    metrics["matchedRegions"] = len(region_lookup)
    return model, metrics


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)

    history = load_fire_history()
    status_rows = read_dbf_from_zip(STATUS_ZIP)
    forecast_rows = read_dbf_from_zip(MONTH_ZIP)
    forecast_by_code = {row["SGG_CD"]: row for row in forecast_rows}
    climate = load_kma_monthly_climate()

    file_bbox, polygons = read_shp_polygons_from_zip(STATUS_ZIP)
    if len(status_rows) != len(polygons):
        raise ValueError("DBF and SHP record counts do not match")

    min_x, min_y, max_x, max_y = file_bbox
    width = round(max_x - min_x)
    height = round(max_y - min_y)

    regions: list[dict[str, Any]] = []
    for row, polygon in zip(status_rows, polygons):
        province = row["SD_NM"]
        city = row["SGG_NM"]
        forecast = forecast_by_code.get(row["SGG_CD"], {})
        drought_steps = [
            row.get("DRGHT_STEP", "정상"),
            forecast.get("MONS01_PRS", row.get("DRGHT_STEP", "정상")),
            forecast.get("MONS02_PRS", row.get("DRGHT_STEP", "정상")),
            forecast.get("MONS03_PRS", row.get("DRGHT_STEP", "정상")),
        ]
        bbox = polygon["bbox"] or (min_x, min_y, max_x, max_y)
        centroid = [round(((bbox[0] + bbox[2]) / 2) - min_x), round(max_y - ((bbox[1] + bbox[3]) / 2))]
        path = polygon_to_path(polygon["rings"], min_x, max_y)
        key = (province, city_base(city))
        fire_count = history["region_count"][key]
        monthly_counts = {month: history["region_month_count"][(province, city_base(city), month)] for month in range(1, 13)}
        peak_month = max(monthly_counts, key=lambda month: (monthly_counts[month], -month))

        regions.append(
            {
                "id": row["SGG_CD"],
                "province": province,
                "city": city,
                "cityBase": city_base(city),
                "matchKey": key,
                "path": path,
                "centroid": centroid,
                "droughtSteps": drought_steps,
                "droughtScores": [DROUGHT_SCORE.get(step, 0) for step in drought_steps],
                "fireCount": fire_count,
                "fireArea": history["region_area"][key],
                "peakMonth": peak_month if monthly_counts[peak_month] else None,
                "yearlyFireCounts": {
                    str(year): history["region_year_count"][(province, city_base(city), year)]
                    for year in history["years"]
                },
            }
        )

    feature_for = build_feature_factory(regions, history, climate)
    model, metrics = train_model(regions, history, feature_for)

    status_date = status_rows[0].get("ANALS_DE", "")
    base_month = int(status_date[5:7]) if len(status_date) >= 7 else dt.date.today().month
    prediction_months = list(range(base_month, 13))

    raw_probabilities: dict[int, list[float]] = {}
    for target_month in prediction_months:
        horizon = target_month - base_month
        drought_index = min(horizon, 3)
        raw_probabilities[target_month] = [
            model.predict(feature_for(region, target_month, drought_index)) for region in regions
        ]

    for target_month in prediction_months:
        horizon = target_month - base_month
        drought_index = min(horizon, 3)
        probs = raw_probabilities[target_month]
        min_prob = min(probs)
        max_prob = max(probs)
        span = max(max_prob - min_prob, 1e-9)
        drought_key = f"m{target_month:02d}"
        month_fire_max = max(1, max(history["month_count"].values() or [1]))
        for region, probability in zip(regions, probs):
            normalized_probability = (probability - min_prob) / span
            history_component = min(1.0, math.log1p(region["fireCount"]) / 3.3)
            damage_component = min(1.0, math.log1p(region["fireArea"]) / 3.8)
            drought_component = region["droughtScores"][drought_index] / 4
            season_component = history["month_count"][target_month] / month_fire_max
            climate_component = (
                normalized_climate_value(climate, target_month, "TA_MAVG") * 0.14
                + normalized_climate_value(climate, target_month, "TMX") * 0.14
                + normalized_climate_value(climate, target_month, "TS_MAX") * 0.14
                + normalized_climate_value(climate, target_month, "TE005_MAVG") * 0.10
                + normalized_climate_value(climate, target_month, "TE300_MAVG") * 0.08
                + normalized_climate_value(climate, target_month, "RHM_MAVG", inverse=True) * 0.20
                + normalized_climate_value(climate, target_month, "RN_MSUM", inverse=True) * 0.20
            )
            score = 100 * (
                normalized_probability * 0.43
                + drought_component * 0.21
                + climate_component * 0.18
                + history_component * 0.10
                + damage_component * 0.04
                + season_component * 0.04
            )
            score = max(0.0, min(100.0, score))
            region.setdefault("risk", {})[drought_key] = {
                "score": round(score, 1),
                "level": level_for(score),
                "probability": round(probability, 4),
                "month": target_month,
                "droughtStep": region["droughtSteps"][drought_index],
                "weather": {
                    "airTemperature": climate_value(climate, target_month, "TA_MAVG"),
                    "maxTemperature": climate_value(climate, target_month, "TMX"),
                    "surfaceTemperature": climate_value(climate, target_month, "TS_MAX"),
                    "soilTemperature": climate_value(climate, target_month, "TE005_MAVG"),
                    "deepSoilTemperature": climate_value(climate, target_month, "TE300_MAVG"),
                    "humidity": climate_value(climate, target_month, "RHM_MAVG"),
                    "rainfall": climate_value(climate, target_month, "RN_MSUM"),
                },
            }

    for region in regions:
        region["fireArea"] = round(region["fireArea"], 2)
        region["drought"] = {
            "current": region["droughtSteps"][0],
            "plus1": region["droughtSteps"][1],
            "plus2": region["droughtSteps"][2],
            "plus3": region["droughtSteps"][3],
        }
        del region["droughtSteps"]
        del region["droughtScores"]
        del region["matchKey"]
        del region["cityBase"]

    current_risk_key = f"m{base_month:02d}"
    current_scores = [region["risk"][current_risk_key]["score"] for region in regions]
    level_counts = Counter(region["risk"][current_risk_key]["level"] for region in regions)
    top_regions = sorted(
        regions,
        key=lambda region: region["risk"][current_risk_key]["score"],
        reverse=True,
    )[:8]

    data = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": {
            "wildfireCsv": FIRE_CSV.name,
            "droughtStatusZip": STATUS_ZIP.name,
            "droughtForecastZip": MONTH_ZIP.name,
            "droughtStatusDate": status_date,
            "droughtForecastMonth": forecast_rows[0].get("ANALS_YM", "") if forecast_rows else "",
            "kmaApiDoc": API_MD.name,
            "kmaBaselineYear": climate["year"],
            "kmaApiCount": climate["apiCount"],
            "kmaApiCallCount": len(climate["calls"]),
            "kmaApiOkCallCount": sum(1 for call in climate["calls"] if call["status"] == "ok"),
            "kmaApiRejectedCallCount": sum(1 for call in climate["calls"] if call["status"].startswith("http-")),
            "kmaApiCalls": climate["calls"],
            "predictionYear": int(status_date[:4]) if len(status_date) >= 4 else dt.date.today().year,
            "predictionMonths": prediction_months,
            "fireHistoryYears": history["years"],
            "fireEvents": history["total_events"],
            "fireDamageArea": round(history["total_area"], 2),
        },
        "viewBox": [0, 0, width, height],
        "model": {
            "name": "Tiny one-hidden-layer neural network",
            "description": "산불 이력, 월별 계절성, 지역별 피해면적, 가뭄 단계, 기상청 API 기상값을 특징으로 사용한 교육용 신경망 예측 모델",
            "features": [
                "월 주기",
                "월별 산불 빈도",
                "시군구 산불 빈도",
                "시도 산불 빈도",
                "피해면적",
                "가뭄 단계",
                "기온 API",
                "지면온도 API",
                "초상온도 API",
                "지중온도 API",
                "습도 API",
                "강수량 API",
                "지도상 위치",
            ],
            "accuracy": round(float(metrics["accuracy"]), 3),
            "balancedAccuracy": round(float(metrics["balancedAccuracy"]), 3),
            "trainSize": metrics["trainSize"],
            "testSize": metrics["testSize"],
            "positiveSamples": metrics["positiveSamples"],
        },
        "summary": {
            "regionCount": len(regions),
            "averageRisk": round(statistics.mean(current_scores), 1),
            "maxRisk": round(max(current_scores), 1),
            "minRisk": round(min(current_scores), 1),
            "levelCounts": dict(level_counts),
            "topRegions": [
                {
                    "id": region["id"],
                    "name": f"{region['province']} {region['city']}",
                    "score": region["risk"][current_risk_key]["score"],
                    "level": region["risk"][current_risk_key]["level"],
                }
                for region in top_regions
            ],
        },
        "legend": [
            {"level": "안전", "range": "0-24", "color": "#2fbf71"},
            {"level": "경고", "range": "25-49", "color": "#f4c542"},
            {"level": "위험", "range": "50-74", "color": "#f28c28"},
            {"level": "매우 위험", "range": "75-100", "color": "#d94141"},
        ],
        "regions": regions,
    }

    json_text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    OUT_JSON.write_text(json_text + "\n", encoding="utf-8")
    OUT_JS.write_text("window.FIREDICTION_DATA = " + json_text + ";\n", encoding="utf-8")

    print(f"Built {len(regions)} regions")
    print(f"Model accuracy: {data['model']['accuracy']} / balanced: {data['model']['balancedAccuracy']}")
    print(f"Wrote {OUT_JSON.relative_to(ROOT)} and {OUT_JS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
