# Reqmo

Reqmo is an open-source, config-driven on-demand dispatch platform.

## Components

- `packages/backend`: dispatch engine, routing and telephony API
- `packages/shared`: shared defaults and constants
- `packages/web`: dispatcher/admin web UI (Vue + Vuetify)
- `mobile/reqmo_mobile`: Flutter mobile baseline

## Backend API (local)

From repository root:

```bash
node packages/backend/src/api/server.js
```

API examples:

- `GET /api/health`
- `POST /api/ride-requests`
- `POST /api/phone-rides`
- `POST /api/telephony/ingest`

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

## Flutter Mobile Test

```bash
cd mobile/reqmo_mobile
flutter test
```
