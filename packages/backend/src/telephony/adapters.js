import { ADAPTER_TYPES } from "../../../shared/src/constants.js";

function readFirst(payload, keys) {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && `${payload[key]}`.length > 0) {
      return `${payload[key]}`;
    }
  }
  return null;
}

function parseSerialComRawLine(rawLine) {
  if (!rawLine || typeof rawLine !== "string") {
    return null;
  }
  const candidates = rawLine.match(/(\+?\d[\d\-\s]{8,})/g);
  return candidates?.[0] ?? null;
}

export function normalizeAdapterEvent({ adapterType, payload = {}, provider = "unknown" }) {
  const type = adapterType ?? ADAPTER_TYPES.WEBHOOK;

  const byType = {
    [ADAPTER_TYPES.WEBHOOK]: {
      callerRaw: readFirst(payload, ["from", "caller", "callerNumber", "phone"]),
      receiverNumber: readFirst(payload, ["to", "receiver", "receiverNumber", "did"]),
      ringAt: readFirst(payload, ["ringAt", "timestamp", "createdAt"])
    },
    [ADAPTER_TYPES.SIP]: {
      callerRaw: readFirst(payload, ["caller", "from", "ani", "caller_id"]),
      receiverNumber: readFirst(payload, ["callee", "to", "dnis"]),
      ringAt: readFirst(payload, ["ringAt", "timestamp"]) 
    },
    [ADAPTER_TYPES.CTI]: {
      callerRaw: readFirst(payload, ["ani", "caller", "from"]),
      receiverNumber: readFirst(payload, ["dnis", "to", "queueNumber"]),
      ringAt: readFirst(payload, ["eventTime", "timestamp"])
    },
    [ADAPTER_TYPES.SERIAL_COM]: {
      callerRaw: readFirst(payload, ["caller", "phone", "line"]) ?? parseSerialComRawLine(payload.rawLine),
      receiverNumber: readFirst(payload, ["receiver", "to", "did"]),
      ringAt: readFirst(payload, ["ringAt", "timestamp"])
    }
  };

  const normalized = byType[type];
  if (!normalized) {
    throw new Error(`Unsupported telephony adapter type: ${type}`);
  }

  return {
    provider,
    adapterType: type,
    direction: "INBOUND",
    callerRaw: normalized.callerRaw,
    receiverNumber: normalized.receiverNumber,
    ringAt: normalized.ringAt,
    receivedAt: new Date().toISOString(),
    rawPayload: payload
  };
}
