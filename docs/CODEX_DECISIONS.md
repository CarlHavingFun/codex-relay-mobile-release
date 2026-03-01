# CODEX Decisions

## 2026-02-25

- Release default for this repo: always try direct Xcode install/run to physical `iPhone16` target first.
- Fallback policy: if direct device build/run is blocked, then archive and distribute through TestFlight.
- This rule applies to future release requests unless explicitly overridden by the user.

## 2026-02-28

- User preference: when asked to push to a new phone, also sync the latest optimizations to release repo directory `/Volumes/M2_Ext/Projects/Codex_Iphone_release` in the same run.
- User preference: future code changes should be implemented in `/Volumes/M2_Ext/Projects/Codex_Iphone_release` first (release repo is the source-of-truth on this machine).

## 2026-03-01

- TestFlight default invite email for this project: `184219650@qq.com`.
- Unless explicitly changed by user, use the email above as the first internal tester target for release delivery.
