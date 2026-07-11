import { GraphAI, agentInfoWrapper } from "graphai";
import { geminiAgent } from "@graphai/gemini_agent";

const FEEDBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: ["string", "null"] },
    expectations: {
      type: "object",
      additionalProperties: false,
      properties: {
        mustAssign: { type: ["boolean", "null"] },
        preferredVehicleId: { type: ["string", "null"] },
        preferredVehicleRequired: { type: ["boolean", "null"] },
        maxPickupWaitMinutes: { type: ["number", "null"] },
        maxExistingPassengerDelayMinutes: { type: ["number", "null"] },
        maxDesiredTimeDeviationMinutes: { type: ["number", "null"] },
        dropoffExistingPassengersBeforeNewPickup: { type: ["boolean", "null"] },
        maxConsecutivePickups: { type: ["number", "null"] }
      }
    }
  },
  required: ["summary", "expectations"]
};

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function redactSensitiveText(value) {
  return normalizeText(value)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
    .replace(/(?:\+?81[-\s]?)?0?\d{1,4}[-\s]?\d{2,4}[-\s]?\d{3,4}/g, "[PHONE]");
}

function finitePositive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function cleanExpectations(value, { allowZero = false } = {}) {
  const input = value && typeof value === "object" ? value : {};
  const output = {};
  for (const key of [
    "mustAssign",
    "preferredVehicleRequired",
    "dropoffExistingPassengersBeforeNewPickup"
  ]) {
    if (typeof input[key] === "boolean") {
      output[key] = input[key];
    }
  }
  if (normalizeText(input.preferredVehicleId)) {
    output.preferredVehicleId = normalizeText(input.preferredVehicleId);
  }
  for (const key of [
    "maxPickupWaitMinutes",
    "maxExistingPassengerDelayMinutes",
    "maxDesiredTimeDeviationMinutes",
    "maxConsecutivePickups"
  ]) {
    const numeric = finitePositive(input[key]);
    if (numeric !== null && (numeric > 0 || allowZero)) {
      output[key] = numeric;
    }
  }
  return output;
}

function parseJsonLoose(value) {
  const text = normalizeText(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function resolveVehicleId(token, vehicles = []) {
  const normalized = normalizeText(token);
  if (!normalized) return null;
  const exact = vehicles.find(
    (vehicle) => vehicle?.id === normalized || normalizeText(vehicle?.name) === normalized
  );
  if (exact?.id) return exact.id;
  const partial = vehicles.find((vehicle) =>
    [vehicle?.id, vehicle?.name]
      .map(normalizeText)
      .some((value) => value && (value.includes(normalized) || normalized.includes(value)))
  );
  return partial?.id ?? null;
}

function extractNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numeric = finitePositive(match[1]);
      if (numeric !== null) return numeric;
    }
  }
  return null;
}

function ruleBasedInterpretation(text, context = {}) {
  const expectations = {};
  const maxPickupWait = extractNumber(text, [
    /(?:待ち時間|乗車待ち|迎車|迎え)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*分/,
    /(\d+(?:\.\d+)?)\s*分以内[^。]*(?:迎え|乗車|待ち)/
  ]);
  const maxExistingDelay = extractNumber(text, [
    /(?:既存|乗車中|先客|すでに乗っている)[^0-9]{0,18}(\d+(?:\.\d+)?)\s*分/,
    /(\d+(?:\.\d+)?)\s*分以内[^。]*(?:遅延|遅れ|迂回)/
  ]);
  const maxDeviation = extractNumber(text, [
    /(?:希望時刻|予約時刻|到着時刻)[^0-9]{0,18}(\d+(?:\.\d+)?)\s*分/,
    /(\d+(?:\.\d+)?)\s*分以内[^。]*(?:希望|予約|到着)/
  ]);
  if (maxPickupWait !== null) expectations.maxPickupWaitMinutes = maxPickupWait;
  if (maxExistingDelay !== null) {
    expectations.maxExistingPassengerDelayMinutes = maxExistingDelay;
  }
  if (maxDeviation !== null) expectations.maxDesiredTimeDeviationMinutes = maxDeviation;

  const vehicleMatch = text.match(/(?:車両|バス)?\s*([A-Za-z0-9_-]+)\s*(?:号車|車)/i);
  if (vehicleMatch) {
    const preferredVehicleId = resolveVehicleId(vehicleMatch[1], context.vehicles ?? []);
    if (preferredVehicleId) {
      expectations.preferredVehicleId = preferredVehicleId;
      expectations.preferredVehicleRequired = /必ず|絶対|固定|限定/.test(text);
    }
  }
  if (/配車できるよう|受け付けて|必ず[^。]{0,12}配車|配車して|配車し/.test(text)) {
    expectations.mustAssign = true;
  }
  if (/(?:乗っている|乗車中|既存|先客)[^。]{0,20}(?:先に|先行)[^。]{0,10}(?:降ろ|降車)/.test(text) ||
      /(?:先に|先行)[^。]{0,12}(?:既存|先客|乗車中)[^。]{0,10}(?:降ろ|降車)/.test(text)) {
    expectations.dropoffExistingPassengersBeforeNewPickup = true;
  }
  const maxConsecutivePickups = extractNumber(text, [
    /(?:連続乗車|連続する乗車)[^0-9]{0,12}(\d+)\s*(?:回|件)/
  ]);
  if (maxConsecutivePickups !== null) {
    expectations.maxConsecutivePickups = maxConsecutivePickups;
  }

  const keys = Object.keys(expectations);
  return {
    summary: keys.length
      ? `運行上の期待条件を${keys.length}項目抽出しました。`
      : "数値または対象車両を特定できませんでした。内容を確認して手動で補足してください。",
    expectations,
    warnings: keys.length ? [] : ["具体的な時間上限や車両名を含めると精度が上がります。"]
  };
}

function resolveConfig(env = process.env) {
  const enabled = normalizeText(env.TUNING_LLM_ENABLED || "true").toLowerCase() !== "false";
  const apiKey = normalizeText(env.TUNING_LLM_API_KEY || env.GOOGLE_GENAI_API_KEY);
  return {
    available: enabled && Boolean(apiKey),
    apiKey,
    model: normalizeText(env.TUNING_LLM_MODEL) || "gemini-3.1-flash-lite"
  };
}

async function runLlm({ text, context, config }) {
  if (!config.available) return null;
  const safeVehicles = (context?.vehicles ?? []).slice(0, 100).map((vehicle) => ({
    id: vehicle?.id,
    name: vehicle?.name ?? null
  }));
  const prompt = [
    "あなたはオンデマンド配車のチューニング要望を評価条件へ変換する解析器です。",
    "必ずJSONだけを返し、推測できない値はnullにしてください。",
    "要望に明記されていない数値項目は必ずnullにし、推測で0を入れないでください。",
    "パラメータ値そのものは提案せず、期待する配車結果だけを抽出してください。",
    "preferredVehicleIdは候補車両のidから選び、断定できない場合はnullにしてください。",
    `候補車両: ${JSON.stringify(safeVehicles)}`,
    `要望: ${redactSensitiveText(text)}`
  ].join("\n");

  const parseAgent = agentInfoWrapper(async ({ namedInputs }) =>
    parseJsonLoose(namedInputs?.text) ?? {}
  );
  const graph = new GraphAI(
    {
      version: 0.5,
      nodes: {
        prompt: { value: prompt },
        llm: {
          agent: "geminiAgent",
          params: {
            model: config.model,
            temperature: 0,
            response_format: {
              type: "json_schema",
              json_schema: { schema: FEEDBACK_SCHEMA }
            }
          },
          inputs: { prompt: ":prompt" }
        },
        parsed: {
          agent: "parseAgent",
          inputs: { text: ":llm.text" },
          isResult: true
        }
      }
    },
    { geminiAgent, parseAgent },
    { config: { geminiAgent: { apiKey: config.apiKey } } }
  );
  const result = await graph.run();
  return result?.parsed && typeof result.parsed === "object" ? result.parsed : null;
}

export async function interpretTuningFeedback({ text, context = {}, env = process.env }) {
  const normalized = normalizeText(text);
  if (!normalized) {
    throw new Error("Feedback text is required");
  }
  const fallback = ruleBasedInterpretation(normalized, context);
  const config = resolveConfig(env);
  let llmResult = null;
  try {
    llmResult = await runLlm({ text: normalized, context, config });
  } catch {
    llmResult = null;
  }
  const llmExpectations = cleanExpectations(llmResult?.expectations, {
    allowZero: /(?:^|\D)0(?:\D|$)|ゼロ|なし|させない|許容しない/.test(normalized)
  });
  const expectations = Object.keys(llmExpectations).length
    ? { ...fallback.expectations, ...llmExpectations }
    : fallback.expectations;
  return {
    source: Object.keys(llmExpectations).length ? "GEMINI" : "RULES",
    summary: normalizeText(llmResult?.summary) || fallback.summary,
    expectations,
    requiresConfirmation: true,
    warnings: fallback.warnings
  };
}
