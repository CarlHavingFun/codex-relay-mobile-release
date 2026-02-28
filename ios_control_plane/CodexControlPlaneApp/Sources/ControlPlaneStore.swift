import Foundation
import SwiftUI

@MainActor
final class ControlPlaneStore: ObservableObject {
    private static let defaultBaseURL = "https://my-agent.com.cn/codexcp-relay"
    private static let legacyBaseURL = "https://my-agent.com.cn/codex-relay"
    private static let defaultToken = "1c6b943c910f9b8d15e9d274b4c2f44a41ace6698fb042a9"
    private static let defaultWorkspace = "codex_tower"

    @Published var baseURL: String = "https://my-agent.com.cn/codexcp-relay"
    @Published var token: String = "1c6b943c910f9b8d15e9d274b4c2f44a41ace6698fb042a9"
    @Published var workspace: String = "codex_tower"
    @Published var backendModeLabel: String = "codexcp-supervisor"
    @Published var tasks: [CPTask] = []
    @Published var workspaceGroups: [CPWorkspaceGroup] = []
    @Published var portfolioSummary: CPPortfolioSummary = .empty
    @Published var showFineGrainedTasks: Bool = false
    @Published var appLanguage: AppLanguage = .system
    @Published var selectedTask: CPTaskDetail?
    @Published var health: CPHealthResponse?
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?
    @Published var rawErrorMessage: String?

    private let client = CPAPIClient()
    private var pollTask: Task<Void, Never>?

    private let baseURLKey = "cp.base_url"
    private let tokenKey = "cp.token"
    private let workspaceKey = "cp.workspace"
    private let fineGrainedTasksKey = "cp.ui.show_fine_grained_tasks"
    private let appLanguageKey = "cp.ui.language"

    var isConfigured: Bool {
        !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var supportsGlobalControls: Bool {
        false
    }

    var preferredLocale: Locale {
        if let identifier = appLanguage.localeIdentifier {
            return Locale(identifier: identifier)
        }
        return .autoupdatingCurrent
    }

    func supportsTaskAction(_ action: String) -> Bool {
        ["pause", "resume", "cancel", "force_rollback"].contains(action.lowercased())
    }

    deinit {
        pollTask?.cancel()
    }

    func bootstrap() {
        let defaults = UserDefaults.standard
        let savedBaseURL = defaults.string(forKey: baseURLKey) ?? ""
        let savedToken = defaults.string(forKey: tokenKey) ?? ""
        let savedWorkspace = defaults.string(forKey: workspaceKey) ?? ""
        let savedLanguage = defaults.string(forKey: appLanguageKey) ?? AppLanguage.system.rawValue

        baseURL = normalizedBaseURL(savedBaseURL)
        token = normalizedToken(savedToken)
        workspace = normalizedWorkspace(savedWorkspace)
        showFineGrainedTasks = defaults.bool(forKey: fineGrainedTasksKey)
        appLanguage = AppLanguage(rawValue: savedLanguage) ?? .system
        backendModeLabel = "codexcp-supervisor"

        defaults.set(baseURL, forKey: baseURLKey)
        defaults.set(token, forKey: tokenKey)
        defaults.set(workspace, forKey: workspaceKey)
        defaults.set(showFineGrainedTasks, forKey: fineGrainedTasksKey)
        defaults.set(appLanguage.rawValue, forKey: appLanguageKey)
        defaults.synchronize()

        if isConfigured {
            startPolling()
        }
    }

    func saveSettings(baseURL: String, token: String, workspace: String) {
        self.baseURL = normalizedBaseURL(baseURL)
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        self.workspace = normalizedWorkspace(workspace)
        self.backendModeLabel = "codexcp-supervisor"

        let defaults = UserDefaults.standard
        defaults.set(self.baseURL, forKey: baseURLKey)
        defaults.set(self.token, forKey: tokenKey)
        defaults.set(self.workspace, forKey: workspaceKey)
        defaults.synchronize()

        if isConfigured {
            startPolling()
        } else {
            pollTask?.cancel()
            pollTask = nil
            tasks = []
            workspaceGroups = []
            portfolioSummary = .empty
            selectedTask = nil
            health = nil
        }
    }

    func setLanguage(_ language: AppLanguage) {
        appLanguage = language
        UserDefaults.standard.set(language.rawValue, forKey: appLanguageKey)
        UserDefaults.standard.synchronize()
        if let raw = rawErrorMessage, !raw.isEmpty {
            errorMessage = localizedServerError(raw)
        }
    }

    func setShowFineGrainedTasks(_ enabled: Bool) {
        showFineGrainedTasks = enabled
        UserDefaults.standard.set(enabled, forKey: fineGrainedTasksKey)
        UserDefaults.standard.synchronize()
    }

    func refreshNow() async {
        guard isConfigured else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            async let listResp: CPSupervisorTasksResponse = client.get(
                "v2/supervisor/tasks?workspace=\(encoded(activeWorkspace()))&limit=300",
                baseURL: baseURL,
                token: token
            )
            async let healthResp: CPRelayHealthzResponse = client.get(
                "healthz",
                baseURL: baseURL,
                token: token
            )

            let list = try await listResp
            _ = try await healthResp

            let mapped = list.tasks.map(cpTask(from:)).sorted(by: { $0.updated_at > $1.updated_at })
            tasks = mapped
            workspaceGroups = buildWorkspaceGroups(from: mapped)
            portfolioSummary = buildPortfolioSummary(tasks: mapped, groups: workspaceGroups)
            health = buildSupervisorHealth(from: list.tasks)

            if let selected = selectedTask?.task_id,
               let row = list.tasks.first(where: { $0.id == selected }) {
                selectedTask = cpTaskDetail(from: row)
            } else if let first = list.tasks.first {
                selectedTask = cpTaskDetail(from: first)
            } else {
                selectedTask = nil
            }

            errorMessage = nil
            rawErrorMessage = nil
        } catch {
            setError(error)
        }
    }

    func refreshTaskDetail(taskID: String) async throws {
        let resp: CPSupervisorTasksResponse = try await client.get(
            "v2/supervisor/tasks?workspace=\(encoded(activeWorkspace()))&limit=300",
            baseURL: baseURL,
            token: token
        )
        guard let task = resp.tasks.first(where: { $0.id == taskID }) else {
            throw CPAPIError.serverError("task_not_found")
        }
        selectedTask = cpTaskDetail(from: task)
    }

    func createTask(spec: CPTaskSpec) async {
        guard isConfigured else { return }
        struct Body: Encodable {
            let workspace: String
            let title: String
            let objective: String
            let priority: String
            let created_by: String
        }

        do {
            let criteria = spec.acceptanceCriteria.joined(separator: " | ")
            let objective = [
                spec.goal.trimmingCharacters(in: .whitespacesAndNewlines),
                spec.repo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : "repo=\(spec.repo)",
                spec.branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : "branch=\(spec.branch)",
                criteria.isEmpty ? nil : "acceptance=\(criteria)",
            ]
                .compactMap { $0 }
                .joined(separator: "\n")
            let title = String(spec.goal.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))

            let resp: CPSupervisorTaskCreateResponse = try await client.post(
                "v2/supervisor/tasks",
                baseURL: baseURL,
                token: token,
                body: Body(
                    workspace: activeWorkspace(),
                    title: title.isEmpty ? "iOS task" : title,
                    objective: objective,
                    priority: normalizedPriority(spec.priority),
                    created_by: "ios-control-plane"
                )
            )
            selectedTask = cpTaskDetail(from: resp.task)
            await refreshNow()
            errorMessage = nil
            rawErrorMessage = nil
        } catch {
            setError(error)
        }
    }

    func controlTask(taskID: String, action: String, reason: String? = nil) async {
        guard isConfigured else { return }
        guard let nextStatus = supervisorStatus(for: action) else {
            let fmt = localizedString("error.unsupported_action_format")
            errorMessage = String(format: fmt, action)
            rawErrorMessage = "unsupported_action:\(action)"
            return
        }

        struct Body: Encodable {
            let status: String
            let runner_id: String
            let profile_id: String
            let reason: String?
        }

        do {
            let resp: CPSupervisorTaskUpdateResponse = try await client.post(
                "v2/supervisor/tasks/\(encodedPath(taskID))/update",
                baseURL: baseURL,
                token: token,
                body: Body(
                    status: nextStatus,
                    runner_id: "ios-control-plane",
                    profile_id: "ios",
                    reason: reasonFor(action: action, fallback: reason)
                )
            )
            selectedTask = cpTaskDetail(from: resp.task)
            await refreshNow()
            errorMessage = nil
            rawErrorMessage = nil
        } catch {
            setError(error)
        }
    }

    func controlGlobal(action: String, reason: String? = nil) async {
        _ = action
        _ = reason
        errorMessage = localizedString("error.global_controls_unsupported")
        rawErrorMessage = "global_controls_unsupported"
    }

    func localizedStatus(_ status: String) -> String {
        let key = statusLocalizationKey(status)
        return localizedString(key)
    }

    func localizedText(_ key: String) -> String {
        localizedString(key)
    }

    func localizedFormat(_ key: String, _ args: CVarArg...) -> String {
        String(format: localizedString(key), locale: preferredLocale, arguments: args)
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await refreshNow()
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    private func encodedPath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }

    private func cpTask(from source: CPSupervisorTask) -> CPTask {
        let semantic = parseSemantic(from: source)
        let displayGoal = source.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? source.objective
            : source.title
        return CPTask(
            task_id: source.id,
            goal: displayGoal,
            repo: source.workspace,
            branch: "-",
            acceptance_criteria: [],
            priority: normalizedPriority(source.priority),
            risk_profile: source.approval_mode ?? "supervisor",
            status: source.status,
            parallelism_limit: 1,
            created_at: source.created_at,
            updated_at: source.updated_at,
            started_at: source.claim_at,
            completed_at: source.completed_at,
            failed_reason: source.failed_reason,
            degraded: false,
            semantic: semantic
        )
    }

    private func cpTaskDetail(from source: CPSupervisorTask) -> CPTaskDetail {
        let semantic = parseSemantic(from: source)
        let detailGoal = source.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? source.title
            : source.objective
        let mappedSubTasks: [CPSubTask] = source.steps.map { step in
            CPSubTask(
                job_id: "\(source.id):\(step.id)",
                task_id: source.id,
                node_id: step.id,
                role: step.title,
                timeout_s: 0,
                max_retries: 0,
                attempt: source.attempts ?? 0,
                status: step.status,
                worker_id: source.claim_runner_id,
                next_run_at: nil,
                last_error: nil,
                started_at: source.claim_at,
                finished_at: source.completed_at
            )
        }

        return CPTaskDetail(
            task_id: source.id,
            goal: detailGoal,
            repo: source.workspace,
            branch: "-",
            acceptance_criteria: [],
            priority: normalizedPriority(source.priority),
            risk_profile: source.approval_mode ?? "supervisor",
            status: source.status,
            parallelism_limit: 1,
            created_at: source.created_at,
            updated_at: source.updated_at,
            started_at: source.claim_at,
            completed_at: source.completed_at,
            failed_reason: source.failed_reason,
            degraded: false,
            semantic: semantic,
            dag_progress: dagProgress(from: source.steps),
            sub_tasks: mappedSubTasks,
            events: nil,
            decisions: nil,
            rollbacks: nil,
            controls: nil
        )
    }

    private func parseSemantic(from source: CPSupervisorTask) -> CPTaskSemantic {
        let lines = source.objective
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        let sourceWorkspace = objectiveValue(prefix: "SourceWorkspace:", lines: lines)
        let threadID = objectiveValue(prefix: "ThreadID:", lines: lines)
        let parentMasterTaskID = objectiveValue(prefix: "ParentMasterTask:", lines: lines)
        let entityType = objectiveValue(prefix: "EntityType:", lines: lines)
        let objectiveGroupDimension = objectiveValue(prefix: "GroupDimension:", lines: lines)
        let objectiveGroupKey = objectiveValue(prefix: "GroupKey:", lines: lines)
        let repoPath = objectiveRepoPath(lines: lines)
        let repoFolder = repoFolderName(from: repoPath)

        let kind: CPTaskKind = {
            let normalizedTitle = source.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let upper = normalizedTitle.uppercased()
            if let entityType {
                switch entityType.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() {
                case "MASTER":
                    return .master
                case "SUB":
                    return .sub
                default:
                    break
                }
            }
            if upper.hasPrefix("MASTER ") { return .master }
            if upper.hasPrefix("SUB ") { return .sub }
            if normalizedTitle.isEmpty { return .unknown }
            return .manual
        }()

        let fallbackGroup = sourceWorkspace ?? repoFolder ?? "misc"
        let groupDimension = (objectiveGroupDimension?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? objectiveGroupDimension!.trimmingCharacters(in: .whitespacesAndNewlines)
            : "workspace"
        let groupKey = (objectiveGroupKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? objectiveGroupKey!.trimmingCharacters(in: .whitespacesAndNewlines)
            : "\(groupDimension):\(fallbackGroup)"

        return CPTaskSemantic(
            kind: kind,
            sourceWorkspace: sourceWorkspace,
            threadID: threadID,
            parentMasterTaskID: parentMasterTaskID,
            groupDimension: groupDimension,
            groupKey: groupKey,
            repoPath: repoPath,
            repoFolder: repoFolder
        )
    }

    private func objectiveValue(prefix: String, lines: [String]) -> String? {
        let target = prefix.lowercased()
        for line in lines {
            if line.lowercased().hasPrefix(target) {
                let value = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty {
                    return value
                }
            }
        }
        return nil
    }

    private func objectiveRepoPath(lines: [String]) -> String? {
        for line in lines {
            if line.lowercased().hasPrefix("repo=") {
                let value = String(line.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty {
                    return value
                }
            }
        }
        return nil
    }

    private func repoFolderName(from repoPath: String?) -> String? {
        guard let repoPath else { return nil }
        var normalized = repoPath.trimmingCharacters(in: .whitespacesAndNewlines)
        while normalized.hasSuffix("/") || normalized.hasSuffix("\\") {
            normalized.removeLast()
        }
        guard !normalized.isEmpty else { return nil }

        let separators = CharacterSet(charactersIn: "/\\")
        let parts = normalized.components(separatedBy: separators).filter { !$0.isEmpty }
        guard var last = parts.last else { return nil }
        if last.lowercased().hasSuffix(".git") {
            last = String(last.dropLast(4))
        }
        return last.isEmpty ? nil : last
    }

    private func groupName(for semantic: CPTaskSemantic?) -> String {
        if let sourceWorkspace = semantic?.sourceWorkspace,
           !sourceWorkspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return sourceWorkspace
        }
        if let repoFolder = semantic?.repoFolder,
           !repoFolder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return repoFolder
        }
        return "misc"
    }

    private func buildWorkspaceGroups(from tasks: [CPTask]) -> [CPWorkspaceGroup] {
        var grouped: [String: [CPTask]] = [:]
        for task in tasks {
            let name = groupName(for: task.semantic)
            grouped[name, default: []].append(task)
        }

        var groups: [CPWorkspaceGroup] = []
        for (name, groupTasks) in grouped {
            let sortedTasks = groupTasks.sorted(by: { $0.updated_at > $1.updated_at })
            let master = sortedTasks.filter { $0.semantic?.kind == .master }
            let sub = sortedTasks.filter { $0.semantic?.kind == .sub }
            let manual = sortedTasks.filter { $0.semantic?.kind == .manual }
            let unknown = sortedTasks.filter { $0.semantic?.kind == .unknown || $0.semantic == nil }
            let activeCount = sortedTasks.filter { isActiveStatus($0.status) }.count
            let runningCount = sortedTasks.filter { isRunningStatus($0.status) }.count
            let failedCount = sortedTasks.filter { isFailedStatus($0.status) }.count
            let waitingApprovalCount = sortedTasks.filter { isWaitingApprovalStatus($0.status) }.count
            let lastUpdatedAt = sortedTasks.map(\.updated_at).max() ?? nowIso()

            groups.append(
                CPWorkspaceGroup(
                    key: "workspace:\(name)",
                    displayName: name,
                    dimension: "workspace",
                    tasks: sortedTasks,
                    masterTasks: master,
                    subTasks: sub,
                    manualTasks: manual,
                    unknownTasks: unknown,
                    activeCount: activeCount,
                    runningCount: runningCount,
                    failedCount: failedCount,
                    waitingApprovalCount: waitingApprovalCount,
                    lastUpdatedAt: lastUpdatedAt
                )
            )
        }

        return groups.sorted {
            if $0.activeCount != $1.activeCount { return $0.activeCount > $1.activeCount }
            if $0.runningCount != $1.runningCount { return $0.runningCount > $1.runningCount }
            if $0.failedCount != $1.failedCount { return $0.failedCount > $1.failedCount }
            if $0.lastUpdatedAt != $1.lastUpdatedAt { return $0.lastUpdatedAt > $1.lastUpdatedAt }
            return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    private func buildPortfolioSummary(tasks: [CPTask], groups: [CPWorkspaceGroup]) -> CPPortfolioSummary {
        let activeCount = tasks.filter { isActiveStatus($0.status) }.count
        let runningCount = tasks.filter { isRunningStatus($0.status) }.count
        let failedCount = tasks.filter { isFailedStatus($0.status) }.count
        let waitingApprovalCount = tasks.filter { isWaitingApprovalStatus($0.status) }.count
        let lastUpdatedAt = tasks.map(\.updated_at).max()

        return CPPortfolioSummary(
            totalTasks: tasks.count,
            groupCount: groups.count,
            activeCount: activeCount,
            runningCount: runningCount,
            failedCount: failedCount,
            waitingApprovalCount: waitingApprovalCount,
            lastUpdatedAt: lastUpdatedAt
        )
    }

    private func isActiveStatus(_ status: String) -> Bool {
        let s = status.lowercased()
        return ["queued", "claimed", "running", "planning", "reviewing", "releasing", "waiting_approval"].contains(s)
    }

    private func isRunningStatus(_ status: String) -> Bool {
        ["running", "claimed"].contains(status.lowercased())
    }

    private func isFailedStatus(_ status: String) -> Bool {
        ["failed", "rolled_back"].contains(status.lowercased())
    }

    private func isWaitingApprovalStatus(_ status: String) -> Bool {
        status.lowercased() == "waiting_approval"
    }

    private func dagProgress(from steps: [CPSupervisorTaskStep]) -> CPDagProgress {
        var queued = 0
        var running = 0
        var completed = 0
        var failed = 0
        var blocked = 0
        var canceled = 0

        for step in steps {
            switch step.status.lowercased() {
            case "completed", "done":
                completed += 1
            case "running", "claimed":
                running += 1
            case "failed":
                failed += 1
            case "rejected", "canceled", "cancelled":
                canceled += 1
            case "waiting_approval":
                blocked += 1
            default:
                queued += 1
            }
        }

        return CPDagProgress(
            total: steps.count,
            blocked: blocked,
            queued: queued,
            dispatched: nil,
            running: running,
            completed: completed,
            failed: failed,
            timeout: nil,
            canceled: canceled
        )
    }

    private func buildSupervisorHealth(from sourceTasks: [CPSupervisorTask]) -> CPHealthResponse {
        var queued = 0
        var running = 0
        var done = 0
        var failed = 0
        var paused = 0
        var canceled = 0

        for task in sourceTasks {
            switch task.status.lowercased() {
            case "queued":
                queued += 1
            case "claimed", "running":
                running += 1
            case "completed":
                done += 1
            case "failed":
                failed += 1
            case "waiting_approval":
                paused += 1
            case "rejected", "canceled", "cancelled":
                canceled += 1
            default:
                break
            }
        }

        return CPHealthResponse(
            ok: true,
            ts: nowIso(),
            loop_ms: nil,
            tick_in_flight: nil,
            last_tick_at: nil,
            last_tick_error: nil,
            task_counts: CPTaskCounts(
                queued: queued,
                planning: nil,
                running: running,
                reviewing: nil,
                releasing: nil,
                done: done,
                failed: failed,
                rolled_back: nil,
                paused: paused,
                canceled: canceled
            ),
            system: nil
        )
    }

    private func activeWorkspace() -> String {
        normalizedWorkspace(workspace)
    }

    private func normalizedBaseURL(_ candidate: String) -> String {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return Self.defaultBaseURL
        }
        let noTrailingSlash = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        if noTrailingSlash == Self.legacyBaseURL {
            return Self.defaultBaseURL
        }
        return noTrailingSlash
    }

    private func normalizedToken(_ candidate: String) -> String {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? Self.defaultToken : trimmed
    }

    private func normalizedWorkspace(_ candidate: String) -> String {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? Self.defaultWorkspace : trimmed
    }

    private func normalizedPriority(_ candidate: String) -> String {
        let value = candidate.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if ["P0", "P1", "P2"].contains(value) {
            return value
        }
        return "P1"
    }

    private func supervisorStatus(for action: String) -> String? {
        switch action.lowercased() {
        case "pause":
            return "waiting_approval"
        case "resume":
            return "queued"
        case "cancel":
            return "rejected"
        case "force_rollback":
            return "failed"
        default:
            return nil
        }
    }

    private func reasonFor(action: String, fallback: String?) -> String {
        if let fallback, !fallback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return fallback
        }
        switch action.lowercased() {
        case "pause":
            return "paused_from_ios"
        case "resume":
            return "resumed_from_ios"
        case "cancel":
            return "cancelled_from_ios"
        case "force_rollback":
            return "force_rollback_from_ios"
        default:
            return "ios_control_plane_action"
        }
    }

    private func setError(_ error: Error) {
        rawErrorMessage = String(describing: error)
        errorMessage = localizedErrorMessage(for: error)
    }

    private func localizedErrorMessage(for error: Error) -> String {
        guard let cpError = error as? CPAPIError else {
            return localizedServerError(String(describing: error))
        }

        switch cpError {
        case .invalidURL:
            return localizedString("error.invalid_url")
        case .invalidResponse:
            return localizedString("error.invalid_response")
        case let .serverError(raw):
            return localizedServerError(raw)
        }
    }

    private func localizedServerError(_ raw: String) -> String {
        let lower = raw.lowercased()

        if lower.contains("unauthorized") {
            return localizedString("error.unauthorized")
        }
        if lower.contains("task_not_found") {
            return localizedString("error.task_not_found")
        }
        if lower.contains("control_plane_disabled") {
            return localizedString("error.control_plane_disabled")
        }
        if lower.contains("payload too large") {
            return localizedString("error.payload_too_large")
        }
        if lower.contains("request_not_claimed_by_connector") {
            return localizedString("error.request_not_claimed")
        }

        let format = localizedString("error.server_with_detail")
        return String(format: format, raw)
    }

    private func statusLocalizationKey(_ status: String) -> String {
        switch status.lowercased() {
        case "done", "completed":
            return "status.completed"
        case "running":
            return "status.running"
        case "claimed":
            return "status.claimed"
        case "reviewing":
            return "status.reviewing"
        case "releasing":
            return "status.releasing"
        case "planning":
            return "status.planning"
        case "failed":
            return "status.failed"
        case "rolled_back":
            return "status.rolled_back"
        case "paused", "waiting_approval":
            return "status.waiting_approval"
        case "canceled", "cancelled", "rejected":
            return "status.canceled"
        case "queued":
            return "status.queued"
        default:
            return "status.unknown"
        }
    }

    private func localizedString(_ key: String) -> String {
        if let languageId = appLanguage.localeIdentifier,
           let path = Bundle.main.path(forResource: languageId, ofType: "lproj"),
           let langBundle = Bundle(path: path) {
            let value = NSLocalizedString(key, tableName: nil, bundle: langBundle, value: key, comment: "")
            if value != key {
                return value
            }
        }

        let fallback = NSLocalizedString(key, comment: "")
        return fallback == key ? key : fallback
    }

    private func nowIso() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}
