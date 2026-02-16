import test from "node:test";
import assert from "node:assert/strict";

import { createTravelEstimator, resolveRoutePath } from "../src/routing/service.ts";

const pointA = { lat: 33.0, lng: 132.9 };
const pointB = { lat: 33.01, lng: 132.905 };

test("straight-line routing fallback returns valid minutes and path", async () => {
  const estimator = await createTravelEstimator({
    points: [pointA, pointB],
    context: {
      routing: {
        provider: "STRAIGHT_LINE"
      }
    }
  });

  const minutes = estimator.travelMinutes(pointA, pointB);
  assert.equal(Number.isFinite(minutes), true);
  assert.equal(minutes > 0, true);

  const path = await resolveRoutePath({
    points: [pointA, pointB],
    context: {
      routing: {
        provider: "STRAIGHT_LINE"
      }
    }
  });

  assert.equal(path.source, "STRAIGHT_LINE");
  assert.equal(Array.isArray(path.polyline), true);
  assert.equal(path.polyline.length, 2);
  assert.equal(path.distanceMeters > 0, true);
  assert.equal(path.durationMinutes > 0, true);
});

test("straight-line estimator and path duration honor configured speed", async () => {
  const context = {
    routing: {
      provider: "STRAIGHT_LINE"
    }
  };

  const fastEstimator = await createTravelEstimator({
    points: [pointA, pointB],
    context,
    speedKmh: 50
  });
  const slowEstimator = await createTravelEstimator({
    points: [pointA, pointB],
    context,
    speedKmh: 10
  });
  assert.equal(slowEstimator.travelMinutes(pointA, pointB) > fastEstimator.travelMinutes(pointA, pointB), true);

  const fastPath = await resolveRoutePath({
    points: [pointA, pointB],
    context,
    speedKmh: 50
  });
  const slowPath = await resolveRoutePath({
    points: [pointA, pointB],
    context,
    speedKmh: 10
  });
  assert.equal(slowPath.durationMinutes > fastPath.durationMinutes, true);
});

test("OSRM matrix response is used for travel minutes", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /\/table\/v1\/driving\//);
    return {
      ok: true,
      async json() {
        return {
          code: "Ok",
          durations: [
            [0, 120],
            [120, 0]
          ],
          distances: [
            [0, 800],
            [800, 0]
          ]
        };
      }
    };
  };

  try {
    const estimator = await createTravelEstimator({
      points: [pointA, pointB],
      context: {
        routing: {
          provider: "OSRM",
          osrmBaseUrl: "https://example.test"
        }
      }
    });

    assert.equal(estimator.source, "OSRM");
    assert.equal(estimator.travelMinutes(pointA, pointB), 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("OSRM route response is returned as map polyline", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /\/route\/v1\/driving\//);
    return {
      ok: true,
      async json() {
        return {
          code: "Ok",
          routes: [
            {
              distance: 920,
              duration: 180,
              geometry: {
                coordinates: [
                  [132.9, 33.0],
                  [132.902, 33.003],
                  [132.905, 33.01]
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const path = await resolveRoutePath({
      points: [pointA, pointB],
      context: {
        routing: {
          provider: "OSRM",
          osrmBaseUrl: "https://example.test"
        }
      }
    });

    assert.equal(path.source, "OSRM");
    assert.equal(Array.isArray(path.polyline), true);
    assert.equal(path.polyline.length, 3);
    assert.equal(path.durationMinutes, 3);
    assert.equal(path.distanceMeters, 920);
  } finally {
    global.fetch = originalFetch;
  }
});

test("route path responses are cached for identical OSRM inputs", async () => {
  const originalFetch = global.fetch;
  let fetchCount = 0;

  global.fetch = async (url) => {
    fetchCount += 1;
    assert.match(String(url), /\/route\/v1\/driving\//);
    return {
      ok: true,
      async json() {
        return {
          code: "Ok",
          routes: [
            {
              distance: 1020,
              duration: 240,
              geometry: {
                coordinates: [
                  [132.9, 33.0],
                  [132.901, 33.002],
                  [132.905, 33.01]
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const context = {
      routing: {
        provider: "OSRM",
        osrmBaseUrl: "https://cache-hit.example.test"
      }
    };
    const first = await resolveRoutePath({
      points: [pointA, pointB],
      context
    });
    const second = await resolveRoutePath({
      points: [pointA, pointB],
      context
    });

    assert.equal(fetchCount, 1);
    assert.deepEqual(second, first);
  } finally {
    global.fetch = originalFetch;
  }
});

test("concurrent route requests share a single OSRM call", async () => {
  const originalFetch = global.fetch;
  let fetchCount = 0;
  let releaseFetch;
  const gate = new Promise((resolve) => {
    releaseFetch = resolve;
  });

  global.fetch = async (url) => {
    fetchCount += 1;
    assert.match(String(url), /\/route\/v1\/driving\//);
    await gate;
    return {
      ok: true,
      async json() {
        return {
          code: "Ok",
          routes: [
            {
              distance: 880,
              duration: 210,
              geometry: {
                coordinates: [
                  [132.9, 33.0],
                  [132.903, 33.005],
                  [132.905, 33.01]
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const context = {
      routing: {
        provider: "OSRM",
        osrmBaseUrl: "https://inflight.example.test"
      }
    };
    const firstPromise = resolveRoutePath({
      points: [pointA, pointB],
      context
    });
    const secondPromise = resolveRoutePath({
      points: [pointA, pointB],
      context
    });

    releaseFetch();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(fetchCount, 1);
    assert.deepEqual(second, first);
  } finally {
    global.fetch = originalFetch;
  }
});
