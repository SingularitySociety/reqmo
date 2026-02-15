# Reqmo Firebase Adapter

This folder contains Firebase deployment scaffolding.

## Files

- `firebase.json`: Firebase project configuration
- `firestore.rules`: baseline tenant-scoped auth rule
- `functions/index.js`: function bridge to Reqmo core backend APIs

## Notes

- Replace `InMemoryRepository` with Firestore-backed repository before production rollout.
- Keep algorithm and telephony logic in `packages/backend/src`.
