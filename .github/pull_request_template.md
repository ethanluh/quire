## Summary

<!-- What does this PR do, and why? -->

## Linked issue

<!-- If this PR addresses a tracked issue, link it with a closing keyword so it closes automatically on merge. -->
<!-- e.g. Closes #123 / Fixes #123 / Resolves #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behavior change)
- [ ] Docs
- [ ] Other (describe above)

## Build phase

<!-- Which phase from CLAUDE.md does this touch? Phase order is load-bearing — flag if this changes that order. -->

- [ ] Phase 0 — calibration
- [ ] Phase 1 — MVP (ingest → gate → bundle → cheap screen → review card → gestures → merge queue)
- [ ] Phase 2 — behavioral confirm
- [ ] Phase 2.5 — silent-rider measurement
- [ ] Phase 3 — directed/search-based test generation
- [ ] N/A

## Invariants

<!-- Does this change touch INV-1 through INV-6 (see CLAUDE.md)? If so, explain how the invariant is preserved. -->

## Testing

<!-- How was this verified? Commands run, manual steps, etc. -->

## Checklist

- [ ] `npm run lint` passes (TypeScript strict, no `any`)
- [ ] `npm test` passes
- [ ] Follows code style (tabs, named exports only, `interface`/`type` conventions)
- [ ] Linked issue uses a closing keyword (if applicable)
