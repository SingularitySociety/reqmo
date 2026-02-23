const DEFAULT_TIME_LIMIT_SECONDS = 0.5;
const MAX_TIME_LIMIT_SECONDS = 10;
const MAX_ERROR_MESSAGE_LENGTH = 240;

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
  // Keep offsets length equal to rowCount for compatibility across
  // highs-solver versions (0.9.x and 0.10.x).
  const offsets = new Int32Array(rowCount);
  offsets[0] = 0;

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

export async function selectCandidateByHighs({
  candidates,
  timeLimitSeconds = DEFAULT_TIME_LIMIT_SECONDS
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  highsRuntimeDiagnostics.solveAttemptedCount += 1;

  const highs = await loadHighsSolver();
  if (!highs || typeof highs.solve !== "function") {
    highsRuntimeDiagnostics.lastSolveError = highsRuntimeDiagnostics.loadError ?? "highs unavailable";
    highsRuntimeDiagnostics.solveErrorCount += 1;
    return null;
  }
  if (candidates.length === 1) {
    highsRuntimeDiagnostics.solveSuccessCount += 1;
    highsRuntimeDiagnostics.lastSolveError = null;
    return candidates[0];
  }

  const integerColumnType =
    Number(highs?.ColumnType?.INTEGER) || 1;
  const model = buildSingleSelectionModel(candidates, integerColumnType);

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

  let selectedIndex = selectHighestColumnIndex(columns);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= candidates.length) {
    selectedIndex = 0;
  }

  const selected = candidates[selectedIndex] ?? null;
  if (selected) {
    highsRuntimeDiagnostics.solveSuccessCount += 1;
    highsRuntimeDiagnostics.lastSolveError = null;
  } else {
    highsRuntimeDiagnostics.solveErrorCount += 1;
    highsRuntimeDiagnostics.lastSolveError = "selected candidate was null";
  }
  return selected;
}
