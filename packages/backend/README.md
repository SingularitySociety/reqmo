# Reqmo Backend Core

Config-driven dispatch and telephony integration logic for Reqmo.

## Key Modules

- `src/location/resolver.ts`: fixed/free/hybrid location resolution
- `src/dispatch/insertion.ts`: incremental insertion dispatch heuristic
- `src/telephony/service.ts`: caller identity resolution and phone-request flow
- `src/api/functions.ts`: high-level API entrypoints
- `src/repository/inMemoryRepository.ts`: reference repository for tests and local runs
- `src/seed/configSeedLoader.ts`: generic seed data loader

## Test

```bash
npm run test:core
```

## HTTP API

- `GET /api/health`
- `GET /api/state`
- `GET /api/stops`
- `GET /api/vehicles`
- `GET /api/ride-requests`
- `GET /api/call-events`
- `GET /api/service-profiles`
- `POST /api/ride-requests`
- `POST /api/vehicles/:vehicleId/location` (`skipReoptimization=true`で再最適化を無効化)
- `POST /api/vehicles/:vehicleId/passenger-events` (ルート先頭タスクの乗降イベントを記録)
- `POST /api/phone-rides`
- `POST /api/telephony/ingest`
- `POST /api/service-profiles`
- `GET|POST /api/tuning/scenario-suites`
- `GET|POST /api/tuning/runs`
- `GET /api/tuning/recommendations`
- `POST /api/tuning/recommendations/:id/approve`
- `POST /api/tuning/rollback`
- `POST /api/tuning/feedback/interpret`

AI配車チューニングのデータモデル、運用、安全策は `documents/ai-dispatch-tuning.md` を参照してください。

## Seed Environment Variables

- `SEED_BUNDLE_PATH`
- `SEED_STOPS_PATH`
- `SEED_SERVICE_PROFILE_PATH`
- `SEED_FARE_POLICY_PATH`
- `SEED_TELEPHONY_CONFIG_PATH`
- `SEED_OVERWRITE_EXISTING` (`true` のとき既存DBデータをシード値で上書き)

## Repository Adapter

- `REPOSITORY_ADAPTER=memory` (default, local development)
- `REPOSITORY_ADAPTER=firestore` (persistent runtime)
- `REQMO_TENANT_ID` (tenant document id for Firestore mode)
