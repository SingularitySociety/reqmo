# Reqmo Firebase Adapter

This folder contains generic Firebase adapter scaffolding for Reqmo.

## Runtime switch

- `REPOSITORY_ADAPTER=memory` for local development
- `REPOSITORY_ADAPTER=firestore` for persistent runtime
- `REQMO_TENANT_ID` to select target tenant document

## Notes

- Domain logic lives in `packages/backend/src`.
- Tenant-specific deploy settings should be kept in a private repository.

## 5-second simulation trigger (design note)

The OSS simulation UI (`packages/web/simulation`) already runs a 5-second timer in the browser and calls:

- `POST /api/vehicles/:vehicleId/location`
- `POST /api/vehicles/:vehicleId/passenger-events`

When you need Firebase-side periodic execution:

1. Cloud Scheduler minimum interval is 1 minute, so it cannot directly trigger every 5 seconds.
2. For strict 5-second cadence, use an always-on worker (Cloud Run / VM) that calls the two APIs every 5 seconds.
3. If 1-minute cadence is acceptable, Scheduler -> HTTPS Function can call the simulation APIs in batch.
