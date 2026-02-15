# Reqmo Firebase Adapter

This folder contains generic Firebase adapter scaffolding for Reqmo.

## Runtime switch

- `REPOSITORY_ADAPTER=memory` for local development
- `REPOSITORY_ADAPTER=firestore` for persistent runtime
- `REQMO_TENANT_ID` to select target tenant document

## Notes

- Domain logic lives in `packages/backend/src`.
- Tenant-specific deploy settings should be kept in a private repository.
