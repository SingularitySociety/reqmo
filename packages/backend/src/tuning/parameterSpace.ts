const PARAMETER_DEFINITIONS = [
  { path: "dispatchPolicy.weights.pickupDelay", type: "number", min: 0.05, max: 2, step: 0.05, locked: true },
  { path: "dispatchPolicy.weights.detour", type: "number", min: 0.05, max: 2, step: 0.05 },
  { path: "dispatchPolicy.weights.deadhead", type: "number", min: 0.05, max: 2, step: 0.05 },
  { path: "dispatchPolicy.weights.rideTimeDetour", type: "number", min: 0.3, max: 2, step: 0.05 },
  { path: "dispatchPolicy.weights.lateness", type: "number", min: 0.05, max: 3, step: 0.05 },
  { path: "dispatchPolicy.weights.dropoffPriority", type: "number", min: 0, max: 3, step: 0.1 },
  { path: "dispatchPolicy.weights.existingDelaySum", type: "number", min: 0, max: 2, step: 0.05 },
  { path: "poolingPolicy.maxDetourMinutes", type: "number", min: 3, max: 20, step: 1, locked: true, policyConstraint: true },
  { path: "dispatchPolicy.maxWaitMinutes", type: "number", min: 5, max: 30, step: 1, locked: true, policyConstraint: true },
  { path: "dispatchPolicy.candidateVehicleLimit", type: "integer", min: 1, max: 100, step: 1, locked: true },
  { path: "dispatchPolicy.algorithmPrimary", type: "categorical", values: ["INSERTION", "HIGHS"], locked: true },
  { path: "dispatchPolicy.highs.timeLimitSec", type: "number", min: 0.1, max: 5, step: 0.1, locked: true },
  { path: "dispatchPolicy.cruiseSpeedKmh", type: "number", min: 5, max: 60, step: 1, locked: true, calibrationOnly: true },
  { path: "dispatchPolicy.pickupServiceMinutes", type: "number", min: 0, max: 15, step: 0.5, locked: true, calibrationOnly: true },
  { path: "dispatchPolicy.dropoffServiceMinutes", type: "number", min: 0, max: 15, step: 0.5, locked: true, calibrationOnly: true }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getPathValue(target, path) {
  return String(path)
    .split(".")
    .reduce((value, key) => value?.[key], target);
}

export function setPathValue(target, path, value) {
  const keys = String(path).split(".");
  let cursor = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
  return target;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundToStep(value, step, min = 0) {
  if (!Number.isFinite(step) || step <= 0) {
    return value;
  }
  const steps = Math.round((value - min) / step);
  const rounded = min + steps * step;
  return Number(rounded.toFixed(8));
}

function normalizeDefinition(baseDefinition, override = {}) {
  const next = { ...baseDefinition, ...override, path: baseDefinition.path };
  if (next.type === "categorical") {
    const allowed = new Set(baseDefinition.values ?? []);
    const requested = Array.isArray(next.values) ? next.values : baseDefinition.values;
    next.values = requested.filter((value) => allowed.has(value));
    if (!next.values.length) {
      next.values = [...baseDefinition.values];
    }
    return next;
  }

  const baseMin = Number(baseDefinition.min);
  const baseMax = Number(baseDefinition.max);
  next.min = clamp(Number(next.min), baseMin, baseMax);
  next.max = clamp(Number(next.max), next.min, baseMax);
  next.step = Math.max(Number(next.step) || Number(baseDefinition.step) || 0, 0);
  return next;
}

export function createParameterSpace(baseProfile, requested = null) {
  const requestedByPath = new Map(
    (Array.isArray(requested) ? requested : []).map((entry) => [entry?.path, entry])
  );

  return PARAMETER_DEFINITIONS.map((definition) => {
    const override = requestedByPath.get(definition.path) ?? {};
    const normalized = normalizeDefinition(definition, override);
    const current = getPathValue(baseProfile, definition.path);
    return {
      ...normalized,
      current,
      locked: override.locked === undefined ? definition.locked === true : override.locked === true
    };
  });
}

export function tunableParameters(parameterSpace) {
  return parameterSpace.filter((entry) => entry.locked !== true);
}

export function normalizeParameterValue(definition, value) {
  if (definition.type === "categorical") {
    return definition.values.includes(value) ? value : definition.current;
  }
  const numeric = Number(value);
  const fallback = Number(definition.current);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  let normalized = roundToStep(
    clamp(safe, Number(definition.min), Number(definition.max)),
    Number(definition.step),
    Number(definition.min)
  );
  if (definition.type === "integer") {
    normalized = Math.trunc(normalized);
  }
  return normalized;
}

export function profileFromParameterValues(baseProfile, parameterSpace, values = {}) {
  const profile = clone(baseProfile);
  for (const definition of parameterSpace) {
    if (definition.locked === true) {
      setPathValue(profile, definition.path, definition.current);
      continue;
    }
    const requested = Object.prototype.hasOwnProperty.call(values, definition.path)
      ? values[definition.path]
      : definition.current;
    setPathValue(profile, definition.path, normalizeParameterValue(definition, requested));
  }
  return profile;
}

export function parameterValuesFromProfile(profile, parameterSpace) {
  return Object.fromEntries(
    parameterSpace.map((definition) => [definition.path, getPathValue(profile, definition.path)])
  );
}

export function diffParameterValues(baseProfile, candidateProfile, parameterSpace) {
  return parameterSpace
    .map((definition) => ({
      path: definition.path,
      before: getPathValue(baseProfile, definition.path),
      after: getPathValue(candidateProfile, definition.path),
      policyConstraint: definition.policyConstraint === true,
      calibrationOnly: definition.calibrationOnly === true
    }))
    .filter((entry) => entry.before !== entry.after);
}

export function validateCandidateProfile(profile, parameterSpace) {
  const errors = [];
  if (!profile || typeof profile !== "object" || !profile.id) {
    errors.push("service profile id is required");
  }
  for (const definition of parameterSpace) {
    if (definition.locked === true) {
      continue;
    }
    const value = getPathValue(profile, definition.path);
    if (definition.type === "categorical") {
      if (!definition.values.includes(value)) {
        errors.push(`${definition.path} is outside the allowed values`);
      }
      continue;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      errors.push(`${definition.path} must be finite`);
      continue;
    }
    if (numeric < definition.min || numeric > definition.max) {
      errors.push(`${definition.path} is outside the safe range`);
    }
  }
  return {
    ok: errors.length === 0,
    errors
  };
}

export function defaultParameterDefinitions() {
  return PARAMETER_DEFINITIONS.map(clone);
}
