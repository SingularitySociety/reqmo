# Reqmo

Reqmo is an open-source, config-driven on-demand dispatch platform.

## Components

- `packages/backend`: dispatch engine, routing and telephony API
- `packages/shared`: shared defaults and constants
- `packages/web`: dispatcher/admin web UI (Vue + Vuetify)
- `packages/web/simulation`: bus movement simulator UI (GPS + passenger event sender)
- `mobile/reqmo_mobile`: Flutter mobile baseline

## Backend API (local)

From repository root:

```bash
node --import tsx packages/backend/src/api/server.ts
```

API examples:

- `GET /api/health`
- `POST /api/ride-requests`
- `POST /api/phone-rides`
- `POST /api/telephony/ingest`

## Dispatch Weight Policy

Dispatch scoring weights are controlled by `serviceProfile.dispatchPolicy.weights`.

- Default values are defined in `packages/shared/src/defaults.ts`.
- Tenant-specific values are typically provided via seed/config and can be updated by `POST /api/service-profiles`.
- Scoring implementation is in `packages/backend/src/dispatch/insertion.ts`.
- To suppress excessive in-vehicle detours for newly inserted rides, `rideTimeDetour` is treated with a minimum effective weight:
  - `effectiveRideTimeDetourWeight = max(configuredRideTimeDetourWeight, 0.3)`

日本語:

- 配車スコアの重みは `serviceProfile.dispatchPolicy.weights` で管理されます。
- 既定値は `packages/shared/src/defaults.ts` にあります。
- テナント別の値はシード/設定で与えられ、`POST /api/service-profiles` でも更新できます。
- スコア計算の実装は `packages/backend/src/dispatch/insertion.ts` です。
- 新規挿入時の過度な連れ回し抑制のため、`rideTimeDetour` は実効値として `max(configuredRideTimeDetourWeight, 0.3)` を使用します。

Repository adapter:

- `REPOSITORY_ADAPTER=memory` (default)
- `REPOSITORY_ADAPTER=firestore`
- `REQMO_TENANT_ID=tenant_default` (used in Firestore mode)

## Seed Data Inputs (optional)

The backend can load generic seed data by environment variable:

- `SEED_BUNDLE_PATH`
- `SEED_STOPS_PATH`
- `SEED_SERVICE_PROFILE_PATH`
- `SEED_FARE_POLICY_PATH`
- `SEED_TELEPHONY_CONFIG_PATH`
- `SEED_OVERWRITE_EXISTING` (`true` to force seed data overwrite)

## Flutter Mobile Test

```bash
cd mobile/reqmo_mobile
flutter test
```
