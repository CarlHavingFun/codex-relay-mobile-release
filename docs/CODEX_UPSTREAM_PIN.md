# OpenAI Codex Upstream Pin

- Local mirror: `<path-to-openai-codex-mirror>`
- Remote: `https://github.com/openai/codex`
- Branch: `main`
- Pinned commit: `e8949f45070dfed64e0e1bc47469180177432616`
- Commit time: `2026-02-22 19:39:56 -0800`

## Protocol References

- `<path-to-openai-codex-mirror>/codex-rs/app-server/README.md`
- `<path-to-openai-codex-mirror>/codex-rs/app-server-protocol/schema/json/v2`

## Upgrade Rule

When bumping this pin:

1. Pull latest upstream and record new commit SHA.
2. Compare schema changes under `app-server-protocol/schema/json/v2`.
3. Update relay connector compatibility before enabling new API fields in iOS.
