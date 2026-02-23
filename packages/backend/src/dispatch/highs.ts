const DEFAULT_TIME_LIMIT_SECONDS = 0.5;
const MAX_TIME_LIMIT_SECONDS = 10;
const MAX_ERROR_MESSAGE_LENGTH = 240;
const COLUMN_SELECTION_THRESHOLD = 0.5;
const MINUS_INF = -1e20;

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

function normalizePositiveInteger(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const integer = Math.trunc(numeric);
  if (integer <= 0) {
    return fallback;
  }
  return integer;
}

function resolveSelectionCount(selectionCount, candidateCount) {
  const normalized = normalizePositiveInteger(selectionCount, 1);
  if (!Number.isFinite(candidateCount) || candidateCount <= 0) {
    return normalized;
  }
  return Math.min(normalized, candidateCount);
}

function resolveOptionalUpperBound(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function normalizeGroupKey(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function candidateExistingDelaySumMinutes(candidate) {
  return normalizeNonNegative(
    candidate?.existingDelaySumMinutes ?? candidate?.detourSumMinutes,
    0
  );
}

function candidateMaxDelayMinutes(candidate) {
  return normalizeNonNegative(
    candidate?.maxDelayMinutes ?? candidate?.detourMinutes,
    0
  );
}

function buildSelectionModel(candidates, integerColumnType, {
  selectionCount = 1,
  constraints = {}
} = {}) {
  const candidateCount = candidates.length;
  const fairnessPenaltyWeight = normalizeNonNegative(constraints?.fairnessPenaltyWeight, 0);
  const timeDeviationWeight = normalizeNonNegative(constraints?.timeDeviationWeight, 0);
  const normalizedSelectionCount = resolveSelectionCount(selectionCount, candidateCount);
  const maxTotalExistingDelayMinutes = resolveOptionalUpperBound(
    constraints?.maxTotalExistingDelayMinutes
  );
  const maxTotalMaxDelayMinutes = resolveOptionalUpperBound(
    constraints?.maxTotalMaxDelayMinutes
  );
  const maxAverageMaxDelayMinutes = resolveOptionalUpperBound(
    constraints?.maxAverageMaxDelayMinutes
  );
  const maxSelectedPerGroup = normalizePositiveInteger(
    constraints?.maxSelectedPerGroup,
    1
  );

  const objectiveLinearWeights = new Float64Array(candidateCount);
  const columnTypes = new Int32Array(candidateCount);
  const columnLowerBounds = new Float64Array(candidateCount);
  const columnUpperBounds = new Float64Array(candidateCount);

  for (let i = 0; i < candidateCount; i += 1) {
    const fairnessPenalty = normalizeNonNegative(candidates[i]?.fairnessPenalty, 0);
    const timeDeviationMinutes = normalizeNonNegative(candidates[i]?.timeDeviationMinutes, 0);
    objectiveLinearWeights[i] =
      normalizeScore(candidates[i]?.score) +
      fairnessPenaltyWeight * fairnessPenalty +
      timeDeviationWeight * timeDeviationMinutes;
    columnTypes[i] = integerColumnType;
    columnLowerBounds[i] = 0;
    columnUpperBounds[i] = 1;
  }

  const rowLowerBounds = [];
  const rowUpperBounds = [];
  const rowOffsets = [];
  const sparseIndices = [];
  const sparseValues = [];

  function appendRow({
    lower,
    upper,
    indices,
    values
  }) {
    if (!Array.isArray(indices) || !Array.isArray(values) || indices.length !== values.length) {
      return;
    }
    if (!indices.length) {
      return;
    }
    rowOffsets.push(sparseIndices.length);
    rowLowerBounds.push(lower);
    rowUpperBounds.push(upper);
    for (let i = 0; i < indices.length; i += 1) {
      sparseIndices.push(indices[i]);
      sparseValues.push(values[i]);
    }
  }

  // Mandatory row: select exactly k candidates.
  appendRow({
    lower: normalizedSelectionCount,
    upper: normalizedSelectionCount,
    indices: Array.from({ length: candidateCount }, (_value, index) => index),
    values: Array.from({ length: candidateCount }, () => 1)
  });

  if (maxTotalExistingDelayMinutes !== null) {
    appendRow({
      lower: MINUS_INF,
      upper: maxTotalExistingDelayMinutes,
      indices: Array.from({ length: candidateCount }, (_value, index) => index),
      values: candidates.map((candidate) => candidateExistingDelaySumMinutes(candidate))
    });
  }

  if (maxTotalMaxDelayMinutes !== null) {
    appendRow({
      lower: MINUS_INF,
      upper: maxTotalMaxDelayMinutes,
      indices: Array.from({ length: candidateCount }, (_value, index) => index),
      values: candidates.map((candidate) => candidateMaxDelayMinutes(candidate))
    });
  }

  if (maxAverageMaxDelayMinutes !== null) {
    appendRow({
      lower: MINUS_INF,
      upper: maxAverageMaxDelayMinutes * normalizedSelectionCount,
      indices: Array.from({ length: candidateCount }, (_value, index) => index),
      values: candidates.map((candidate) => candidateMaxDelayMinutes(candidate))
    });
  }

  const groupedCandidateIndices = new Map();
  for (let i = 0; i < candidateCount; i += 1) {
    const key = normalizeGroupKey(candidates[i]?.groupKey);
    if (!key) {
      continue;
    }
    if (!groupedCandidateIndices.has(key)) {
      groupedCandidateIndices.set(key, []);
    }
    groupedCandidateIndices.get(key).push(i);
  }
  groupedCandidateIndices.forEach((indices) => {
    if (!Array.isArray(indices) || !indices.length) {
      return;
    }
    if (indices.length <= maxSelectedPerGroup) {
      return;
    }
    appendRow({
      lower: 0,
      upper: maxSelectedPerGroup,
      indices,
      values: Array.from({ length: indices.length }, () => 1)
    });
  });

  const rowCount = rowLowerBounds.length;
  return {
    columnCount: candidateCount,
    columnTypes,
    columnLowerBounds,
    columnUpperBounds,
    rowCount,
    rowLowerBounds: Float64Array.from(rowLowerBounds),
    rowUpperBounds: Float64Array.from(rowUpperBounds),
    weights: {
      offsets: Int32Array.from(rowOffsets),
      indices: Int32Array.from(sparseIndices),
      values: Float64Array.from(sparseValues)
    },
    isMaximization: false,
    objectiveLinearWeights
  };
}

function sortedCandidateIndicesByColumnValue(columns, candidates) {
  const scored = [];
  for (let i = 0; i < columns.length; i += 1) {
    const columnValue = Number(columns[i]);
    if (!Number.isFinite(columnValue)) {
      continue;
    }
    scored.push({
      index: i,
      columnValue,
      score: normalizeScore(candidates[i]?.score)
    });
  }
  scored.sort((left, right) => {
    if (left.columnValue !== right.columnValue) {
      return right.columnValue - left.columnValue;
    }
    if (left.score !== right.score) {
      return left.score - right.score;
    }
    return left.index - right.index;
  });
  return scored.map((entry) => entry.index);
}

function isHighsSolverDisabledByEnv() {
  const raw = String(process.env.REQMO_DISABLE_HIGHS_SOLVER ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function trimErrorMessage(message) {
  if (typeof message !== "string") {
    return "unknown";
  }
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function normalizeErrorMessage(error) {
  if (error instanceof Error) {
    return trimErrorMessage(error.message || error.name || "Error");
  }
  return trimErrorMessage(String(error ?? "unknown"));
}

const highsRuntimeDiagnostics = {
  disabledByEnv: false,
  loadAttempted: false,
  loadSucceeded: false,
  loadError: null,
  lastLoadedAt: null,
  solveAttemptedCount: 0,
  solveSuccessCount: 0,
  solveErrorCount: 0,
  lastSolveError: null
};

let hasLoggedLoadFailure = false;
let highsModulePromise = null;

async function loadHighsSolver() {
  const disabledByEnv = isHighsSolverDisabledByEnv();
  highsRuntimeDiagnostics.disabledByEnv = disabledByEnv;
  if (disabledByEnv) {
    return null;
  }
  if (!highsModulePromise) {
    highsRuntimeDiagnostics.loadAttempted = true;
    highsModulePromise = import("highs-solver")
      .then((module) => {
        highsRuntimeDiagnostics.loadSucceeded = true;
        highsRuntimeDiagnostics.loadError = null;
        highsRuntimeDiagnostics.lastLoadedAt = new Date().toISOString();
        return module;
      })
      .catch((error) => {
        highsRuntimeDiagnostics.loadSucceeded = false;
        highsRuntimeDiagnostics.loadError = normalizeErrorMessage(error);
        if (!hasLoggedLoadFailure) {
          hasLoggedLoadFailure = true;
          console.error(
            `[dispatch-highs] failed to load highs-solver (${process.platform}/${process.arch} node=${process.version}): ${highsRuntimeDiagnostics.loadError}`
          );
        }
        return null;
      });
  }
  return highsModulePromise;
}

export function getHighsRuntimeDiagnostics() {
  return {
    ...highsRuntimeDiagnostics
  };
}

export async function selectCandidatesByHighs({
  candidates,
  selectionCount = 1,
  constraints = {},
  timeLimitSeconds = DEFAULT_TIME_LIMIT_SECONDS
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const normalizedSelectionCount = resolveSelectionCount(selectionCount, candidates.length);
  if (normalizedSelectionCount <= 0) {
    return null;
  }
  highsRuntimeDiagnostics.solveAttemptedCount += 1;

  const highs = await loadHighsSolver();
  if (!highs || typeof highs.solve !== "function") {
    highsRuntimeDiagnostics.lastSolveError = highsRuntimeDiagnostics.loadError ?? "highs unavailable";
    highsRuntimeDiagnostics.solveErrorCount += 1;
    return null;
  }

  const integerColumnType =
    Number(highs?.ColumnType?.INTEGER) || 1;
  const model = buildSelectionModel(candidates, integerColumnType, {
    selectionCount: normalizedSelectionCount,
    constraints
  });

  let solution;
  try {
    solution = await highs.solve(model, {
      options: {
        output_flag: false,
        log_to_console: false,
        time_limit: resolveTimeLimitSeconds(timeLimitSeconds),
        mip_rel_gap: 0
      }
    });
  } catch (error) {
    highsRuntimeDiagnostics.lastSolveError = normalizeErrorMessage(error);
    highsRuntimeDiagnostics.solveErrorCount += 1;
    console.error(`[dispatch-highs] solve failed: ${highsRuntimeDiagnostics.lastSolveError}`);
    return null;
  }

  const columns = solution?.primal?.columns;
  if (!columns || typeof columns.length !== "number") {
    highsRuntimeDiagnostics.lastSolveError = "missing primal columns";
    highsRuntimeDiagnostics.solveErrorCount += 1;
    return null;
  }

  const sortedIndices = sortedCandidateIndicesByColumnValue(columns, candidates);
  if (!sortedIndices.length) {
    highsRuntimeDiagnostics.solveErrorCount += 1;
    highsRuntimeDiagnostics.lastSolveError = "invalid column values";
    return null;
  }

  const selectedIndices = [];
  const selectedSet = new Set();
  for (const index of sortedIndices) {
    const columnValue = Number(columns[index]);
    if (!Number.isFinite(columnValue) || columnValue < COLUMN_SELECTION_THRESHOLD) {
      continue;
    }
    if (!selectedSet.has(index)) {
      selectedSet.add(index);
      selectedIndices.push(index);
    }
    if (selectedIndices.length >= normalizedSelectionCount) {
      break;
    }
  }
  if (selectedIndices.length < normalizedSelectionCount) {
    for (const index of sortedIndices) {
      if (!selectedSet.has(index)) {
        selectedSet.add(index);
        selectedIndices.push(index);
      }
      if (selectedIndices.length >= normalizedSelectionCount) {
        break;
      }
    }
  }

  const selected = selectedIndices
    .map((index) => candidates[index] ?? null)
    .filter(Boolean);
  if (selected.length === normalizedSelectionCount) {
    highsRuntimeDiagnostics.solveSuccessCount += 1;
    highsRuntimeDiagnostics.lastSolveError = null;
    return selected;
  }

  highsRuntimeDiagnostics.solveErrorCount += 1;
  highsRuntimeDiagnostics.lastSolveError = "selected candidate set was incomplete";
  return null;
}

export async function selectCandidateByHighs({
  candidates,
  constraints = {},
  timeLimitSeconds = DEFAULT_TIME_LIMIT_SECONDS
}) {
  const selected = await selectCandidatesByHighs({
    candidates,
    selectionCount: 1,
    constraints,
    timeLimitSeconds
  });
  return Array.isArray(selected) && selected.length > 0 ? selected[0] : null;
}
