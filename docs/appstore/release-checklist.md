# App Store Release Checklist (Global + China)

## Build/signing
- [ ] Create local signing file: `ios/Config/Signing.local.xcconfig` from `.example`
- [ ] Set `DEVELOPMENT_TEAM` in local signing file
- [ ] Confirm bundle id: `com.carl.codexiphone`
- [ ] Run preflight:
  - `npm run release:preflight`

## Functional validation
- [ ] Fresh install shows onboarding (Relay URL + Token)
- [ ] Invalid URL shows actionable error
- [ ] Invalid token shows actionable error
- [ ] Valid URL/token can load status and thread list
- [ ] Can create thread and send message end-to-end

## Store metadata (en-US)
- [ ] App name: CodexIPhone
- [ ] Subtitle
- [ ] Description
- [ ] Keywords
- [ ] Privacy policy URL
- [ ] Support URL
- [ ] Marketing URL (optional)
- [ ] Screenshots (required sizes)
- [ ] Fill template: `docs/appstore/metadata.en-US.md`

## Store metadata (zh-CN)
- [ ] App 名称
- [ ] 副标题
- [ ] 描述
- [ ] 关键词
- [ ] 隐私政策 URL
- [ ] 支持 URL
- [ ] 截图（必需尺寸）
- [ ] 填写模板：`docs/appstore/metadata.zh-CN.md`

## Compliance/review notes
- [ ] `ITSAppUsesNonExemptEncryption=NO` confirmed
- [ ] Review notes prepared from `docs/appstore/review-notes-template.md`
- [ ] Test account / test environment template completed: `docs/appstore/test-account-template.md`

## Submission gating
- [ ] Archive build succeeds (Release, device)
- [ ] Upload to TestFlight succeeds
- [ ] Internal testing pass
- [ ] No blocker in crash/analytics smoke checks
