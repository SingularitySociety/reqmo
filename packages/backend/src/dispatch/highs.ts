const DEFAULT_TIME_LIMIT_SECONDS = 0.5;
const MAX_TIME_LIMIT_SECONDS = 10;

function normalizeNonNegative(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveTimeLimitSeconds(timeLimitSeconds) {
  const normalized = normalizeNonNegative(timeLimitSeconds, DEFAULT_TIME_LIMIT_SECONDS);
  if (normalized <= 0) {
    return DEFAULT_TIME_LIMIT_SECONDS;
  }
  return clamp(normalized, 0.05, MAX_TIME_LIMIT_SECONDS);
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return numeric;
}

function selectHighestColumnIndex(values) {
  let bestIndex = null;
  let bestValue = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (value > bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function buildSingleSelectionModel(candidates, integerColumnType) {
  const candidateCount = candidates.length;
  const rowCount = 1;
  const offsets = new Int32Array(rowCount + 1);
  offsets[0] = 0;
  offsets[1] = candidateCount;

  const indices = new Int32Array(candidateCount);
  const values = new Float64Array(candidateCount);
  const objectiveLinearWeights = new Float64Array(candidateCount);
  const columnTypes = new Int32Array(candidateCount);
  const columnLowerBounds = new Float64Array(candidateCount);
  const columnUpperBounds = new Float64Array(candidateCount);

  for (let i = 0; i < candidateCount; i += 1) {
    indices[i] = i;
    values[i] = 1;
    objectiveLinearWeights[i] = normalizeScore(candidates[i]?.score);
    columnTypes[i] = integerColumnType;
    columnLowerBounds[i] = 0;
    columnUpperBounds[i] = 1;
  }

  return {
    columnCount: candidateCount,
    columnTypes,
    columnLowerBounds,
    columnUpperBounds,
    rowCount,
    rowLowerBounds: Float64Array.of(1),
    rowUpperBounds: Float64Array.of(1),
    weights: {
      offsets,
      indices,
      values
    },
    isMaximization: false,
    objectiveLinearWeights
  };
}

function isHighsSolverDisabledByEnv() {
  const raw = String(process.env.REQMO_DISABLE_HIGHS_SOLVER ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

let highsModulePromise = null;

async function loadHighsSolver() {
  if (isHighsSolverDisabledByEnv()) {
    return null;
  }
  if (!highsModulePromise) {
    highsModulePromise = import("highs-solver")
      .then((module) => module)
      .catch(() => null);
  }
  return highsModulePromise;
}

export async function selectCandidateByHighs({
  candidates,
  timeLimitSeconds = DEFAULT_TIME_LIMIT_SECONDS
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const highs = await loadHighsSolver();
  if (!highs || typeof highs.solve !== "function") {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const integerColumnType =
    Number(highs?.ColumnType?.INTEGER) || 1;
  const model = buildSingleSelectionModel(candidates, integerColumnType);

  const solution = await highs.solve(model, {
    options: {
      output_flag: false,
      log_to_console: false,
      time_limit: resolveTimeLimitSeconds(timeLimitSeconds),
      mip_rel_gap: 0
    }
  });

  const columns = solution?.primal?.columns;
  if (!columns || typeof columns.length !== "number") {
    return null;
  }

  let selectedIndex = selectHighestColumnIndex(columns);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= candidates.length) {
    selectedIndex = 0;
  }

  return candidates[selectedIndex] ?? null;
}
