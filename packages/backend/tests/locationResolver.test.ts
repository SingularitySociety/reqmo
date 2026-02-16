import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultServiceProfile } from "../../shared/src/defaults.ts";
import { LOCATION_MODES, RESOLVED_AS } from "../../shared/src/constants.ts";
import { resolveLocationInput } from "../src/location/resolver.ts";

const STOPS = [
  { id: "stop_a", name: "A", lat: 33.0, lng: 132.9 },
  { id: "stop_b", name: "B", lat: 33.002, lng: 132.902 }
];

test("HYBRID mode resolves to free point by default when cheap", () => {
  const profile = createDefaultServiceProfile();
  const result = resolveLocationInput({
    input: {
      mode: "FREE_POINT",
      point: { lat: 33.0005, lng: 132.9004 }
    },
    serviceProfile: profile,
    stops: STOPS,
    context: { isPeak: false }
  });

  assert.equal(result.resolvedAs, RESOLVED_AS.FREE_POINT);
  assert.deepEqual(result.resolvedPoint, { lat: 33.0005, lng: 132.9004 });
});

test("HYBRID mode can prefer virtual stop", () => {
  const profile = createDefaultServiceProfile();
  const result = resolveLocationInput({
    input: {
      mode: "FREE_POINT",
      point: { lat: 33.0001, lng: 132.9001 }
    },
    serviceProfile: profile,
    stops: STOPS,
    context: { preferVirtualStop: true }
  });

  assert.equal(result.resolvedAs, RESOLVED_AS.VIRTUAL_STOP);
  assert.equal(result.stopId, "stop_a");
});

test("VIRTUAL_ONLY resolves free point input to virtual stop", () => {
  const profile = createDefaultServiceProfile({
    locationPolicy: {
      ...createDefaultServiceProfile().locationPolicy,
      mode: LOCATION_MODES.VIRTUAL_ONLY
    }
  });

  const result = resolveLocationInput({
    input: {
      mode: "FREE_POINT",
      point: { lat: 33.5, lng: 132.5 }
    },
    serviceProfile: profile,
    stops: STOPS,
    context: {}
  });

  assert.equal(result.resolvedAs, RESOLVED_AS.VIRTUAL_STOP);
  assert.match(result.stopId, /^virtual_/);
});
