# Reqmo Backend Core

Config-driven dispatch and telephony integration logic for Reqmo.

## Key Modules

- `src/location/resolver.js`: fixed/free/hybrid location resolution
- `src/dispatch/insertion.js`: incremental insertion dispatch heuristic
- `src/telephony/service.js`: caller identity resolution and phone-request flow
- `src/api/functions.js`: high-level API entrypoints
- `src/repository/inMemoryRepository.js`: reference repository for tests and local runs
- `src/seed/configSeedLoader.js`: generic seed data loader

## Test

```bash
npm run test:core
```

## HTTP API

- `GET /api/health`
- `GET /api/state`
- `GET /api/stops`
- `GET /api/ride-requests`
- `GET /api/call-events`
- `GET /api/service-profiles`
- `POST /api/ride-requests`
- `POST /api/phone-rides`
- `POST /api/telephony/ingest`
- `POST /api/service-profiles`

## Seed Environment Variables

- `SEED_BUNDLE_PATH`
- `SEED_STOPS_PATH`
- `SEED_SERVICE_PROFILE_PATH`
- `SEED_FARE_POLICY_PATH`
- `SEED_TELEPHONY_CONFIG_PATH`

## Repository Adapter

- `REPOSITORY_ADAPTER=memory` (default, local development)
- `REPOSITORY_ADAPTER=firestore` (persistent runtime)
- `REQMO_TENANT_ID` (tenant document id for Firestore mode)
