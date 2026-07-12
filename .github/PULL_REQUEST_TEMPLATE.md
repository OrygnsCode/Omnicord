## Summary

<!-- What does this PR change and why? Link any related issues. -->

## Type of change

- [ ] Bug fix
- [ ] New tool
- [ ] Change to an existing tool
- [ ] Refactor (no behavior change)
- [ ] Documentation
- [ ] CI / build / tooling
- [ ] Breaking change

## Checklist

- [ ] `npm test` passes (build, unit, smoke, smoke-http)
- [ ] Commits are signed off (`git commit -s`), per CONTRIBUTING.md
- [ ] No secrets committed, and nothing new writes to stdout

If this touches the tool surface:

- [ ] The tool preflights the bot's permissions before calling Discord
- [ ] **If it deletes content, removes access, punishes a member, or fans out a bulk change, it goes through `gateDestructive` and carries `destructiveHint: true`**
- [ ] Registration asserted in `scripts/smoke.mjs`, and the tool count updated there
- [ ] Live coverage added to `scripts/acceptance.mjs`, and it cleans up after itself
- [ ] `docs/tool-catalog.md` updated (the catalog is the contract), along with the counts in the README and `mcpb/manifest.json`

If this is user-visible:

- [ ] `README.md` and `CHANGELOG.md` updated

## How was this verified?

<!--
Which suites did you run, and against what? If you ran the live acceptance
suite, confirm it was pointed at a disposable test server and not a real one.
-->

## Notes for reviewers
