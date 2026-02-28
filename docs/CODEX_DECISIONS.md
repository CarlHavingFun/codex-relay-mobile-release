# CODEX Decisions

## 2026-02-25

- Release default for this repo: always try direct Xcode install/run to physical `iPhone16` target first.
- Fallback policy: if direct device build/run is blocked, then archive and distribute through TestFlight.
- This rule applies to future release requests unless explicitly overridden by the user.
