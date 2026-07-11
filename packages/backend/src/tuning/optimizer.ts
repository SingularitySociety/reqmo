import {
  diffParameterValues,
  normalizeParameterValue,
  parameterValuesFromProfile,
  profileFromParameterValues,
  tunableParameters
} from "./parameterSpace.ts";

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value ?? "reqmo-tuning")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function candidateSignature(values, definitions) {
  return definitions.map((definition) => `${definition.path}=${values[definition.path]}`).join("|");
}

function metricsForSelection(evaluation) {
  const training = evaluation?.partitions?.TRAIN;
  return training?.totalBookings ? training : evaluation?.metrics;
}

function compareEvaluations(left, right) {
  const leftMetrics = metricsForSelection(left.evaluation);
  const rightMetrics = metricsForSelection(right.evaluation);
  if (leftMetrics.hardViolationCount !== rightMetrics.hardViolationCount) {
    return leftMetrics.hardViolationCount - rightMetrics.hardViolationCount;
  }
  if (leftMetrics.rejectedBookings !== rightMetrics.rejectedBookings) {
    return leftMetrics.rejectedBookings - rightMetrics.rejectedBookings;
  }
  if (leftMetrics.objectiveScore !== rightMetrics.objectiveScore) {
    return leftMetrics.objectiveScore - rightMetrics.objectiveScore;
  }
  return left.index - right.index;
}

function explorationValues({ baseValues, definitions, trialCount, random }) {
  const numericBins = new Map();
  for (const definition of definitions) {
    if (definition.type === "categorical") {
      continue;
    }
    numericBins.set(
      definition.path,
      shuffle(Array.from({ length: trialCount }, (_, index) => index), random)
    );
  }

  return Array.from({ length: trialCount }, (_, trialIndex) => {
    const values = { ...baseValues };
    for (const definition of definitions) {
      if (definition.type === "categorical") {
        const offset = Math.floor(random() * definition.values.length);
        values[definition.path] = definition.values[(trialIndex + offset) % definition.values.length];
        continue;
      }
      const bin = numericBins.get(definition.path)[trialIndex];
      const ratio = (bin + random()) / trialCount;
      const raw = definition.min + ratio * (definition.max - definition.min);
      values[definition.path] = normalizeParameterValue(definition, raw);
    }
    return values;
  });
}

function localValues({ bestValues, definitions, remaining, seen }) {
  const candidates = [];
  const scales = [4, 2, 1, 0.5];
  for (const scale of scales) {
    for (const definition of definitions) {
      if (candidates.length >= remaining) {
        return candidates;
      }
      if (definition.type === "categorical") {
        for (const value of definition.values) {
          const candidate = { ...bestValues, [definition.path]: value };
          const signature = candidateSignature(candidate, definitions);
          if (!seen.has(signature)) {
            seen.add(signature);
            candidates.push(candidate);
          }
        }
        continue;
      }
      const step = Math.max(Number(definition.step) || 0, (definition.max - definition.min) / 20);
      for (const direction of [-1, 1]) {
        const candidate = {
          ...bestValues,
          [definition.path]: normalizeParameterValue(
            definition,
            Number(bestValues[definition.path]) + direction * step * scale
          )
        };
        const signature = candidateSignature(candidate, definitions);
        if (!seen.has(signature)) {
          seen.add(signature);
          candidates.push(candidate);
        }
        if (candidates.length >= remaining) {
          return candidates;
        }
      }
    }
  }
  return candidates;
}

function recommendationEligibility(baseline, candidate, evaluationPolicy = {}) {
  const baselineTrain = metricsForSelection(baseline);
  const candidateTrain = metricsForSelection(candidate);
  const baselineHoldout = baseline?.partitions?.HOLDOUT;
  const candidateHoldout = candidate?.partitions?.HOLDOUT;
  const tolerance = Number(evaluationPolicy.holdoutRegressionTolerance ?? 0.02);
  const hasHoldout = Boolean(baselineHoldout?.totalBookings);
  const trainingImproved =
    candidateTrain.hardViolationCount <= baselineTrain.hardViolationCount &&
    candidateTrain.rejectedBookings <= baselineTrain.rejectedBookings &&
    candidateTrain.objectiveScore < baselineTrain.objectiveScore - 1e-6;
  const holdoutSafe =
    !hasHoldout ||
    (candidateHoldout.hardViolationCount <= baselineHoldout.hardViolationCount &&
      candidateHoldout.rejectedBookings <= baselineHoldout.rejectedBookings &&
      candidateHoldout.objectiveScore <=
        baselineHoldout.objectiveScore * (1 + Math.max(0, tolerance)) + 1e-6);
  const warnings = [];
  if (!trainingImproved) {
    warnings.push("学習用シナリオで明確な改善が確認できませんでした。");
  }
  if (!holdoutSafe) {
    warnings.push("検証用シナリオで許容範囲を超える悪化がありました。");
  }
  if (!hasHoldout) {
    warnings.push("検証用(HOLDOUT)シナリオがないため、過学習を十分に確認できません。");
  }
  return {
    eligible: trainingImproved && holdoutSafe,
    trainingImproved,
    holdoutSafe,
    hasHoldout,
    warnings
  };
}

export async function runParameterSearch({
  baseProfile,
  parameterSpace,
  maxTrials = 24,
  seed = "reqmo-tuning",
  evaluate,
  onTrial = null,
  evaluationPolicy = {}
}) {
  const definitions = tunableParameters(parameterSpace);
  const normalizedMaxTrials = Math.min(Math.max(Math.trunc(Number(maxTrials) || 24), 1), 100);
  const baseValues = parameterValuesFromProfile(baseProfile, parameterSpace);
  const seen = new Set();
  const trials = [];

  const evaluateValues = async (values, phase) => {
    const profile = profileFromParameterValues(baseProfile, parameterSpace, values);
    const evaluation = await evaluate(profile);
    const trial = {
      index: trials.length,
      phase,
      values: parameterValuesFromProfile(profile, parameterSpace),
      profile,
      evaluation
    };
    trials.push(trial);
    if (typeof onTrial === "function") {
      await onTrial(trial);
    }
    return trial;
  };

  seen.add(candidateSignature(baseValues, definitions));
  const baselineTrial = await evaluateValues(baseValues, "BASELINE");
  if (!definitions.length || normalizedMaxTrials === 1) {
    return {
      baselineTrial,
      bestTrial: baselineTrial,
      trials,
      eligibility: {
        eligible: false,
        trainingImproved: false,
        holdoutSafe: true,
        hasHoldout: Boolean(baselineTrial.evaluation?.partitions?.HOLDOUT?.totalBookings),
        warnings: ["調整可能なパラメータがありません。"]
      },
      diff: []
    };
  }

  const random = createRandom(seed);
  const explorationCount = Math.min(
    Math.max(1, Math.floor((normalizedMaxTrials - 1) * 0.7)),
    normalizedMaxTrials - 1
  );
  const explorations = explorationValues({
    baseValues,
    definitions,
    trialCount: explorationCount,
    random
  });
  for (const values of explorations) {
    if (trials.length >= normalizedMaxTrials) break;
    const signature = candidateSignature(values, definitions);
    if (seen.has(signature)) continue;
    seen.add(signature);
    await evaluateValues(values, "EXPLORATION");
  }

  let bestTrial = [...trials].sort(compareEvaluations)[0];
  const locals = localValues({
    bestValues: bestTrial.values,
    definitions,
    remaining: normalizedMaxTrials - trials.length,
    seen
  });
  for (const values of locals) {
    if (trials.length >= normalizedMaxTrials) break;
    await evaluateValues(values, "LOCAL_REFINEMENT");
  }
  bestTrial = [...trials].sort(compareEvaluations)[0];
  const eligibility = recommendationEligibility(
    baselineTrial.evaluation,
    bestTrial.evaluation,
    evaluationPolicy
  );

  return {
    baselineTrial,
    bestTrial,
    trials,
    eligibility,
    diff: diffParameterValues(baseProfile, bestTrial.profile, parameterSpace)
  };
}
