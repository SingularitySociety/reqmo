import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";

import { createReqmoServer } from "../src/api/server.ts";
import { InMemoryRepository } from "../src/repository/inMemoryRepository.ts";
import { createDefaultServiceProfile } from "../../shared/src/defaults.ts";

function invokeServer({ server, method, url, body = null, rawBody = null, headers = {} }) {
  return new Promise((resolve) => {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.body = body;
    req.rawBody = rawBody;
    req.headers = headers;

    const responseState = {
      statusCode: 0,
      headers: {},
      payload: ""
    };

    const res = {
      setHeader(name, value) {
        responseState.headers[name] = value;
      },
      writeHead(status, responseHeaders = {}) {
        responseState.statusCode = status;
        responseState.headers = {
          ...responseState.headers,
          ...responseHeaders
        };
      },
      end(chunk = "") {
        responseState.payload += String(chunk ?? "");
        resolve(responseState);
      }
    };

    server.emit("request", req, res);
  });
}

function withTemporaryEnv(overrides, run) {
  const backup = new Map();
  Object.entries(overrides).forEach(([key, value]) => {
    backup.set(key, process.env[key]);
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of backup.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

test("line miniapp session returns linked reservations", async () => {
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "中村駅", lat: 32.9898, lng: 132.9334 },
      { id: "stop_b", name: "市役所前", lat: 32.9911, lng: 132.9272 }
    ],
    users: [{ id: "user_line_1", name: "山田 花子" }],
    lineIdentities: [
      {
        id: "line_1",
        lineUserId: "U_line_test_1",
        userId: "user_line_1",
        source: "SEED",
        verified: true,
        displayName: "LINE山田",
        lastSeenAt: "2026-02-20T12:00:00.000Z",
        blockStatus: "ACTIVE"
      }
    ],
    rideRequests: [
      {
        id: "req_1001",
        requesterId: "user_line_1",
        status: "ASSIGNED",
        pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
        dropoff: { mode: "FIXED_STOP", stopId: "stop_b" },
        assignment: {
          plannedPickupAt: "2026-02-25T01:00:00.000Z",
          plannedDropoffAt: "2026-02-25T01:20:00.000Z"
        }
      }
    ],
    serviceProfiles: [createDefaultServiceProfile()]
  });

  const { server } = createReqmoServer({ repository });
  const response = await invokeServer({
    server,
    method: "GET",
    url: "/api/line/miniapp/session?lineUserId=U_line_test_1"
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.status, "OK");
  assert.equal(payload.lineUserId, "U_line_test_1");
  assert.equal(payload.user?.id, "user_line_1");
  assert.equal(Array.isArray(payload.reservations), true);
  assert.equal(payload.reservations.length, 1);
  assert.equal(payload.reservations[0].id, "req_1001");
  assert.equal(typeof payload.summaryText, "string");
});

test("line miniapp phone link can connect phone identity and line identity", async () => {
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "中村駅", lat: 32.9898, lng: 132.9334 },
      { id: "stop_b", name: "市役所前", lat: 32.9911, lng: 132.9272 }
    ],
    users: [{ id: "user_phone_1", name: "電話予約ユーザー" }],
    phoneIdentities: [
      {
        id: "phone_1",
        userId: "user_phone_1",
        normalizedPhoneE164: "+818011112222",
        source: "OPERATOR_REGISTERED",
        verified: true,
        lastSeenAt: "2026-02-21T12:00:00.000Z",
        blockStatus: "ACTIVE"
      }
    ],
    rideRequests: [
      {
        id: "req_2001",
        requesterId: "user_phone_1",
        status: "REQUESTED",
        pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
        dropoff: { mode: "FIXED_STOP", stopId: "stop_b" }
      }
    ],
    serviceProfiles: [createDefaultServiceProfile()]
  });

  const { server } = createReqmoServer({ repository });
  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/line/miniapp/link-phone",
    body: {
      lineUserId: "U_link_target_1",
      phoneNumber: "080-1111-2222"
    }
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.status, "LINKED");
  assert.equal(payload.user?.id, "user_phone_1");
  assert.equal(payload.normalizedPhoneE164, "+818011112222");
  assert.equal(payload.reservations?.length, 1);
  assert.equal(repository.getLineIdentity("U_link_target_1")?.userId, "user_phone_1");
});

test("line miniapp reservation can be created with stop and desired time", async () => {
  const repository = new InMemoryRepository({
    stops: [
      { id: "stop_a", name: "中村駅", lat: 32.9898, lng: 132.9334 },
      { id: "stop_b", name: "市役所前", lat: 32.9911, lng: 132.9272 }
    ],
    vehicles: [
      {
        id: "veh_1",
        status: "ACTIVE",
        capacity: 6,
        onboardCount: 0,
        currentLocation: { lat: 32.9898, lng: 132.9334 },
        route: []
      }
    ],
    serviceProfiles: [createDefaultServiceProfile()]
  });

  const { server } = createReqmoServer({ repository });
  const response = await invokeServer({
    server,
    method: "POST",
    url: "/api/line/miniapp/reservations",
    body: {
      lineUserId: "U_book_target_1",
      displayName: "LINE予約ユーザー",
      pickupStopId: "stop_a",
      dropoffStopId: "stop_b",
      desiredMode: "PICKUP",
      desiredAt: "2026-02-25T01:00:00.000Z"
    }
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.status, "CREATED");
  assert.equal(payload.lineUserId, "U_book_target_1");
  assert.equal(payload.reservation?.pickupLabel, "中村駅");
  assert.equal(payload.reservation?.dropoffLabel, "市役所前");
  assert.equal(typeof payload.reservation?.id, "string");
  assert.equal(payload.reservation?.id.length > 0, true);

  const identity = repository.getLineIdentity("U_book_target_1");
  assert.equal(Boolean(identity?.userId), true);

  const created = repository.listRideRequests();
  assert.equal(created.length, 1);
  assert.equal(created[0].requesterId, identity?.userId ?? null);
  assert.equal(created[0].pickup?.stopId, "stop_a");
  assert.equal(created[0].dropoff?.stopId, "stop_b");
  assert.equal(Boolean(created[0]?.timeWindow?.desiredPickupAt), true);
});

test("line webhook verifies signature and sends reply", async () => {
  await withTemporaryEnv(
    {
      LINE_CHANNEL_SECRET: "line_secret_test",
      LINE_CHANNEL_ACCESS_TOKEN: "line_access_token_test",
      LINE_MINIAPP_URL: "https://example.com/line-reservation/"
    },
    async () => {
      const repository = new InMemoryRepository({
        stops: [
          { id: "stop_a", name: "中村駅", lat: 32.9898, lng: 132.9334 },
          { id: "stop_b", name: "市役所前", lat: 32.9911, lng: 132.9272 }
        ],
        users: [{ id: "line_user_1", name: "LINE利用者" }],
        lineIdentities: [
          {
            id: "line_1",
            lineUserId: "U_reply_target_1",
            userId: "line_user_1",
            source: "SEED",
            verified: true,
            displayName: "LINE利用者",
            lastSeenAt: "2026-02-21T12:00:00.000Z",
            blockStatus: "ACTIVE"
          }
        ],
        rideRequests: [
          {
            id: "req_3001",
            requesterId: "line_user_1",
            status: "ASSIGNED",
            pickup: { mode: "FIXED_STOP", stopId: "stop_a" },
            dropoff: { mode: "FIXED_STOP", stopId: "stop_b" }
          }
        ],
        serviceProfiles: [createDefaultServiceProfile()]
      });

      const { server } = createReqmoServer({ repository });
      const webhookPayload = {
        destination: "Uxxxxxxxxx",
        events: [
          {
            type: "message",
            mode: "active",
            timestamp: Date.now(),
            replyToken: "reply_token_1",
            source: {
              type: "user",
              userId: "U_reply_target_1"
            },
            message: {
              type: "text",
              id: "100001",
              text: "予約確認"
            }
          }
        ]
      };
      const rawBody = JSON.stringify(webhookPayload);
      const signature = createHmac("sha256", "line_secret_test")
        .update(rawBody)
        .digest("base64");

      const fetchCalls = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        fetchCalls.push({
          url: String(url),
          init
        });
        return new Response("", { status: 200 });
      };

      try {
        const response = await invokeServer({
          server,
          method: "POST",
          url: "/api/line/webhook",
          rawBody,
          headers: {
            "x-line-signature": signature
          }
        });

        assert.equal(response.statusCode, 200);
        const payload = JSON.parse(response.payload);
        assert.equal(payload.status, "OK");
        assert.equal(payload.handledEvents, 1);
        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0].url, "https://api.line.me/v2/bot/message/reply");

        const postedBody = JSON.parse(fetchCalls[0].init.body);
        assert.equal(postedBody.replyToken, "reply_token_1");
        assert.equal(Array.isArray(postedBody.messages), true);
        assert.equal(postedBody.messages.length, 1);
        assert.equal(
          postedBody.messages[0].text.includes("予約状況"),
          true
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});
