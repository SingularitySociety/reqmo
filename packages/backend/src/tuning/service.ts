import { createParameterSpace, validateCandidateProfile } from "./parameterSpace.ts";
import { defaultEvaluationPolicy } from "./evaluator.ts";
import { runParameterSearch } from "./optimizer.ts";
import {
  buildFrozenTravelMatrices,
  expandScenarioBooking,
  runScenarioSuite,
  snapshotRepositoryForTuning
} from "./scenarioRunner.ts";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeScenarioSuiteInput(repository, input = {}) {
  const now = new Date().toISOString();
  const initialState = input.initialState && typeof input.initialState === "object"
    ? clone(input.initialState)
    : snapshotRepositoryForTuning(repository);
  const scenarios = (Array.isArray(input.scenarios) ? input.scenarios : []).map(
    (scenario, index) => ({
      ...clone(scenario),
      id: normalizeId(scenario?.id) || `scenario_${index + 1}`,
      name: normalizeId(scenario?.name) || `シナリオ ${index + 1}`,
      partition:
        String(scenario?.partition ?? "TRAIN").trim().toUpperCase() === "HOLDOUT"
          ? "HOLDOUT"
          : "TRAIN",
      bookings: (Array.isArray(scenario?.bookings) ? scenario.bookings : []).map(
        (booking, bookingIndex) => ({
          ...clone(booking),
          id: normalizeId(booking?.id) || `booking_${bookingIndex + 1}`,
          at: booking?.at ?? booking?.evaluationNowAt ?? now
        })
      )
    })
  );
  if (!scenarios.length || scenarios.some((scenario) => !scenario.bookings.length)) {
    throw new Error("Scenario suite requires at least one scenario with bookings");
  }
  for (const scenario of scenarios) {
    scenario.bookings.forEach((booking, bookingIndex) => {
      expandScenarioBooking(booking, bookingIndex);
    });
  }
  return {
    ...clone(input),
    id: normalizeId(input.id) || undefined,
    name: normalizeId(input.name) || "配車チューニングシナリオ",
    description: normalizeId(input.description),
    initialState,
    scenarios,
    defaultExpectations:
      input.defaultExpectations && typeof input.defaultExpectations === "object"
        ? clone(input.defaultExpectations)
        : {},
    evaluationPolicy: {
      ...defaultEvaluationPolicy(),
      ...(input.evaluationPolicy ?? {}),
      weights: {
        ...defaultEvaluationPolicy().weights,
        ...(input.evaluationPolicy?.weights ?? {})
      }
    },
    status: input.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE"
  };
}

export function createTuningScenarioSuite({ repository, input }) {
  if (typeof repository?.setTuningScenarioSuite !== "function") {
    throw new Error("Repository does not support tuning scenario suites");
  }
  return repository.setTuningScenarioSuite(normalizeScenarioSuiteInput(repository, input));
}

function compactTrial(runId, trial) {
  return {
    runId,
    index: trial.index,
    phase: trial.phase,
    values: trial.values,
    metrics: trial.evaluation.metrics,
    partitions: trial.evaluation.partitions,
    scenarioSummaries: trial.evaluation.scenarioResults.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      partition: scenario.partition,
      metrics: scenario.metrics,
      violationCount: scenario.outcomes.reduce(
        (sum, outcome) => sum + outcome.metrics.violations.length,
        0
      )
    }))
  };
}

function compactDispatchDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return null;
  return {
    summary: typeof diagnostics.summary === "string" ? diagnostics.summary : null,
    totalVehicleCount: Number.isFinite(Number(diagnostics.totalVehicleCount))
      ? Number(diagnostics.totalVehicleCount)
      : null,
    inspectedVehicleCount: Number.isFinite(Number(diagnostics.inspectedVehicleCount))
      ? Number(diagnostics.inspectedVehicleCount)
      : null,
    activeVehicleCount: Number.isFinite(Number(diagnostics.activeVehicleCount))
      ? Number(diagnostics.activeVehicleCount)
      : null,
    candidateCount: Number.isFinite(Number(diagnostics.candidateCount))
      ? Number(diagnostics.candidateCount)
      : null,
    feasibleCount: Number.isFinite(Number(diagnostics.feasibleCount))
      ? Number(diagnostics.feasibleCount)
      : null,
    rejectionCounts: clone(diagnostics.rejectionCounts ?? {}),
    constraints: clone(diagnostics.constraints ?? {}),
    observed: clone(diagnostics.observed ?? {}),
    details: clone(diagnostics.details ?? null),
    breakdown: (Array.isArray(diagnostics.breakdown) ? diagnostics.breakdown : [])
      .slice(0, 12)
      .map((entry) => ({
        code: entry?.code ?? "UNKNOWN",
        count: Number(entry?.count) || 0,
        ratioPercent: Number.isFinite(Number(entry?.ratioPercent))
          ? Number(entry.ratioPercent)
          : null
      })),
    countermeasureCandidates: (Array.isArray(diagnostics.countermeasureCandidates)
      ? diagnostics.countermeasureCandidates
      : [])
      .filter((entry) => typeof entry === "string" && entry.trim())
      .slice(0, 6),
    perVehicle: (Array.isArray(diagnostics.perVehicle) ? diagnostics.perVehicle : [])
      .slice(0, 30)
      .map((entry) => ({
        vehicleId: entry?.vehicleId ?? null,
        vehicleStatus: entry?.vehicleStatus ?? null,
        candidateCount: Number(entry?.candidateCount) || 0,
        feasibleCount: Number(entry?.feasibleCount) || 0,
        rejectionCounts: clone(entry?.rejectionCounts ?? {}),
        minEtaPickupMinutes: Number.isFinite(Number(entry?.minEtaPickupMinutes))
          ? Number(entry.minEtaPickupMinutes)
          : null,
        minDetourMinutes: Number.isFinite(Number(entry?.minDetourMinutes))
          ? Number(entry.minDetourMinutes)
          : null
      }))
  };
}

function compactRecommendationEvaluation(evaluation, maxOutcomes = 200) {
  let outcomeCount = 0;
  let truncated = false;
  const scenarioResults = evaluation.scenarioResults.map((scenario) => {
    const outcomes = [];
    for (const outcome of scenario.outcomes) {
      if (outcomeCount >= maxOutcomes) {
        truncated = true;
        break;
      }
      outcomeCount += 1;
      outcomes.push({
        bookingId: outcome.bookingId,
        parentBookingId: outcome.parentBookingId ?? outcome.bookingId,
        passengerGroupId: outcome.passengerGroupId ?? null,
        partySize: outcome.partySize ?? null,
        rideRequestId: outcome.rideRequestId ?? null,
        status: outcome.status,
        reason: outcome.reason,
        selectedVehicleId: outcome.selectedVehicleId,
        vehicleStartPoint:
          Number.isFinite(Number(outcome?.vehicleStartPoint?.lat)) &&
          Number.isFinite(Number(outcome?.vehicleStartPoint?.lng))
            ? {
                lat: Number(outcome.vehicleStartPoint.lat),
                lng: Number(outcome.vehicleStartPoint.lng)
              }
            : null,
        plannedPickupAt: outcome.plannedPickupAt,
        plannedDropoffAt: outcome.plannedDropoffAt,
        selectedAlgorithm: outcome.selectedAlgorithm,
        groupIntegrity: outcome.groupIntegrity ?? null,
        diagnostics: compactDispatchDiagnostics(outcome.diagnostics),
        metrics: outcome.metrics,
        routeAfter: (outcome.routeAfter ?? []).map((task) => ({
          type: task.type,
          requestId: task.requestId,
          requestLabel: task.requestLabel ?? null,
          locationLabel: task.locationLabel ?? task.stopName ?? null,
          etaMinutes: Number.isFinite(Number(task?.etaMinutes)) ? Number(task.etaMinutes) : null,
          etaAt: task?.etaAt ?? null,
          loadChange: Number.isFinite(Number(task?.loadChange)) ? Number(task.loadChange) : null,
          point:
            Number.isFinite(Number(task?.point?.lat)) &&
            Number.isFinite(Number(task?.point?.lng))
              ? { lat: Number(task.point.lat), lng: Number(task.point.lng) }
              : null
        }))
      });
    }
    return {
      scenarioId: scenario.scenarioId,
      name: scenario.name,
      partition: scenario.partition,
      routingSource: scenario.routingSource,
      metrics: scenario.metrics,
      outcomes
    };
  });
  return {
    metrics: evaluation.metrics,
    partitions: evaluation.partitions,
    scenarioResults,
    truncated
  };
}

export async function previewTuningScenarioSuite({
  repository,
  input,
  baseProfileId,
  routing = {}
}) {
  const baseProfile = repository.getServiceProfile(baseProfileId);
  if (!baseProfile) {
    throw new Error("Base service profile not found");
  }
  const suite = normalizeScenarioSuiteInput(repository, input);
  const frozenTravelMatrices = await buildFrozenTravelMatrices({
    suite,
    baseProfile,
    routing
  });
  const evaluation = await runScenarioSuite({
    suite,
    candidateProfile: baseProfile,
    frozenTravelMatrices,
    evaluationPolicy: suite.evaluationPolicy
  });
  return {
    profileId: baseProfile.id,
    profileName: baseProfile.name ?? baseProfile.id,
    generatedAt: new Date().toISOString(),
    evaluation: compactRecommendationEvaluation(evaluation)
  };
}

function buildCandidateProfile(baseProfile, bestProfile, runId) {
  const stamp = runId.replace(/[^A-Za-z0-9_-]/g, "_");
  return {
    ...clone(bestProfile),
    id: `${baseProfile.id}__tuned_${stamp}`,
    name: `${baseProfile.name ?? baseProfile.id} / AI tuning`,
    tuningMeta: {
      sourceProfileId: baseProfile.id,
      tuningRunId: runId,
      generatedAt: new Date().toISOString()
    }
  };
}

function resultSummary(search) {
  const baseline = search.baselineTrial.evaluation.metrics;
  const candidate = search.bestTrial.evaluation.metrics;
  return {
    baselineObjectiveScore: baseline.objectiveScore,
    candidateObjectiveScore: candidate.objectiveScore,
    objectiveDelta: Number((candidate.objectiveScore - baseline.objectiveScore).toFixed(6)),
    baselineHardViolations: baseline.hardViolationCount,
    candidateHardViolations: candidate.hardViolationCount,
    baselineRejectedBookings: baseline.rejectedBookings,
    candidateRejectedBookings: candidate.rejectedBookings
  };
}

function buildRecommendationExplanation(search) {
  const summary = resultSummary(search);
  const points = [];
  if (summary.candidateHardViolations < summary.baselineHardViolations) {
    points.push(
      `制約違反を${summary.baselineHardViolations}件から${summary.candidateHardViolations}件へ削減しました。`
    );
  }
  if (summary.candidateRejectedBookings < summary.baselineRejectedBookings) {
    points.push(
      `配車不能を${summary.baselineRejectedBookings}件から${summary.candidateRejectedBookings}件へ削減しました。`
    );
  }
  if (summary.objectiveDelta < 0) {
    points.push(`外部KPIの総合評価を${Math.abs(summary.objectiveDelta).toFixed(2)}改善しました。`);
  }
  for (const diff of search.diff) {
    points.push(`${diff.path} を ${diff.before} から ${diff.after} へ変更します。`);
  }
  if (!points.length) {
    points.push("基準プロファイルを上回る候補は確認できませんでした。");
  }
  return {
    headline: search.eligibility.eligible
      ? "TRAINとHOLDOUTの双方で安全性を維持した改善候補です。"
      : "自動適用条件を満たしていないため、追加シナリオまたは手動確認が必要です。",
    points
  };
}

export async function executeTuningRun({
  repository,
  scenarioSuiteId,
  baseProfileId,
  parameterSpace: requestedParameterSpace = null,
  maxTrials = 24,
  seed = null,
  routing = {},
  actor = "tuning-operator"
}) {
  const suite = repository.getTuningScenarioSuite(scenarioSuiteId);
  if (!suite || suite.status === "ARCHIVED") {
    throw new Error("Tuning scenario suite not found");
  }
  const baseProfile = repository.getServiceProfile(baseProfileId);
  if (!baseProfile) {
    throw new Error("Base service profile not found");
  }
  const parameterSpace = createParameterSpace(baseProfile, requestedParameterSpace);
  const evaluationPolicy = suite.evaluationPolicy ?? defaultEvaluationPolicy();
  let run = repository.setTuningRun({
    scenarioSuiteId: suite.id,
    baseProfileId: baseProfile.id,
    status: "RUNNING",
    progress: { completedTrials: 0, maxTrials: Number(maxTrials) || 24 },
    parameterSpace,
    seed: seed ?? `${suite.id}:${baseProfile.id}`,
    actor,
    startedAt: new Date().toISOString()
  });

  try {
    const frozenTravelMatrices = await buildFrozenTravelMatrices({
      suite,
      baseProfile,
      routing
    });
    const search = await runParameterSearch({
      baseProfile,
      parameterSpace,
      maxTrials,
      seed: run.seed,
      evaluationPolicy,
      evaluate: (profile) =>
        runScenarioSuite({
          suite,
          candidateProfile: profile,
          frozenTravelMatrices,
          evaluationPolicy
        }),
      onTrial: async (trial) => {
        repository.setTuningTrial(compactTrial(run.id, trial));
        run = repository.setTuningRun({
          ...run,
          progress: {
            ...run.progress,
            completedTrials: trial.index + 1
          }
        });
      }
    });

    const candidateProfile = buildCandidateProfile(baseProfile, search.bestTrial.profile, run.id);
    const validation = validateCandidateProfile(candidateProfile, parameterSpace);
    if (!validation.ok) {
      throw new Error(`Generated profile is invalid: ${validation.errors.join(", ")}`);
    }
    const recommendation = repository.setTuningRecommendation({
      runId: run.id,
      scenarioSuiteId: suite.id,
      baseProfileId: baseProfile.id,
      candidateProfile,
      parameterDiff: search.diff,
      eligibility: search.eligibility,
      summary: resultSummary(search),
      explanation: buildRecommendationExplanation(search),
      baselineEvaluation: compactRecommendationEvaluation(search.baselineTrial.evaluation),
      candidateEvaluation: compactRecommendationEvaluation(search.bestTrial.evaluation),
      status: search.diff.length ? "PENDING" : "NO_CHANGE"
    });
    const profileVersion = repository.setServiceProfileVersion({
      profileId: candidateProfile.id,
      sourceProfileId: baseProfile.id,
      recommendationId: recommendation.id,
      runId: run.id,
      status: "DRAFT",
      profile: candidateProfile,
      createdBy: actor
    });
    const persistedRecommendation = repository.setTuningRecommendation({
      ...recommendation,
      profileVersionId: profileVersion.id
    });
    run = repository.setTuningRun({
      ...run,
      status: "COMPLETED",
      completedAt: new Date().toISOString(),
      progress: {
        ...run.progress,
        completedTrials: search.trials.length,
        maxTrials: search.trials.length
      },
      recommendationId: persistedRecommendation.id,
      summary: persistedRecommendation.summary
    });
    repository.saveAuditLog({
      actor,
      action: "TUNING_RUN_COMPLETED",
      targetType: "tuningRun",
      targetId: run.id,
      after: {
        recommendationId: persistedRecommendation.id,
        eligibility: persistedRecommendation.eligibility,
        summary: persistedRecommendation.summary
      }
    });
    return {
      run,
      recommendation: persistedRecommendation,
      trials: repository.listTuningTrials(run.id)
    };
  } catch (error) {
    run = repository.setTuningRun({
      ...run,
      status: "FAILED",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function archiveActiveVersions(repository, exceptVersionId = null) {
  for (const version of repository.listServiceProfileVersions()) {
    if (version.status === "ACTIVE" && version.id !== exceptVersionId) {
      repository.setServiceProfileVersion({
        ...version,
        status: "ARCHIVED",
        archivedAt: new Date().toISOString()
      });
    }
  }
}

function ensureHistoricalVersion(repository, profile, actor) {
  if (!profile) return null;
  const existing = repository
    .listServiceProfileVersions()
    .find((version) => version.profileId === profile.id && version.status === "ACTIVE");
  if (existing) return existing;
  return repository.setServiceProfileVersion({
    profileId: profile.id,
    sourceProfileId: profile.id,
    status: "ACTIVE",
    profile: clone(profile),
    createdBy: actor,
    activatedAt: new Date().toISOString(),
    reason: "INITIAL_ACTIVE_PROFILE_SNAPSHOT"
  });
}

export function ensureActiveServiceProfileVersion({
  repository,
  profileId,
  actor = "system"
}) {
  const profile = repository.getServiceProfile(profileId);
  if (!profile || profile.id !== profileId) {
    return null;
  }
  const version = ensureHistoricalVersion(repository, profile, actor);
  const config = repository.getSystemConfig("dispatch") ?? { id: "dispatch" };
  if (!config.activeServiceProfileVersionId && version) {
    repository.setSystemConfig({
      ...config,
      id: "dispatch",
      activeServiceProfileId: profile.id,
      activeServiceProfileVersionId: version.id
    });
  }
  return version;
}

function activateVersion(repository, version, actor, reason) {
  const currentConfig = repository.getSystemConfig("dispatch") ?? {};
  const currentProfileId = currentConfig.activeServiceProfileId;
  const currentProfile = currentProfileId ? repository.getServiceProfile(currentProfileId) : null;
  ensureHistoricalVersion(repository, currentProfile, actor);
  archiveActiveVersions(repository, version.id);
  repository.setServiceProfile(version.profile);
  const activeVersion = repository.setServiceProfileVersion({
    ...version,
    status: "ACTIVE",
    activatedAt: new Date().toISOString(),
    activatedBy: actor,
    activationReason: reason
  });
  repository.setSystemConfig({
    id: "dispatch",
    activeServiceProfileId: version.profile.id,
    activeServiceProfileVersionId: activeVersion.id,
    pendingServiceProfileId: null,
    pendingServiceProfileVersionId: null,
    pendingEffectiveAt: null
  });
  return activeVersion;
}

export function approveTuningRecommendation({
  repository,
  recommendationId,
  actor = "tuning-operator",
  force = false,
  activateAt = null
}) {
  const recommendation = repository.getTuningRecommendation(recommendationId);
  if (!recommendation) {
    throw new Error("Tuning recommendation not found");
  }
  if (recommendation.status !== "PENDING") {
    throw new Error("Tuning recommendation is not pending approval");
  }
  if (!recommendation.parameterDiff?.length) {
    throw new Error("Tuning recommendation does not contain parameter changes");
  }
  if (!recommendation.eligibility?.eligible && force !== true) {
    throw new Error("Recommendation is not eligible for activation without force approval");
  }
  const version = repository.getServiceProfileVersion(recommendation.profileVersionId);
  if (!version) {
    throw new Error("Candidate service profile version not found");
  }
  const effectiveDate = activateAt ? new Date(activateAt) : new Date();
  if (Number.isNaN(effectiveDate.getTime())) {
    throw new Error("activateAt must be a valid ISO datetime");
  }
  const scheduled = effectiveDate.getTime() > Date.now() + 1000;
  let nextVersion;
  if (scheduled) {
    repository.setServiceProfile(version.profile);
    nextVersion = repository.setServiceProfileVersion({
      ...version,
      status: "APPROVED",
      approvedAt: new Date().toISOString(),
      approvedBy: actor,
      effectiveFrom: effectiveDate.toISOString()
    });
    const currentConfig = repository.getSystemConfig("dispatch") ?? { id: "dispatch" };
    repository.setSystemConfig({
      ...currentConfig,
      id: "dispatch",
      pendingServiceProfileId: version.profile.id,
      pendingServiceProfileVersionId: version.id,
      pendingEffectiveAt: effectiveDate.toISOString()
    });
  } else {
    nextVersion = activateVersion(repository, version, actor, "TUNING_RECOMMENDATION_APPROVED");
  }
  const nextRecommendation = repository.setTuningRecommendation({
    ...recommendation,
    status: scheduled ? "APPROVED" : "ACTIVE",
    approvedAt: new Date().toISOString(),
    approvedBy: actor,
    effectiveFrom: effectiveDate.toISOString()
  });
  repository.saveAuditLog({
    actor,
    action: scheduled ? "SERVICE_PROFILE_ACTIVATION_SCHEDULED" : "SERVICE_PROFILE_ACTIVATED",
    targetType: "serviceProfileVersion",
    targetId: nextVersion.id,
    before: { profileId: recommendation.baseProfileId },
    after: { profileId: nextVersion.profileId, effectiveFrom: effectiveDate.toISOString() },
    reason: "TUNING_RECOMMENDATION_APPROVED"
  });
  return {
    status: scheduled ? "SCHEDULED" : "ACTIVE",
    recommendation: nextRecommendation,
    version: nextVersion,
    activeServiceProfileId: scheduled
      ? repository.getSystemConfig("dispatch")?.activeServiceProfileId ?? null
      : nextVersion.profileId
  };
}

export function activatePendingServiceProfileIfDue({ repository, actor = "system" }) {
  const config = repository.getSystemConfig("dispatch");
  if (!config?.pendingServiceProfileVersionId || !config.pendingEffectiveAt) {
    return null;
  }
  const effectiveAt = new Date(config.pendingEffectiveAt);
  if (Number.isNaN(effectiveAt.getTime()) || effectiveAt.getTime() > Date.now()) {
    return null;
  }
  const version = repository.getServiceProfileVersion(config.pendingServiceProfileVersionId);
  if (!version) {
    return null;
  }
  const activeVersion = activateVersion(repository, version, actor, "SCHEDULED_ACTIVATION");
  repository.saveAuditLog({
    actor,
    action: "SCHEDULED_SERVICE_PROFILE_ACTIVATED",
    targetType: "serviceProfileVersion",
    targetId: activeVersion.id,
    after: { profileId: activeVersion.profileId }
  });
  return activeVersion;
}

export function rollbackServiceProfile({
  repository,
  versionId = null,
  profileId = null,
  actor = "tuning-operator",
  reason = "OPERATOR_ROLLBACK"
}) {
  const versions = repository.listServiceProfileVersions();
  const version = versionId
    ? versions.find((entry) => entry.id === versionId)
    : versions
        .filter((entry) => entry.profileId === profileId)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  if (!version?.profile) {
    throw new Error("Rollback service profile version not found");
  }
  if (version.status !== "ARCHIVED" && version.status !== "ACTIVE") {
    throw new Error("Only archived service profile versions can be used for rollback");
  }
  const before = repository.getSystemConfig("dispatch")?.activeServiceProfileId ?? null;
  const activeVersion = activateVersion(repository, version, actor, reason);
  repository.saveAuditLog({
    actor,
    action: "SERVICE_PROFILE_ROLLED_BACK",
    targetType: "serviceProfileVersion",
    targetId: activeVersion.id,
    before: { profileId: before },
    after: { profileId: activeVersion.profileId },
    reason
  });
  return {
    status: "ROLLED_BACK",
    activeServiceProfileId: activeVersion.profileId,
    version: activeVersion
  };
}
