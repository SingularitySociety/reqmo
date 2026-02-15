# Contributing to Reqmo

## Development Rules

- Keep core behavior config-driven (`serviceProfiles`, `farePolicies`, `telephonyConfigs`).
- Preserve compatibility with both free-point and virtual-stop ride requests.
- Add tests for every algorithmic change.

## Pull Request Checklist

- [ ] Unit tests added or updated
- [ ] Existing tests pass (`npm test`)
- [ ] Design docs updated if behavior changed
- [ ] Tenant-agnostic behavior verified (no region-specific assumptions)
