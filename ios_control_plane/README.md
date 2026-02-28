# CodexControlPlane iOS App

独立的 iOS 控制端，用于 CodexCP 调度与任务治理。
该工程独立于 legacy `ios/` 应用，不会改变原有手机聊天链路。

## 主要能力（本版本）

- 三层视图：`组合总览 -> 项目列表(workspace) -> 任务详情`
- 高维默认展示：首页只看聚合指标，不默认平铺细粒度任务
- 细粒度开关：可在设置中开启“默认显示细粒度任务”
- 中英双语：支持 `System / 中文 / English` 手动切换
- 任务控制：`pause / resume / cancel / force_rollback`

## 构建

```bash
cd ios_control_plane
xcodegen generate
xcodebuild -project CodexControlPlaneIPhone.xcodeproj -scheme CodexControlPlaneApp -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17' build
```

## 在 Xcode 打开

```bash
cd ios_control_plane
xcodegen generate
open CodexControlPlaneIPhone.xcodeproj
```

## App 内配置

- Base URL: `https://my-agent.com.cn/codexcp-relay`
- Token: Relay Bearer Token
- Workspace: `codex_tower`（或你的目标 workspace）

## 说明

- 当前对接 `codexcp-supervisor` 路径：`/v2/supervisor/*`
- 不修改 legacy `ios/` 项目与原会话链路
- Thread 回填采用 `1 thread -> 1 MASTER`，但默认在 UI 中按 workspace 聚合展示
