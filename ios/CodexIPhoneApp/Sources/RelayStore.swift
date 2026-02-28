import Foundation
import SwiftUI

@MainActor
final class RelayStore: ObservableObject {
    private static let defaultWriteWorkspace = "default"
    private static let defaultSecretService: String = {
        let bundle = Bundle.main.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !bundle.isEmpty {
            return "\(bundle).relay"
        }
        return "com.yourorg.codexrelay.relay"
    }()
    private static let threadEventsInitialTailLimit = 240
    private static let threadEventsTailStep = 240
    private static let threadEventsTailMax = 3600
    private static let threadEventsFetchLimit = 180
    private static let threadEventsKeepLimit = 2400
    private static let transcriptKeepLimit = 320
    private static let staleCursorRecoveryThreshold: TimeInterval = 75
    private static let staleCursorRecoveryCooldown: TimeInterval = 15
    private static let staleCursorRecoveryTailLimit = 720
    private static let progressPreviewLimit = 140

    @Published var baseURL: String = UserDefaults.standard.string(forKey: "relay.baseURL") ?? ""
    @Published var token: String = UserDefaults.standard.string(forKey: "relay.token") ?? ""
    @Published var workspace: String = UserDefaults.standard.string(forKey: "relay.workspace") ?? "*"
    @Published var writeWorkspace: String = UserDefaults.standard.string(forKey: "relay.writeWorkspace") ?? RelayStore.defaultWriteWorkspace
    @Published var pollSeconds: Int = UserDefaults.standard.integer(forKey: "relay.pollSeconds") == 0 ? 3 : UserDefaults.standard.integer(forKey: "relay.pollSeconds")
    @Published var chatMode: String = UserDefaults.standard.string(forKey: "chat.mode") ?? "default"
    @Published var chatModel: String = UserDefaults.standard.string(forKey: "chat.model") ?? "gpt-5.3-codex"
    @Published var chatReasoningEffort: String = UserDefaults.standard.string(forKey: "chat.reasoningEffort") ?? "xhigh"
    @Published var showThinkingMessages: Bool = {
        if UserDefaults.standard.object(forKey: "chat.showThinkingMessages") == nil {
            return false
        }
        return UserDefaults.standard.bool(forKey: "chat.showThinkingMessages")
    }()
    @Published var accountProfiles: [RelayAccountProfile] = RelayStore.loadAccountProfilesStorage()
    @Published var activeProfileID: String? = UserDefaults.standard.string(forKey: "relay.activeProfileID")

    @Published var status: RunnerStatus?
    @Published var relayRuntimeStatus: RelayRuntimeStatus?
    @Published var currentTask: TaskCurrentResponse.TaskRow?
    @Published var events: [RunEvent] = []
    @Published var approvals: [ApprovalTicket] = []

    @Published var threads: [ChatThread] = []
    @Published var remoteWorkspaces: [String] = []
    @Published var selectedThreadID: String?
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var isSendingMessage = false
    @Published private(set) var stoppingThreadIDs: Set<String> = []
    @Published var usageSummary: UsageSummaryResponse?
    @Published var isUsageLoading = false
    @Published var authReloginRequest: AuthReloginRequest?
    @Published var isAuthReloginLoading = false

    private var threadJobs: [String: [ChatJob]] = [:]
    private var threadEvents: [String: [ChatEvent]] = [:]
    private var threadUserInputRequests: [String: ChatUserInputRequest] = [:]
    private var threadLastSeq: [String: Int] = [:]
    private var threadTailFetchLimit: [String: Int] = [:]
    private var threadTranscriptCache: [String: TranscriptCacheEntry] = [:]
    private var threadPreferences: [String: ChatThreadPreferences] = RelayStore.loadThreadPreferencesStorage()
    private var threadDrafts: [String: String] = RelayStore.loadThreadDraftsStorage()
    private var lastSessionSyncRequestAt: [String: Date] = [:]
    private var threadLastCursorRecoveryAt: [String: Date] = [:]
    private var lastUsageRefreshAt: Date?
    private var lastWorkspacesRefreshAt: Date?
    private var didApplyLaunchEnvironment = false
    private var didRunLaunchE2E = false
    private var isRefreshingNow = false
    private var refreshNowQueued = false
    private var refreshNowNeedsFullThreadList = false

    private let client = RelayClient()
    private let secrets = RelaySecretStore(service: RelayStore.defaultSecretService)
    private var pollTask: Task<Void, Never>?
    private var authReloginPollTask: Task<Void, Never>?
    private static let defaultTokenRef = "default"

    private static func loadThreadPreferencesStorage() -> [String: ChatThreadPreferences] {
        guard let data = UserDefaults.standard.data(forKey: "chat.threadPreferences"),
              let decoded = try? JSONDecoder().decode([String: ChatThreadPreferences].self, from: data) else {
            return [:]
        }
        return decoded
    }

    private static func loadThreadDraftsStorage() -> [String: String] {
        let key = "chat.threadDrafts"
        guard let data = UserDefaults.standard.data(forKey: key), !data.isEmpty else {
            return [:]
        }

        if let decoded = try? JSONDecoder().decode([String: String].self, from: data) {
            return sanitizedThreadDrafts(decoded)
        }

        if let json = try? JSONSerialization.jsonObject(with: data),
           let object = json as? [String: Any] {
            var recovered: [String: String] = [:]
            for (rawKey, rawValue) in object {
                let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !key.isEmpty else { continue }
                if let text = rawValue as? String {
                    recovered[key] = text
                } else if let number = rawValue as? NSNumber {
                    recovered[key] = number.stringValue
                }
            }
            return sanitizedThreadDrafts(recovered)
        }

        UserDefaults.standard.removeObject(forKey: key)
        return [:]
    }

    private static func sanitizedThreadDrafts(_ drafts: [String: String]) -> [String: String] {
        var out: [String: String] = [:]
        for (rawThreadID, rawDraft) in drafts {
            let threadID = rawThreadID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !threadID.isEmpty else { continue }
            guard !rawDraft.isEmpty else { continue }
            out[threadID] = String(rawDraft.prefix(24_000))
            if out.count >= 600 {
                break
            }
        }
        return out
    }

    private static func loadAccountProfilesStorage() -> [RelayAccountProfile] {
        guard let data = UserDefaults.standard.data(forKey: "relay.accountProfiles"),
              let decoded = try? JSONDecoder().decode([RelayAccountProfile].self, from: data) else {
            return []
        }
        return decoded.sorted(by: { $0.updated_at > $1.updated_at })
    }

    var activeAccountProfile: RelayAccountProfile? {
        guard let activeProfileID else { return nil }
        return accountProfiles.first(where: { $0.id == activeProfileID })
    }

    var isConfigured: Bool {
        !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func bootstrap() async {
        migrateTokenStorageIfNeeded()
        if let activeProfileID, !accountProfiles.contains(where: { $0.id == activeProfileID }) {
            self.activeProfileID = nil
            UserDefaults.standard.removeObject(forKey: "relay.activeProfileID")
        }
        if token.isEmpty {
            token = secrets.loadToken(for: currentTokenRef()) ?? ""
        }
        if isUITestSeedModeEnabled {
            seedUITestThreadsIfNeeded()
            return
        }
        if isConfigured {
            startPolling()
            await refreshNow()
        }
    }

    func applyLaunchEnvironmentIfNeeded() {
        guard !didApplyLaunchEnvironment else { return }
        didApplyLaunchEnvironment = true

        let env = ProcessInfo.processInfo.environment
        let envBaseURL = trimmed(env["CODEX_RELAY_BASE_URL"])
        let envToken = trimmed(env["CODEX_RELAY_TOKEN"])
        let envWorkspace = trimmed(env["CODEX_RELAY_WORKSPACE"])
        let envPoll = trimmed(env["CODEX_RELAY_POLL_SECONDS"])
        let envMode = trimmed(env["CODEX_CHAT_MODE"])
        let envModel = trimmed(env["CODEX_CHAT_MODEL"])
        let envEffort = trimmed(env["CODEX_CHAT_REASONING_EFFORT"])

        if !envBaseURL.isEmpty || !envToken.isEmpty || !envWorkspace.isEmpty {
            let nextBaseURL = envBaseURL.isEmpty ? baseURL : envBaseURL
            let nextToken = envToken.isEmpty ? token : envToken
            let nextWorkspace = envWorkspace.isEmpty ? workspace : envWorkspace
            saveConfig(baseURL: nextBaseURL, token: nextToken, workspace: nextWorkspace)
        }

        if let poll = Int(envPoll), poll > 0 {
            setPollSeconds(poll)
        }

        if !envMode.isEmpty {
            setChatMode(envMode)
        }
        if !envModel.isEmpty {
            setChatModel(envModel)
        }
        if !envEffort.isEmpty {
            setChatReasoningEffort(envEffort)
        }
    }

    func runLaunchE2EIfNeeded() async {
        guard !didRunLaunchE2E else { return }
        let env = ProcessInfo.processInfo.environment
        let enable = trimmed(env["CODEX_E2E_AUTO_SEND"]).lowercased()
        guard enable == "1" || enable == "true" || enable == "yes" else { return }
        guard isConfigured else { return }

        didRunLaunchE2E = true
        let title = trimmed(env["CODEX_E2E_THREAD_TITLE"]).isEmpty ? "iPhone Device E2E" : trimmed(env["CODEX_E2E_THREAD_TITLE"])
        let mode = normalizeMode(chatMode)
        let effort = normalizeEffort(chatReasoningEffort)
        let text = trimmed(env["CODEX_E2E_MESSAGE"]).isEmpty
            ? "iPhone \(mode)-mode E2E: confirm cross-workspace sync and include mode+effort (mode=\(mode), effort=\(effort))."
            : trimmed(env["CODEX_E2E_MESSAGE"])

        guard let threadID = await createThread(title: title) else { return }
        await sendMessage(threadID: threadID, text: text)
        await refreshThread(threadID: threadID)
    }

    func saveConfig(baseURL: String, token: String, workspace: String) {
        applyConnection(baseURL: baseURL, token: token, workspace: workspace, writeWorkspace: nil)
        syncActiveProfileWithCurrentConnection()
    }

    func createAccountProfile(name: String) {
        let profileName = trimmed(name).isEmpty ? defaultProfileName() : trimmed(name)
        let id = UUID().uuidString.lowercased()
        let tokenRef = "profile.\(id)"
        if !token.isEmpty {
            _ = secrets.saveToken(token, for: tokenRef)
        }
        let profile = RelayAccountProfile(
            id: id,
            name: profileName,
            base_url: baseURL,
            workspace: workspace,
            write_workspace: writeWorkspace,
            updated_at: nowIso(),
            token_ref: tokenRef
        )
        accountProfiles.insert(profile, at: 0)
        accountProfiles.sort(by: { $0.updated_at > $1.updated_at })
        activeProfileID = profile.id
        persistAccountProfiles()
    }

    func updateActiveAccountProfile(name: String? = nil) {
        guard let activeProfileID,
              let idx = accountProfiles.firstIndex(where: { $0.id == activeProfileID }) else { return }
        var profile = accountProfiles[idx]
        if let name, !trimmed(name).isEmpty {
            profile.name = trimmed(name)
        }
        if trimmed(profile.token_ref).isEmpty {
            profile.token_ref = "profile.\(profile.id)"
        }
        profile.base_url = baseURL
        profile.workspace = workspace
        profile.write_workspace = writeWorkspace
        profile.updated_at = nowIso()
        profile.legacy_token = nil
        if !token.isEmpty {
            _ = secrets.saveToken(token, for: profile.token_ref)
        } else {
            secrets.deleteToken(for: profile.token_ref)
        }
        accountProfiles[idx] = profile
        accountProfiles.sort(by: { $0.updated_at > $1.updated_at })
        persistAccountProfiles()
    }

    func switchAccountProfile(id: String) {
        guard let profile = accountProfiles.first(where: { $0.id == id }) else { return }
        let profileToken = secrets.loadToken(for: profile.token_ref) ?? ""
        activeProfileID = profile.id
        UserDefaults.standard.set(profile.id, forKey: "relay.activeProfileID")
        applyConnection(
            baseURL: profile.base_url,
            token: profileToken,
            workspace: profile.workspace,
            writeWorkspace: profile.write_workspace
        )
    }

    func deleteAccountProfile(id: String) {
        let tokenRefs = accountProfiles.filter { $0.id == id }.map(\.token_ref)
        accountProfiles.removeAll(where: { $0.id == id })
        for tokenRef in tokenRefs {
            secrets.deleteToken(for: tokenRef)
        }
        if activeProfileID == id {
            activeProfileID = nil
            UserDefaults.standard.removeObject(forKey: "relay.activeProfileID")
        }
        persistAccountProfiles()
    }

    func clearActiveAccountProfile() {
        if !token.isEmpty {
            _ = secrets.saveToken(token, for: Self.defaultTokenRef)
        }
        activeProfileID = nil
        UserDefaults.standard.removeObject(forKey: "relay.activeProfileID")
    }

    func defaultProfileName() -> String {
        let host = URL(string: baseURL)?.host ?? baseURL
        let hostPart = trimmed(host).isEmpty ? "Relay" : trimmed(host)
        let workspacePart = workspace == "*" ? "all" : workspace
        return "\(hostPart) • \(workspacePart)"
    }

    func availableWorkspaceOptions() -> [String] {
        var set = Set<String>()
        set.insert("*")
        if !workspace.isEmpty { set.insert(workspace) }
        if !writeWorkspace.isEmpty { set.insert(writeWorkspace) }
        for ws in remoteWorkspaces where !ws.isEmpty {
            set.insert(ws)
        }
        for group in threadWorkspaceGroups() {
            set.insert(group.workspace)
        }
        return set.sorted { lhs, rhs in
            if lhs == "*" { return true }
            if rhs == "*" { return false }
            return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
        }
    }

    func setWorkspace(_ value: String) {
        workspace = normalizeWorkspaceFilter(value)
        UserDefaults.standard.set(workspace, forKey: "relay.workspace")
        if workspace != "*" {
            writeWorkspace = workspace
            UserDefaults.standard.set(workspace, forKey: "relay.writeWorkspace")
        }
        syncActiveProfileWithCurrentConnection()
        Task { await refreshNow() }
    }

    func setPollSeconds(_ value: Int) {
        pollSeconds = value
        UserDefaults.standard.set(value, forKey: "relay.pollSeconds")
        startPolling()
    }

    func setWriteWorkspace(_ value: String) {
        let trimmedValue = trimmed(value)
        writeWorkspace = trimmedValue.isEmpty ? Self.defaultWriteWorkspace : trimmedValue
        UserDefaults.standard.set(writeWorkspace, forKey: "relay.writeWorkspace")
        syncActiveProfileWithCurrentConnection()
    }

    func setChatMode(_ value: String) {
        chatMode = normalizeMode(value)
        UserDefaults.standard.set(chatMode, forKey: "chat.mode")
    }

    func setChatModel(_ value: String) {
        chatModel = trimmed(value)
        UserDefaults.standard.set(chatModel, forKey: "chat.model")
    }

    func setChatReasoningEffort(_ value: String) {
        chatReasoningEffort = normalizeEffort(value)
        UserDefaults.standard.set(chatReasoningEffort, forKey: "chat.reasoningEffort")
    }

    func setShowThinkingMessages(_ enabled: Bool) {
        guard showThinkingMessages != enabled else { return }
        showThinkingMessages = enabled
        threadTranscriptCache.removeAll()
        UserDefaults.standard.set(enabled, forKey: "chat.showThinkingMessages")
    }

    func chatMode(for threadID: String?) -> String {
        preference(for: threadID).mode
    }

    func chatModel(for threadID: String?) -> String {
        preference(for: threadID).model
    }

    func chatReasoningEffort(for threadID: String?) -> String {
        preference(for: threadID).effort
    }

    func setThreadChatMode(_ value: String, threadID: String) {
        updateThreadPreference(threadID: threadID) { current in
            var next = current
            next.mode = normalizeMode(value)
            return next
        }
    }

    func setThreadChatModel(_ value: String, threadID: String) {
        updateThreadPreference(threadID: threadID) { current in
            var next = current
            let model = trimmed(value)
            next.model = model.isEmpty ? defaultPreference().model : model
            return next
        }
    }

    func setThreadChatReasoningEffort(_ value: String, threadID: String) {
        updateThreadPreference(threadID: threadID) { current in
            var next = current
            next.effort = normalizeEffort(value)
            return next
        }
    }

    func threadDraft(for threadID: String) -> String {
        let key = trimmed(threadID)
        guard !key.isEmpty else { return "" }
        return threadDrafts[key] ?? ""
    }

    func setThreadDraft(_ value: String, threadID: String) {
        let key = trimmed(threadID)
        guard !key.isEmpty else { return }

        if value.isEmpty {
            if threadDrafts.removeValue(forKey: key) != nil {
                persistThreadDrafts()
            }
            return
        }

        let safeValue = String(value.prefix(24_000))
        if threadDrafts[key] == safeValue {
            return
        }
        threadDrafts[key] = safeValue
        if threadDrafts.count > 600 {
            let sortedKeys = threadDrafts.keys.sorted()
            for staleKey in sortedKeys.prefix(threadDrafts.count - 600) {
                threadDrafts.removeValue(forKey: staleKey)
            }
        }
        persistThreadDrafts()
    }

    func startPolling() {
        pollTask?.cancel()
        guard isConfigured else { return }

        pollTask = Task {
            while !Task.isCancelled {
                await refreshNow(forceThreadList: false)
                try? await Task.sleep(nanoseconds: UInt64(pollSeconds) * 1_000_000_000)
            }
        }
    }

    func refreshNow(forceThreadList: Bool = true) async {
        guard isConfigured else { return }
        if isRefreshingNow {
            refreshNowQueued = true
            if forceThreadList {
                refreshNowNeedsFullThreadList = true
            }
            return
        }

        isRefreshingNow = true
        isLoading = true
        defer {
            isLoading = false
            isRefreshingNow = false
        }

        var nextPassNeedsFullThreadList = forceThreadList

        while true {
            let fetchFullThreadList = nextPassNeedsFullThreadList || refreshNowNeedsFullThreadList
            refreshNowQueued = false
            refreshNowNeedsFullThreadList = false

            do {
                let opsWorkspace = workspace == "*" ? writeWorkspace : workspace
                async let statusResp: StatusResponse = client.get("legacy-runner/status?workspace=\(encoded(opsWorkspace))", baseURL: baseURL, token: token)
                async let taskResp: TaskCurrentResponse = client.get("legacy-runner/tasks/current?workspace=\(encoded(opsWorkspace))", baseURL: baseURL, token: token)
                async let approvalsResp: ApprovalsResponse = client.get("legacy-runner/approvals?workspace=\(encoded(opsWorkspace))&state=pending", baseURL: baseURL, token: token)
                async let eventsResp: EventsResponse = client.get("legacy-runner/events?workspace=\(encoded(opsWorkspace))&limit=120", baseURL: baseURL, token: token)
                let maxThreadPages = fetchFullThreadList ? 6 : 2
                async let threadsResp: [ChatThread] = fetchThreads(limitPerPage: 100, maxPages: maxThreadPages)

                let s = try await statusResp
                let t = try await taskResp
                let a = try await approvalsResp
                let e = try await eventsResp
                let chats = try await threadsResp

                status = s.status
                currentTask = t.task
                approvals = a.approvals
                events = e.events
                threads = chats
                let threadIDSet = Set(chats.map(\.thread_id))
                threadUserInputRequests = threadUserInputRequests.filter { threadIDSet.contains($0.key) }
                threadTailFetchLimit = threadTailFetchLimit.filter { threadIDSet.contains($0.key) }
                threadLastCursorRecoveryAt = threadLastCursorRecoveryAt.filter { threadIDSet.contains($0.key) }

                if selectedThreadID == nil {
                    selectedThreadID = threads.first?.thread_id
                } else if let selected = selectedThreadID, !threads.contains(where: { $0.thread_id == selected }) {
                    selectedThreadID = threads.first?.thread_id
                }

                if let selected = selectedThreadID {
                    try await refreshThreadEvents(threadID: selected)
                }

                await refreshRelayRuntimeStatus(workspaceScope: statusWorkspaceScope())
                errorMessage = nil
                await refreshUsageSummary()
                await refreshRemoteWorkspaces()
            } catch {
                errorMessage = userFacingErrorMessage(error)
            }

            if !refreshNowQueued {
                break
            }
            nextPassNeedsFullThreadList = refreshNowNeedsFullThreadList
        }
    }

    func refreshThread(threadID: String) async {
        guard isConfigured else { return }
        do {
            let detail: ChatThreadResponse = try await client.get("codex-iphone-connector/chat/threads/\(encodedPath(threadID))", baseURL: baseURL, token: token)
            upsertThread(detail.thread)
            if let jobs = detail.jobs {
                threadJobs[threadID] = jobs
            }
            if let request = detail.user_input_request,
               normalizeTurnStatus(request.status) == "pending" {
                threadUserInputRequests[threadID] = request
            } else {
                threadUserInputRequests.removeValue(forKey: threadID)
            }
            try await refreshThreadEvents(threadID: threadID)
            errorMessage = nil
        } catch {
            errorMessage = userFacingErrorMessage(error)
        }
    }

    func createThread(workspace explicitWorkspace: String? = nil, title: String = "") async -> String? {
        guard isConfigured else { return nil }
        struct Body: Encodable {
            let workspace: String
            let title: String
        }
        do {
            let targetWorkspace = trimmed(explicitWorkspace).isEmpty
                ? workspaceForWrite(threadID: nil)
                : trimmed(explicitWorkspace)
            let response: ChatThreadCreateResponse = try await client.post(
                "codex-iphone-connector/chat/threads",
                baseURL: baseURL,
                token: token,
                body: Body(workspace: targetWorkspace, title: title)
            )
            upsertThread(response.thread)
            if threadPreferences[response.thread.thread_id] == nil {
                updateThreadPreference(threadID: response.thread.thread_id) { _ in defaultPreference() }
            }
            selectedThreadID = response.thread.thread_id
            return response.thread.thread_id
        } catch {
            errorMessage = userFacingErrorMessage(error)
            return nil
        }
    }

    func deleteThread(threadID: String) async {
        guard isConfigured else { return }
        struct Body: Encodable {
            let requested_by: String
        }
        do {
            let _: ChatThreadDeleteResponse = try await client.post(
                "codex-iphone-connector/chat/threads/\(encodedPath(threadID))/delete",
                baseURL: baseURL,
                token: token,
                body: Body(requested_by: "ios-delete-thread")
            )
            threads.removeAll(where: { $0.thread_id == threadID })
            threadJobs.removeValue(forKey: threadID)
            threadEvents.removeValue(forKey: threadID)
            threadUserInputRequests.removeValue(forKey: threadID)
            threadLastSeq.removeValue(forKey: threadID)
            threadTailFetchLimit.removeValue(forKey: threadID)
            threadLastCursorRecoveryAt.removeValue(forKey: threadID)
            threadTranscriptCache.removeValue(forKey: threadID)
            threadPreferences.removeValue(forKey: threadID)
            threadDrafts.removeValue(forKey: threadID)
            persistThreadPreferences()
            persistThreadDrafts()
            if selectedThreadID == threadID {
                selectedThreadID = threads.first?.thread_id
            }
            errorMessage = nil
            await refreshNow()
        } catch {
            errorMessage = userFacingErrorMessage(error)
        }
    }

    func interruptThread(threadID: String) async {
        guard isConfigured else { return }
        if stoppingThreadIDs.contains(threadID) { return }
        stoppingThreadIDs.insert(threadID)
        defer { stoppingThreadIDs.remove(threadID) }

        struct Body: Encodable {
            let requested_by: String
        }

        do {
            let response: ChatThreadInterruptResponse = try await client.post(
                "codex-iphone-connector/chat/threads/\(encodedPath(threadID))/interrupt",
                baseURL: baseURL,
                token: token,
                body: Body(requested_by: "ios-stop-button")
            )
            upsertThread(response.thread)
            if let updatedJob = response.job {
                var jobs = threadJobs[threadID] ?? []
                if let existingIndex = jobs.firstIndex(where: { $0.job_id == updatedJob.job_id }) {
                    jobs[existingIndex] = updatedJob
                } else {
                    jobs.insert(updatedJob, at: 0)
                }
                threadJobs[threadID] = jobs
            }
            try await refreshThreadEvents(threadID: threadID)
            errorMessage = nil
        } catch {
            errorMessage = userFacingErrorMessage(error)
        }
    }

    func sendMessage(threadID: String, text: String, inputItems: [ChatInputItem] = []) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedItems = normalizeInputItems(inputItems)
        guard isConfigured, !trimmed.isEmpty || !normalizedItems.isEmpty else { return }
        struct Body: Encodable {
            let workspace: String
            let input_text: String
            let input_items: [ChatInputItem]
            let idempotency_key: String
            let replace_running: Bool
            let policy: ChatPolicy
        }
        isSendingMessage = true
        defer { isSendingMessage = false }
        do {
            let targetWorkspace = workspaceForWrite(threadID: threadID)
            let policy = buildChatPolicy(for: threadID)
            let response: ChatMessageResponse = try await client.post(
                "codex-iphone-connector/chat/threads/\(encodedPath(threadID))/messages",
                baseURL: baseURL,
                token: token,
                body: Body(
                    workspace: targetWorkspace,
                    input_text: trimmed,
                    input_items: normalizedItems,
                    idempotency_key: UUID().uuidString,
                    replace_running: true,
                    policy: policy
                )
            )
            upsertThread(response.thread)
            var jobs = threadJobs[response.thread.thread_id] ?? []
            if let existingIndex = jobs.firstIndex(where: { $0.job_id == response.job.job_id }) {
                jobs[existingIndex] = response.job
            } else {
                jobs.insert(response.job, at: 0)
            }
            threadJobs[response.thread.thread_id] = jobs
            applyThreadStatusLocally(
                threadID: response.thread.thread_id,
                status: response.job.status,
                updatedAt: response.job.updated_at
            )
            threadUserInputRequests.removeValue(forKey: response.thread.thread_id)
            selectedThreadID = response.thread.thread_id
            try await refreshThreadEvents(threadID: response.thread.thread_id)
            errorMessage = nil
        } catch {
            errorMessage = userFacingErrorMessage(error)
        }
    }

    func sendMessageToNewThread(_ text: String) async -> String? {
        guard let threadID = await createThread() else { return nil }
        await sendMessage(threadID: threadID, text: text)
        return threadID
    }

    func refreshThreadEvents(
        threadID: String,
        forceFull: Bool = false,
        forceTailWindow: Int? = nil
    ) async throws {
        let existingEvents = threadEvents[threadID] ?? []
        let currentTailWindow = max(
            Self.threadEventsInitialTailLimit,
            min(Self.threadEventsTailMax, threadTailFetchLimit[threadID] ?? Self.threadEventsInitialTailLimit)
        )
        if threadTailFetchLimit[threadID] == nil {
            threadTailFetchLimit[threadID] = currentTailWindow
        }

        let normalizedForceTailWindow = forceTailWindow.map {
            max(Self.threadEventsInitialTailLimit, min(Self.threadEventsTailMax, $0))
        }
        if let normalizedForceTailWindow {
            threadTailFetchLimit[threadID] = normalizedForceTailWindow
        }

        let afterSeq: Int
        let shouldTailFetch: Bool
        let fetchLimit: Int
        if let normalizedForceTailWindow {
            afterSeq = 0
            shouldTailFetch = true
            fetchLimit = normalizedForceTailWindow
        } else {
            afterSeq = forceFull ? 0 : (threadLastSeq[threadID] ?? 0)
            shouldTailFetch = !forceFull && afterSeq == 0 && existingEvents.isEmpty
            fetchLimit = shouldTailFetch ? currentTailWindow : Self.threadEventsFetchLimit
        }

        let response: ChatEventsResponse = try await client.get(
            chatEventsPath(
                threadID: threadID,
                afterSeq: afterSeq,
                limit: fetchLimit,
                tail: shouldTailFetch
            ),
            baseURL: baseURL,
            token: token
        )

        if response.events.isEmpty {
            if shouldRecoverStaleEventCursor(
                threadID: threadID,
                afterSeq: afterSeq,
                shouldTailFetch: shouldTailFetch,
                existingEvents: existingEvents
            ) {
                threadLastCursorRecoveryAt[threadID] = Date()
                let recoveryLimit = max(currentTailWindow, Self.staleCursorRecoveryTailLimit)
                let recovery: ChatEventsResponse = try await client.get(
                    chatEventsPath(
                        threadID: threadID,
                        afterSeq: 0,
                        limit: recoveryLimit,
                        tail: true
                    ),
                    baseURL: baseURL,
                    token: token
                )
                guard !recovery.events.isEmpty else { return }
                applyThreadEventsResponse(
                    recovery,
                    threadID: threadID,
                    replaceExisting: true,
                    resetCursor: true
                )
            }
            return
        }

        applyThreadEventsResponse(
            response,
            threadID: threadID,
            replaceExisting: forceFull,
            resetCursor: false
        )
    }

    private func applyThreadEventsResponse(
        _ response: ChatEventsResponse,
        threadID: String,
        replaceExisting: Bool,
        resetCursor: Bool
    ) {
        var current = replaceExisting ? [] : (threadEvents[threadID] ?? [])
        var existingSeq = Set(current.map { $0.seq })
        var latestStatus: (status: String, ts: String?)?
        for event in response.events where !existingSeq.contains(event.seq) {
            current.append(event)
            existingSeq.insert(event.seq)
            if let inferred = inferredThreadStatus(for: event), !inferred.isEmpty {
                latestStatus = (inferred, event.ts)
            }
            if event.type == "user.input.responded" {
                threadUserInputRequests.removeValue(forKey: threadID)
            }
        }
        current.sort(by: { $0.seq < $1.seq })
        if current.count > Self.threadEventsKeepLimit {
            current = Array(current.suffix(Self.threadEventsKeepLimit))
        }
        threadEvents[threadID] = current
        threadTranscriptCache.removeValue(forKey: threadID)

        if resetCursor {
            threadLastSeq[threadID] = response.last_seq
        } else {
            threadLastSeq[threadID] = max(threadLastSeq[threadID] ?? 0, response.last_seq)
        }

        if let latestStatus {
            applyThreadStatusLocally(
                threadID: threadID,
                status: latestStatus.status,
                updatedAt: latestStatus.ts ?? nowIso()
            )
        }
    }

    private func shouldRecoverStaleEventCursor(
        threadID: String,
        afterSeq: Int,
        shouldTailFetch: Bool,
        existingEvents: [ChatEvent]
    ) -> Bool {
        guard afterSeq > 0 else { return false }
        guard !shouldTailFetch else { return false }

        let now = Date()
        if let lastRecovery = threadLastCursorRecoveryAt[threadID],
           now.timeIntervalSince(lastRecovery) < Self.staleCursorRecoveryCooldown {
            return false
        }

        guard let thread = threads.first(where: { $0.thread_id == threadID }) else {
            return false
        }
        guard let threadUpdatedAt = parseISODate(thread.updated_at) else {
            return existingEvents.isEmpty
        }
        guard let latestEventAt = parseISODate(existingEvents.last?.ts) else {
            return true
        }
        return threadUpdatedAt.timeIntervalSince(latestEventAt) > Self.staleCursorRecoveryThreshold
    }

    func refreshThreadEventsSilently(threadID: String) async {
        do {
            try await refreshThreadEvents(threadID: threadID)
        } catch {
            // keep UI responsive; polling failures should not break chat view
        }
    }

    func historyWindowLabel(threadID: String) -> String {
        let current = max(
            Self.threadEventsInitialTailLimit,
            min(Self.threadEventsTailMax, threadTailFetchLimit[threadID] ?? Self.threadEventsInitialTailLimit)
        )
        return "Latest \(current) events"
    }

    func canLoadMoreHistory(threadID: String) -> Bool {
        let current = max(
            Self.threadEventsInitialTailLimit,
            min(Self.threadEventsTailMax, threadTailFetchLimit[threadID] ?? Self.threadEventsInitialTailLimit)
        )
        return current < Self.threadEventsTailMax
    }

    @discardableResult
    func loadMoreHistory(threadID: String) async -> Bool {
        let current = max(
            Self.threadEventsInitialTailLimit,
            min(Self.threadEventsTailMax, threadTailFetchLimit[threadID] ?? Self.threadEventsInitialTailLimit)
        )
        guard current < Self.threadEventsTailMax else { return false }
        let next = min(Self.threadEventsTailMax, current + Self.threadEventsTailStep)
        threadTailFetchLimit[threadID] = next
        do {
            try await refreshThreadEvents(threadID: threadID, forceTailWindow: next)
            errorMessage = nil
            return true
        } catch {
            threadTailFetchLimit[threadID] = current
            errorMessage = userFacingErrorMessage(error)
            return false
        }
    }

    func isThreadInFlight(threadID: String) -> Bool {
        guard let thread = threads.first(where: { $0.thread_id == threadID }) else { return false }
        return isActiveThreadStatus(thread.status)
    }

    func isInterruptingThread(threadID: String) -> Bool {
        stoppingThreadIDs.contains(threadID)
    }

    func pendingUserInputRequest(for threadID: String) -> ChatUserInputRequest? {
        guard let request = threadUserInputRequests[threadID] else { return nil }
        return normalizeTurnStatus(request.status) == "pending" ? request : nil
    }

    @discardableResult
    func submitUserInputRequest(
        threadID: String,
        requestID: String,
        answers: [String: ChatUserInputAnswerPayload]
    ) async -> Bool {
        guard isConfigured else { return false }
        guard !answers.isEmpty else { return false }

        struct Body: Encodable {
            let request_id: String
            let answers: [String: ChatUserInputAnswerPayload]
        }

        do {
            let response: ChatUserInputRespondResponse = try await client.post(
                "codex-iphone-connector/chat/threads/\(encodedPath(threadID))/user-input/respond",
                baseURL: baseURL,
                token: token,
                body: Body(request_id: requestID, answers: answers)
            )
            if normalizeTurnStatus(response.request.status) == "pending" {
                threadUserInputRequests[threadID] = response.request
            } else {
                threadUserInputRequests.removeValue(forKey: threadID)
            }
            await refreshThread(threadID: threadID)
            errorMessage = nil
            return true
        } catch {
            errorMessage = userFacingErrorMessage(error)
            return false
        }
    }

    func threadProgressSummary(threadID: String) -> String? {
        let events = threadEvents[threadID] ?? []
        let thread = threads.first(where: { $0.thread_id == threadID })
        let threadStatus = normalizeTurnStatus(thread?.status)
        let preferRunningLabel = [
            "running",
            "claimed",
            "streaming",
            "active",
            "inprogress",
            "in_progress",
        ].contains(threadStatus)
        guard !events.isEmpty else {
            if let thread, isActiveThreadStatus(thread.status) {
                return displayStatusLabel(thread.status)
            }
            return nil
        }

        for event in events.reversed() {
            if let inferred = inferredThreadStatus(for: event), !inferred.isEmpty {
                if preferRunningLabel && inferred == "queued" {
                    continue
                }
                return displayStatusLabel(inferred)
            }
            if event.type == "job.interrupt_requested" {
                return "Stop requested from iPhone."
            }
        }

        if let thread, isActiveThreadStatus(thread.status) {
            return displayStatusLabel(thread.status)
        }
        return nil
    }

    func transcript(for threadID: String) -> [ChatTranscriptMessage] {
        let events = threadEvents[threadID] ?? []
        let signature = transcriptSignature(for: events)
        if let cached = threadTranscriptCache[threadID], cached.signature == signature {
            return cached.messages
        }
        var messages: [ChatTranscriptMessage] = []
        let includeInternalProgress = showThinkingMessages

        for event in events {
            if event.type == "user.message" || event.type == "assistant.message" {
                let role = event.type == "user.message" ? "user" : "assistant"
                let payloadText =
                    jsonString(event.payload, path: ["text"]) ??
                    jsonString(event.payload, path: ["params", "text"]) ??
                    jsonString(event.payload, path: ["params", "message"])
                let text = event.delta ?? payloadText ?? ""
                let attachments = transcriptAttachments(for: event)

                if role == "assistant" {
                    let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if attachments.isEmpty,
                       !trimmedText.isEmpty,
                       let last = messages.last,
                       last.role == "assistant",
                       last.attachments.isEmpty,
                       last.text.trimmingCharacters(in: .whitespacesAndNewlines) == trimmedText {
                        continue
                    }
                }

                appendTranscriptMessage(
                    &messages,
                    threadID: threadID,
                    role: role,
                    text: text,
                    ts: event.ts,
                    attachments: attachments
                )
                continue
            }

            if event.type == "assistant.delta", let delta = event.delta, !delta.isEmpty {
                appendTranscriptMessage(
                    &messages,
                    threadID: threadID,
                    role: "assistant",
                    text: delta,
                    ts: event.ts,
                    mergeIfSameRole: true
                )
                continue
            }

            if includeInternalProgress,
               let progress = assistantProgressText(for: event),
               !progress.isEmpty {
                if let last = messages.last,
                   last.role == "assistant",
                   last.attachments.isEmpty,
                   last.text.trimmingCharacters(in: .whitespacesAndNewlines) == progress.trimmingCharacters(in: .whitespacesAndNewlines) {
                    continue
                }
                appendTranscriptMessage(
                    &messages,
                    threadID: threadID,
                    role: "assistant",
                    text: progress,
                    ts: event.ts
                )
                continue
            }

            if includeInternalProgress, let thinking = thinkingText(for: event), !thinking.isEmpty {
                appendTranscriptMessage(
                    &messages,
                    threadID: threadID,
                    role: "thinking",
                    text: thinking,
                    ts: event.ts,
                    mergeIfSameRole: true
                )
                continue
            }

            if includeInternalProgress,
               let lifecycle = itemLifecycleEventText(for: event),
               !lifecycle.isEmpty {
                appendTranscriptMessage(
                    &messages,
                    threadID: threadID,
                    role: "system",
                    text: lifecycle,
                    ts: event.ts
                )
                continue
            }

            if includeInternalProgress,
               shouldIncludeSystemEventInTranscript(event),
               let system = systemEventText(for: event),
               !system.isEmpty {
                appendTranscriptMessage(
                    &messages,
                    threadID: threadID,
                    role: "system",
                    text: system,
                    ts: event.ts
                )
            }
        }

        if messages.count > Self.transcriptKeepLimit {
            messages = Array(messages.suffix(Self.transcriptKeepLimit))
        }
        threadTranscriptCache[threadID] = TranscriptCacheEntry(signature: signature, messages: messages)
        return messages
    }

    private func appendTranscriptMessage(
        _ messages: inout [ChatTranscriptMessage],
        threadID: String,
        role: String,
        text: String,
        ts: String?,
        attachments: [ChatTranscriptAttachment] = [],
        mergeIfSameRole: Bool = false
    ) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if mergeIfSameRole {
            guard !text.isEmpty || !attachments.isEmpty else { return }
            if attachments.isEmpty,
               let last = messages.last,
               last.role == role,
               last.attachments.isEmpty {
                messages[messages.count - 1].text += text
                return
            }
            messages.append(ChatTranscriptMessage(
                id: "\(threadID)-\(role)-\(messages.count + 1)",
                role: role,
                text: text,
                ts: ts,
                attachments: attachments
            ))
            return
        }

        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        messages.append(ChatTranscriptMessage(
            id: "\(threadID)-\(role)-\(messages.count + 1)",
            role: role,
            text: trimmed.isEmpty ? "" : trimmed,
            ts: ts,
            attachments: attachments
        ))
    }

    private func transcriptAttachments(for event: ChatEvent) -> [ChatTranscriptAttachment] {
        let items = jsonArray(event.payload, path: ["input_items"]) ??
            jsonArray(event.payload, path: ["params", "input_items"]) ?? []
        guard !items.isEmpty else { return [] }

        var attachments: [ChatTranscriptAttachment] = []
        for (index, item) in items.prefix(8).enumerated() {
            let type = normalizeTurnStatus(jsonString(item, path: ["type"]))
            if type == "image" || type == "input_image" || type.isEmpty {
                let url = (
                    jsonString(item, path: ["url"]) ??
                    jsonString(item, path: ["image_url"]) ??
                    ""
                ).trimmingCharacters(in: .whitespacesAndNewlines)
                if !url.isEmpty {
                    attachments.append(ChatTranscriptAttachment(
                        id: "\(event.id)-image-\(index)",
                        type: "image",
                        url: url,
                        path: nil
                    ))
                    continue
                }
            }

            if type == "localimage" || type == "local_image" {
                let path = (jsonString(item, path: ["path"]) ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !path.isEmpty {
                    attachments.append(ChatTranscriptAttachment(
                        id: "\(event.id)-local-image-\(index)",
                        type: "localImage",
                        url: nil,
                        path: path
                    ))
                }
            }
        }
        return attachments
    }

    private func assistantProgressText(for event: ChatEvent) -> String? {
        switch event.type {
        case "rpc.agent_message":
            return (jsonString(event.payload, path: ["params", "message"]) ??
                jsonString(event.payload, path: ["params", "text"]))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        case "rpc.event_msg":
            let payloadType = normalizeTurnStatus(jsonString(event.payload, path: ["params", "payload", "type"]))
            guard payloadType == "agent_message" else { return nil }
            return (jsonString(event.payload, path: ["params", "payload", "message"]) ??
                jsonString(event.payload, path: ["params", "payload", "text"]))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        default:
            return nil
        }
    }

    private func itemLifecycleEventText(for event: ChatEvent) -> String? {
        switch event.type {
        case "rpc.item.started":
            return itemLifecycleText(for: event, started: true)
        case "rpc.item.completed":
            return itemLifecycleText(for: event, started: false)
        default:
            return nil
        }
    }

    private func thinkingText(for event: ChatEvent) -> String? {
        switch event.type {
        case "rpc.agent_reasoning":
            return jsonString(event.payload, path: ["params", "text"]) ??
                jsonString(event.payload, path: ["params", "message"])
        case "rpc.item.reasoning.summaryTextDelta", "rpc.item.reasoning.summary_text_delta":
            return jsonString(event.payload, path: ["params", "delta"]) ?? event.delta
        case "rpc.item.reasoning.textDelta", "rpc.item.reasoning.text_delta":
            return jsonString(event.payload, path: ["params", "delta"]) ?? event.delta
        case "rpc.item.reasoning.summaryPartAdded", "rpc.item.reasoning.summary_part_added":
            return "Thinking..."
        case "rpc.event_msg":
            let payloadType = normalizeTurnStatus(jsonString(event.payload, path: ["params", "payload", "type"]))
            guard payloadType == "agent_reasoning" else { return nil }
            return jsonString(event.payload, path: ["params", "payload", "text"]) ??
                jsonString(event.payload, path: ["params", "payload", "message"])
        case "rpc.item.plan.delta", "rpc.item.planDelta", "rpc.item.plan_delta":
            let delta = jsonString(event.payload, path: ["params", "delta"]) ?? event.delta
            guard let delta, !delta.isEmpty else { return nil }
            return delta
        case "rpc.turn.plan.updated", "rpc.turn.plan_updated":
            return turnPlanText(for: event)
        case "rpc.item.completed":
            return reasoningItemSummaryText(for: event)
        default:
            let normalized = event.type.lowercased()
            if normalized.contains("reasoning") && normalized.contains("delta") {
                return jsonString(event.payload, path: ["params", "delta"]) ?? event.delta
            }
            if normalized.contains("plan") && normalized.contains("delta") {
                return jsonString(event.payload, path: ["params", "delta"]) ?? event.delta
            }
            return nil
        }
    }

    private func systemEventText(for event: ChatEvent) -> String? {
        let normalized = event.type
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "_", with: "")
            .lowercased()
        if normalized == "rpc.item.started" || normalized == "rpc.item.completed" {
            return nil
        }
        if normalized.contains("commandexecution.outputdelta")
            || normalized.contains("filechange.outputdelta")
            || normalized.contains("mcptoolcall.progress")
            || normalized.contains("turn.diff.updated")
            || normalized.contains("turn.diffupdated") {
            return nil
        }

        switch event.type {
        case "job.queued":
            return "Queued on desktop connector."
        case "job.claimed":
            return "Picked up by desktop connector."
        case "job.running", "job.started":
            return "Running on desktop connector."
        case "thread.bound":
            return threadBoundText(for: event)
        case "job.completed":
            return "Run completed on desktop."
        case "job.interrupt_requested":
            return "Stop requested from iPhone."
        case "job.interrupted":
            return "Stopped on desktop."
        case "job.timeout":
            return "Timed out on desktop."
        case "job.failed":
            let code = (jsonString(event.payload, path: ["error_code"]) ?? "").lowercased()
            if code == "turn_interrupted" {
                return "Stopped on desktop."
            }
            if code == "turn_timeout" {
                return "Timed out on desktop."
            }
            if isSessionNotLoadedEvent(event) {
                return "Session not loaded on desktop."
            }
            return event.delta?.isEmpty == false ? event.delta : "Run failed on desktop."
        case "job.waiting_on_user_input":
            return "Waiting for user input on iPhone."
        case "rpc.turn.started":
            return "Turn started."
        case "rpc.turn.completed":
            return turnCompletedText(for: event)
        case "rpc.turn.interrupted":
            return "Stopped on desktop."
        case "rpc.turn.timeout", "rpc.turn.timed_out":
            return "Timed out on desktop."
        case "rpc.turn.failed":
            if isSessionNotLoadedEvent(event) {
                return "Session not loaded on desktop."
            }
            return "Run failed on desktop."
        case "rpc.context_compacted":
            return "Context compacted."
        case "rpc.event_msg":
            let payloadType = normalizeTurnStatus(jsonString(event.payload, path: ["params", "payload", "type"]))
            if payloadType == "context_compacted" {
                return "Context compacted."
            }
            return nil
        case "rpc.thread.status.changed":
            return threadStatusChangedText(for: event)
        default:
            return nil
        }
    }

    private func threadBoundText(for event: ChatEvent) -> String? {
        let externalThreadID = (jsonString(event.payload, path: ["external_thread_id"]) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !externalThreadID.isEmpty else {
            return "Bound to desktop session."
        }
        if externalThreadID.count <= 18 {
            return "Bound to desktop session \(externalThreadID)."
        }
        return "Bound to desktop session \(externalThreadID.prefix(18))…"
    }

    private func turnCompletedText(for event: ChatEvent) -> String? {
        let status = normalizeTurnStatus(jsonString(event.payload, path: ["params", "turn", "status"]))
        if status.isEmpty {
            return nil
        }
        if status == "completed" {
            return nil
        }
        if ["interrupted", "cancelled", "canceled", "aborted", "stopped"].contains(status) {
            return "Stopped on desktop."
        }
        if status == "timed_out" || status == "timeout" {
            return "Timed out on desktop."
        }
        if status == "failed" {
            let code = jsonString(event.payload, path: ["params", "turn", "error", "code"])
            let reason = jsonString(event.payload, path: ["params", "turn", "error", "message"])
            if isSessionNotLoadedCode(code) || isSessionNotLoadedMessage(reason) {
                return "Session not loaded on desktop."
            }
            if let reason, !reason.isEmpty {
                return "Run failed: \(reason)"
            }
            return "Run failed on desktop."
        }
        return "Turn finished with status: \(status)."
    }

    private func turnPlanText(for event: ChatEvent) -> String? {
        let explanation = jsonString(event.payload, path: ["params", "explanation"])?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let steps = jsonArray(event.payload, path: ["params", "plan"]) ?? []
        if steps.isEmpty {
            if let explanation, !explanation.isEmpty {
                return "Plan: \(explanation)"
            }
            return "Plan updated."
        }

        var renderedSteps: [String] = []
        for step in steps.prefix(5) {
            let stepText = jsonString(step, path: ["step"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let status = jsonString(step, path: ["status"])?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            guard !stepText.isEmpty else { continue }
            if status.isEmpty {
                renderedSteps.append(stepText)
            } else {
                renderedSteps.append("[\(planStatusLabel(status))] \(stepText)")
            }
        }
        if renderedSteps.isEmpty {
            return explanation?.isEmpty == false ? "Plan: \(explanation!)" : "Plan updated."
        }
        let body = renderedSteps.joined(separator: "\n")
        if let explanation, !explanation.isEmpty {
            return "Plan updated: \(explanation)\n\(body)"
        }
        return "Plan updated:\n\(body)"
    }

    private func itemLifecycleText(for event: ChatEvent, started: Bool) -> String? {
        guard let item = jsonValue(event.payload, path: ["params", "item"]) else { return nil }
        let itemType = (jsonString(item, path: ["type"]) ?? "").lowercased()
        if itemType.isEmpty { return nil }

        switch itemType {
        case "commandexecution":
            let commandRaw = jsonString(item, path: ["command"]) ?? ""
            let command = commandRaw.isEmpty ? "command" : summarizeCommand(commandRaw)
            if started {
                return "Running \(command)"
            }
            let status = (jsonString(item, path: ["status"]) ?? "completed").lowercased()
            if status == "completed" {
                return "Ran \(command)"
            }
            if status == "failed" {
                let code = jsonString(item, path: ["exitCode"]) ?? ""
                if !code.isEmpty {
                    return "Command failed (\(code)): \(command)"
                }
                return "Command failed: \(command)"
            }
            return "Command \(status): \(command)"
        case "filechange":
            if started { return "Applying file changes..." }
            let status = (jsonString(item, path: ["status"]) ?? "completed").lowercased()
            if status == "completed" { return "Updated files." }
            return "File changes \(status)."
        case "mcptoolcall":
            let server = jsonString(item, path: ["server"]) ?? "mcp"
            let tool = jsonString(item, path: ["tool"]) ?? "tool"
            if started {
                return "Tool running: \(server)/\(tool)"
            }
            let status = (jsonString(item, path: ["status"]) ?? "completed").lowercased()
            return "Tool \(status): \(server)/\(tool)"
        case "plan":
            if started { return "Planning..." }
            let planText = jsonString(item, path: ["text"])?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let planText, !planText.isEmpty {
                return "Plan:\n\(planText)"
            }
            return "Plan completed."
        case "contextcompaction":
            return started ? "Compacting context..." : "Context compacted."
        default:
            return nil
        }
    }

    private func reasoningItemSummaryText(for event: ChatEvent) -> String? {
        guard let item = jsonValue(event.payload, path: ["params", "item"]) else { return nil }
        let itemType = (jsonString(item, path: ["type"]) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard itemType == "reasoning" else { return nil }
        guard let summaryParts = jsonArray(item, path: ["summary"]), !summaryParts.isEmpty else { return nil }
        let lines = summaryParts
            .compactMap(\.stringValue)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return nil }
        return lines.joined(separator: "\n")
    }

    private func isSessionNotLoadedCode(_ raw: String?) -> Bool {
        let code = normalizeTurnStatus(raw).replacingOccurrences(of: ".", with: "_")
        return [
            "session_not_loaded",
            "session_not_found",
            "thread_not_found",
            "thread_not_loaded",
            "notloaded",
            "not_loaded",
        ].contains(code)
    }

    private func isSessionNotLoadedMessage(_ raw: String?) -> Bool {
        let message = normalizeTurnStatus(raw)
        guard !message.isEmpty else { return false }
        return message.contains("session not loaded")
            || message.contains("session_not_loaded")
            || message.contains("session not found")
            || message.contains("session_not_found")
            || message.contains("thread not found")
            || message.contains("thread_not_found")
            || message.contains("no rollout found for thread id")
            || message.contains("no archived rollout found")
            || message.contains("rollout not found")
            || message.contains("missing rollout")
    }

    private func isSessionNotLoadedEvent(_ event: ChatEvent) -> Bool {
        let codes: [String?] = [
            jsonString(event.payload, path: ["error_code"]),
            jsonString(event.payload, path: ["params", "error_code"]),
            jsonString(event.payload, path: ["params", "error", "code"]),
            jsonString(event.payload, path: ["params", "turn", "error", "code"]),
            event.delta,
        ]
        if codes.contains(where: { isSessionNotLoadedCode($0) }) {
            return true
        }

        let messages: [String?] = [
            event.delta,
            jsonString(event.payload, path: ["error_message"]),
            jsonString(event.payload, path: ["params", "error_message"]),
            jsonString(event.payload, path: ["params", "message"]),
            jsonString(event.payload, path: ["params", "error", "message"]),
            jsonString(event.payload, path: ["params", "turn", "error", "message"]),
        ]
        return messages.contains(where: { isSessionNotLoadedMessage($0) })
    }

    private func threadStatusChangedText(for event: ChatEvent) -> String? {
        let raw = normalizedThreadStatusFromEvent(event)
        guard !raw.isEmpty else { return nil }
        switch raw {
        case "queued":
            return "Queued on desktop connector."
        case "claimed":
            return "Picked up by desktop connector."
        case "running", "streaming", "inprogress", "in_progress", "active":
            return "Running on desktop connector."
        case "interrupted", "cancelled", "canceled", "aborted", "stopped":
            return "Stopped on desktop."
        case "timeout", "timed_out":
            return "Timed out on desktop."
        case "failed":
            if isSessionNotLoadedEvent(event) {
                return "Session not loaded on desktop."
            }
            return "Run failed on desktop."
        case "completed", "idle":
            return "Run completed on desktop."
        case "notloaded", "not_loaded", "session_not_loaded", "session_not_found":
            return "Session not loaded."
        case "waiting_on_approval":
            return "Waiting for approval on desktop."
        case "waiting_on_user_input":
            return "Waiting for user input on desktop."
        default:
            return "Thread status: \(raw)."
        }
    }

    private func shouldIncludeSystemEventInTranscript(_ event: ChatEvent) -> Bool {
        switch event.type {
        case "job.interrupt_requested",
             "job.interrupted",
             "job.timeout",
             "job.failed",
             "rpc.turn.interrupted",
             "rpc.turn.timeout",
             "rpc.turn.timed_out",
             "rpc.turn.failed",
             "rpc.context_compacted":
            return true
        case "rpc.event_msg":
            let payloadType = normalizeTurnStatus(jsonString(event.payload, path: ["params", "payload", "type"]))
            return payloadType == "context_compacted"
        default:
            return false
        }
    }

    private func commandOutputDeltaText(for event: ChatEvent) -> String? {
        let delta = jsonString(event.payload, path: ["params", "delta"]) ?? event.delta ?? ""
        let summarized = summarizeDeltaBlock(delta)
        guard !summarized.isEmpty else { return nil }
        return "Output:\n\(summarized)"
    }

    private func fileChangeDeltaText(for event: ChatEvent) -> String? {
        let delta = jsonString(event.payload, path: ["params", "delta"]) ?? event.delta ?? ""
        let summarized = summarizeDeltaBlock(delta)
        guard !summarized.isEmpty else { return nil }
        return "Patch:\n\(summarized)"
    }

    private func mcpProgressText(for event: ChatEvent) -> String? {
        let text = (
            jsonString(event.payload, path: ["params", "message"]) ??
            jsonString(event.payload, path: ["params", "delta"]) ??
            jsonString(event.payload, path: ["params", "progress", "message"]) ??
            jsonString(event.payload, path: ["params", "progress"])
        )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return nil }
        return "Tool progress: \(text)"
    }

    private func summarizeDeltaBlock(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let lines = trimmed.split(whereSeparator: \.isNewline).map(String.init)
        let head = lines.prefix(6).joined(separator: "\n")
        var compact = head
        if lines.count > 6 {
            compact += "\n…"
        }
        if compact.count <= 420 { return compact }
        return "\(compact.prefix(420))…"
    }

    private func turnDiffText(for event: ChatEvent) -> String? {
        let diff = jsonString(event.payload, path: ["params", "diff"]) ?? event.delta ?? ""
        let summarized = summarizeDeltaBlock(diff)
        guard !summarized.isEmpty else { return nil }
        return "Diff updated:\n\(summarized)"
    }

    private func planStatusLabel(_ value: String) -> String {
        switch value {
        case "inprogress", "in_progress":
            return "in-progress"
        default:
            return value
        }
    }

    private func normalizeTurnStatus(_ raw: String?) -> String {
        (raw ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    private func isActiveThreadStatus(_ status: String) -> Bool {
        let normalized = normalizeTurnStatus(status)
        return [
            "queued",
            "claimed",
            "running",
            "streaming",
            "active",
            "inprogress",
            "in_progress",
            "deleting",
            "waiting_on_approval",
            "waiting_on_user_input",
        ].contains(normalized)
    }

    private func displayStatusLabel(_ status: String) -> String {
        switch normalizeTurnStatus(status) {
        case "queued": return "Queued on desktop connector."
        case "claimed": return "Picked up by desktop connector."
        case "running", "streaming", "active", "inprogress", "in_progress":
            return "Running on desktop connector."
        case "deleting":
            return "Deleting on desktop..."
        case "waiting_on_approval":
            return "Waiting for approval on desktop."
        case "waiting_on_user_input":
            return "Waiting for user input on desktop."
        case "interrupted", "cancelled", "canceled", "aborted", "stopped":
            return "Stopped on desktop."
        case "timeout", "timed_out":
            return "Timed out on desktop."
        case "notloaded", "not_loaded", "session_not_loaded", "session_not_found":
            return "Session not loaded on desktop."
        case "failed":
            return "Run failed on desktop."
        default:
            return "Run completed on desktop."
        }
    }

    private func summarizeInline(_ value: String) -> String {
        let compact = value
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if compact.count <= Self.progressPreviewLimit {
            return compact
        }
        return "\(compact.prefix(Self.progressPreviewLimit))..."
    }

    private func applyThreadStatusLocally(threadID: String, status: String, updatedAt: String) {
        guard let idx = threads.firstIndex(where: { $0.thread_id == threadID }) else { return }
        var row = threads[idx]
        row.status = status
        row.updated_at = updatedAt
        threads[idx] = row
        threads.sort(by: { $0.updated_at > $1.updated_at })
        if normalizeTurnStatus(status) != "waiting_on_user_input" {
            threadUserInputRequests.removeValue(forKey: threadID)
        }
    }

    private func inferredThreadStatus(for event: ChatEvent) -> String? {
        switch event.type {
        case "job.queued":
            return "queued"
        case "job.claimed":
            return "claimed"
        case "job.running", "job.started", "rpc.turn.started":
            return "running"
        case "job.waiting_on_user_input":
            return "waiting_on_user_input"
        case "job.completed":
            return "idle"
        case "job.interrupted", "rpc.turn.interrupted":
            return "interrupted"
        case "job.timeout", "rpc.turn.timeout", "rpc.turn.timed_out":
            return "timeout"
        case "job.failed", "rpc.turn.failed":
            if isSessionNotLoadedEvent(event) {
                return "notloaded"
            }
            return "failed"
        case "rpc.thread.status.changed":
            let raw = normalizedThreadStatusFromEvent(event)
            return raw.isEmpty ? nil : raw
        case "rpc.turn.completed":
            let status = normalizeTurnStatus(jsonString(event.payload, path: ["params", "turn", "status"]))
            if status.isEmpty { return "idle" }
            if status == "completed" { return "idle" }
            if ["interrupted", "cancelled", "canceled", "aborted", "stopped"].contains(status) { return "interrupted" }
            if status == "timeout" || status == "timed_out" { return "timeout" }
            if status == "failed" { return "failed" }
            return status
        default:
            return nil
        }
    }

    private func normalizedThreadStatusFromEvent(_ event: ChatEvent) -> String {
        let direct = normalizeTurnStatus(jsonString(event.payload, path: ["params", "status"]))
        if !direct.isEmpty { return direct }

        guard let statusValue = jsonValue(event.payload, path: ["params", "status"]),
              let object = statusValue.objectValue else {
            return ""
        }
        let type = normalizeTurnStatus(object["type"]?.stringValue)
        if type == "active" {
            let flags = object["activeFlags"]?.arrayValue ?? object["active_flags"]?.arrayValue ?? []
            let normalizedFlags = flags
                .compactMap(\.stringValue)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            if normalizedFlags.contains("waitingonapproval") || normalizedFlags.contains("waiting_on_approval") {
                return "waiting_on_approval"
            }
            if normalizedFlags.contains("waitingonuserinput") || normalizedFlags.contains("waiting_on_user_input") {
                return "waiting_on_user_input"
            }
            return "active"
        }
        return type
    }

    private func summarizeCommand(_ value: String) -> String {
        let compact = value.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        let unwrapped = unwrapShellCommand(compact)
        if unwrapped.count <= 88 { return unwrapped }
        return "\(unwrapped.prefix(88))..."
    }

    private func unwrapShellCommand(_ command: String) -> String {
        let prefixes = ["/bin/bash -lc ", "bash -lc ", "/bin/zsh -lc ", "zsh -lc "]
        for prefix in prefixes {
            guard command.hasPrefix(prefix) else { continue }
            let rest = command.dropFirst(prefix.count).trimmingCharacters(in: .whitespacesAndNewlines)
            if rest.count >= 2,
               ((rest.first == "\"" && rest.last == "\"") || (rest.first == "'" && rest.last == "'")) {
                return String(rest.dropFirst().dropLast())
            }
            return String(rest)
        }
        return command
    }

    private func transcriptSignature(for events: [ChatEvent]) -> String {
        guard let last = events.last else { return "0:0" }
        return "\(events.count):\(last.seq):\(last.type):\(last.ts)"
    }

    private func jsonValue(_ root: JSONValue?, path: [String]) -> JSONValue? {
        guard !path.isEmpty else { return root }
        var cursor = root
        for key in path {
            cursor = cursor?[key]
            if cursor == nil { return nil }
        }
        return cursor
    }

    private func jsonString(_ root: JSONValue?, path: [String]) -> String? {
        jsonValue(root, path: path)?.stringValue
    }

    private func jsonArray(_ root: JSONValue?, path: [String]) -> [JSONValue]? {
        jsonValue(root, path: path)?.arrayValue
    }

    private func startAuthReloginPolling(requestID: String) {
        authReloginPollTask?.cancel()
        authReloginPollTask = Task {
            while !Task.isCancelled {
                let terminal = await refreshDesktopReloginStatus(requestID: requestID, shouldSetError: false)
                if terminal { break }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func refreshDesktopReloginStatus(requestID: String, shouldSetError: Bool) async -> Bool {
        do {
            let response: AuthReloginRequestResponse = try await client.get(
                "codex-iphone-connector/auth/relogin/request/\(encodedPath(requestID))",
                baseURL: baseURL,
                token: token
            )
            authReloginRequest = response.request
            let terminal = Self.isAuthReloginTerminalStatus(response.request.status)
            if terminal {
                authReloginPollTask?.cancel()
                authReloginPollTask = nil
            }
            return terminal
        } catch {
            if shouldSetError {
                errorMessage = userFacingErrorMessage(error)
            }
            return false
        }
    }

    func events(for threadID: String) -> [ChatEvent] {
        threadEvents[threadID] ?? []
    }

    func jobs(for threadID: String) -> [ChatJob] {
        (threadJobs[threadID] ?? []).sorted(by: { $0.created_at > $1.created_at })
    }

    private func statusWorkspaceScope() -> String {
        let explicit = trimmed(workspace)
        if !explicit.isEmpty {
            return explicit
        }
        let fallback = trimmed(writeWorkspace)
        return fallback.isEmpty ? Self.defaultWriteWorkspace : fallback
    }

    private func refreshRelayRuntimeStatus(workspaceScope: String) async {
        let path: String
        if workspaceScope == "*" || workspaceScope.lowercased() == "all" {
            path = "codex-iphone-connector/status"
        } else {
            path = "codex-iphone-connector/status?workspace=\(encoded(workspaceScope))"
        }

        do {
            let response: RelayStatusResponse = try await client.get(path, baseURL: baseURL, token: token)
            relayRuntimeStatus = response.status
        } catch {
            relayRuntimeStatus = nil
        }
    }

    func refreshUsageSummary(force: Bool = false) async {
        guard isConfigured else { return }
        let now = Date()
        if !force, let last = lastUsageRefreshAt, now.timeIntervalSince(last) < 15 {
            return
        }
        isUsageLoading = true
        defer { isUsageLoading = false }
        do {
            let path: String
            if workspace == "*" {
                path = "codex-iphone-connector/usage/summary"
            } else {
                path = "codex-iphone-connector/usage/summary?workspace=\(encoded(workspace))"
            }
            let resp: UsageSummaryResponse = try await client.get(path, baseURL: baseURL, token: token)
            usageSummary = resp
            lastUsageRefreshAt = now
        } catch {
            // keep old value on error
        }
    }

    func refreshRemoteWorkspaces(force: Bool = false) async {
        guard isConfigured else { return }
        let now = Date()
        if !force, let last = lastWorkspacesRefreshAt, now.timeIntervalSince(last) < 20 {
            return
        }
        do {
            let resp: RelayWorkspacesResponse = try await client.get(
                "codex-iphone-connector/workspaces",
                baseURL: baseURL,
                token: token
            )
            remoteWorkspaces = resp.workspaces.map(\.name)
            lastWorkspacesRefreshAt = now
        } catch {
            // ignore
        }
    }

    func startDesktopRelogin() async {
        guard isConfigured else { return }
        struct Body: Encodable {
            let workspace: String
            let requested_by: String
        }
        isAuthReloginLoading = true
        defer { isAuthReloginLoading = false }
        do {
            let targetWorkspace = workspace == "*" ? "*" : workspace
            let response: AuthReloginRequestResponse = try await client.post(
                "codex-iphone-connector/auth/relogin/request",
                baseURL: baseURL,
                token: token,
                body: Body(workspace: targetWorkspace, requested_by: "ios-settings")
            )
            authReloginRequest = response.request
            startAuthReloginPolling(requestID: response.request.request_id)
            errorMessage = nil
        } catch {
            errorMessage = userFacingErrorMessage(error)
        }
    }

    func refreshDesktopReloginStatus() async {
        guard let requestID = authReloginRequest?.request_id else { return }
        await refreshDesktopReloginStatus(requestID: requestID, shouldSetError: true)
    }

    func clearDesktopReloginState() {
        authReloginPollTask?.cancel()
        authReloginPollTask = nil
        authReloginRequest = nil
    }

    func requestSessionSyncIfNeeded(threadID: String) async {
        guard isConfigured else { return }
        guard let thread = threads.first(where: { $0.thread_id == threadID }) else { return }
        _ = await requestSessionSync(thread: thread, requestedBy: "ios-open-thread")
    }

    func requestSessionSyncForAllThreads() async -> Int {
        guard isConfigured else { return 0 }
        var requestedCount = 0
        for thread in threads where isSessionThread(thread) {
            if await requestSessionSync(thread: thread, requestedBy: "ios-sync-all-sessions") {
                requestedCount += 1
            }
        }
        return requestedCount
    }

    func syncableSessionThreadsCount() -> Int {
        threads.reduce(into: 0) { count, thread in
            if isSessionThread(thread) {
                count += 1
            }
        }
    }

    private func requestSessionSync(thread: ChatThread, requestedBy: String) async -> Bool {
        guard isSessionThread(thread) else { return false }

        let now = Date()
        if let last = lastSessionSyncRequestAt[thread.thread_id], now.timeIntervalSince(last) < 12 {
            return false
        }
        lastSessionSyncRequestAt[thread.thread_id] = now

        struct SyncBody: Encodable {
            let workspace: String
            let thread_id: String
            let requested_by: String
        }
        struct BasicResponse: Decodable {
            let ok: Bool
        }
        do {
            let _: BasicResponse = try await client.post(
                "codex-iphone-connector/sessions/sync/request",
                baseURL: baseURL,
                token: token,
                body: SyncBody(
                    workspace: thread.workspace,
                    thread_id: thread.thread_id,
                    requested_by: requestedBy
                )
            )
            return true
        } catch {
            // ignore sync request failures to avoid blocking thread open
            return false
        }
    }

    private func isSessionThread(_ thread: ChatThread) -> Bool {
        let normalizedSource = thread.source.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let externalThreadID = (thread.external_thread_id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !externalThreadID.isEmpty
            || normalizedSource.contains("codex")
            || normalizedSource.contains("session")
            || normalizedSource.contains("connector")
            || thread.thread_id.lowercased().hasPrefix("codex_")
    }

    func threadWorkspaceGroups() -> [ChatThreadWorkspaceGroup] {
        let grouped = Dictionary(grouping: threads.filter(shouldDisplayThread(_:)), by: { $0.workspace })
        let groups = grouped.map { workspace, rows in
            ChatThreadWorkspaceGroup(
                workspace: workspace,
                threads: rows.sorted(by: { $0.updated_at > $1.updated_at })
            )
        }
        return groups.sorted { lhs, rhs in
            if lhs.updated_at == rhs.updated_at {
                return lhs.workspace.localizedCaseInsensitiveCompare(rhs.workspace) == .orderedAscending
            }
            return lhs.updated_at > rhs.updated_at
        }
    }

    func decide(_ approvalID: String, decision: String) async {
        guard isConfigured else { return }
        struct Body: Encodable {
            let decision: String
            let decision_by: String
        }
        struct Resp: Decodable {
            let ok: Bool
        }
        do {
            let _: Resp = try await client.post(
                "legacy-runner/approvals/\(approvalID)/decision",
                baseURL: baseURL,
                token: token,
                body: Body(decision: decision, decision_by: "ios-user")
            )
            await refreshNow()
        } catch {
            errorMessage = userFacingErrorMessage(error)
        }
    }

    private func upsertThread(_ thread: ChatThread) {
        guard shouldDisplayThread(thread) else {
            threads.removeAll(where: { $0.thread_id == thread.thread_id })
            if selectedThreadID == thread.thread_id {
                selectedThreadID = threads.first?.thread_id
            }
            return
        }
        if let idx = threads.firstIndex(where: { $0.thread_id == thread.thread_id }) {
            threads[idx] = thread
        } else {
            threads.append(thread)
        }
        threads.sort(by: { $0.updated_at > $1.updated_at })
    }

    private func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }

    private func encodedPath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private func chatEventsPath(threadID: String, afterSeq: Int, limit: Int, tail: Bool) -> String {
        let suffix = tail ? "&tail=1" : ""
        return "codex-iphone-connector/chat/threads/\(encodedPath(threadID))/events?after_seq=\(afterSeq)&limit=\(limit)\(suffix)"
    }

    private func normalizeWorkspaceFilter(_ value: String) -> String {
        let trimmedValue = trimmed(value)
        if trimmedValue.isEmpty { return "*" }
        if trimmedValue.lowercased() == "all" { return "*" }
        return trimmedValue
    }

    private func chatThreadsPath(limit: Int) -> String {
        let safeLimit = max(1, min(limit, 100))
        let scope = workspace == "*" ? "*" : workspace
        return "codex-iphone-connector/chat/threads?workspace=\(encoded(scope))&limit=\(safeLimit)"
    }

    private func fetchThreads(limitPerPage: Int, maxPages: Int) async throws -> [ChatThread] {
        var cursor: String?
        var allThreads: [ChatThread] = []
        let safePages = max(1, maxPages)
        for _ in 0..<safePages {
            var path = chatThreadsPath(limit: limitPerPage)
            if let cursor, !cursor.isEmpty {
                path += "&cursor=\(encoded(cursor))"
            }
            let page: ChatThreadsResponse = try await client.get(path, baseURL: baseURL, token: token)
            allThreads.append(contentsOf: page.threads)
            guard let next = page.next_cursor, !next.isEmpty else { break }
            cursor = next
        }

        var deduped: [String: ChatThread] = [:]
        for thread in allThreads {
            if let existing = deduped[thread.thread_id], existing.updated_at >= thread.updated_at {
                continue
            }
            deduped[thread.thread_id] = thread
        }
        let visible = deduped
            .values
            .filter(shouldDisplayThread(_:))
        return collapseDuplicateExternalThreads(Array(visible))
            .sorted(by: { $0.updated_at > $1.updated_at })
    }

    private func collapseDuplicateExternalThreads(_ rows: [ChatThread]) -> [ChatThread] {
        var byExternalThreadID: [String: ChatThread] = [:]
        var passthrough: [ChatThread] = []
        passthrough.reserveCapacity(rows.count)

        for row in rows {
            guard let externalID = normalizedExternalThreadID(row) else {
                passthrough.append(row)
                continue
            }
            if let existing = byExternalThreadID[externalID] {
                if shouldPreferThreadCandidate(row, over: existing, externalThreadID: externalID) {
                    byExternalThreadID[externalID] = row
                }
            } else {
                byExternalThreadID[externalID] = row
            }
        }

        return passthrough + Array(byExternalThreadID.values)
    }

    private func normalizedExternalThreadID(_ thread: ChatThread) -> String? {
        let value = trimmed(thread.external_thread_id)
        return value.isEmpty ? nil : value
    }

    private func shouldPreferThreadCandidate(
        _ candidate: ChatThread,
        over existing: ChatThread,
        externalThreadID: String
    ) -> Bool {
        let candidateActive = isPrimaryActiveThreadStatus(candidate.status)
        let existingActive = isPrimaryActiveThreadStatus(existing.status)
        if candidateActive != existingActive {
            return candidateActive
        }

        let candidateDate = parseISODate(candidate.updated_at) ?? .distantPast
        let existingDate = parseISODate(existing.updated_at) ?? .distantPast
        if candidateDate != existingDate {
            return candidateDate > existingDate
        }

        let candidateCanonical = candidate.thread_id == "codex_\(externalThreadID)"
        let existingCanonical = existing.thread_id == "codex_\(externalThreadID)"
        if candidateCanonical != existingCanonical {
            return candidateCanonical
        }

        let candidateSourceRank = threadSourceRank(candidate.source)
        let existingSourceRank = threadSourceRank(existing.source)
        if candidateSourceRank != existingSourceRank {
            return candidateSourceRank > existingSourceRank
        }

        return candidate.thread_id > existing.thread_id
    }

    private func isPrimaryActiveThreadStatus(_ status: String) -> Bool {
        let normalized = normalizeTurnStatus(status)
        return normalized == "queued"
            || normalized == "claimed"
            || normalized == "running"
            || normalized == "streaming"
            || normalized == "waiting_on_approval"
            || normalized == "waiting_on_user_input"
    }

    private func threadSourceRank(_ source: String) -> Int {
        switch trimmed(source).lowercased() {
        case "codex":
            return 4
        case "connector":
            return 3
        case "ios":
            return 2
        case "control-plane":
            return 1
        default:
            return 0
        }
    }

    private func shouldDisplayThread(_ thread: ChatThread) -> Bool {
        let status = normalizeTurnStatus(thread.status)
        return !["archived", "hidden", "deleted", "deleting"].contains(status)
    }

    private func defaultPreference() -> ChatThreadPreferences {
        let model = trimmed(chatModel)
        return ChatThreadPreferences(
            mode: normalizeMode(chatMode),
            model: model.isEmpty ? "gpt-5.3-codex" : model,
            effort: normalizeEffort(chatReasoningEffort)
        )
    }

    private func preference(for threadID: String?) -> ChatThreadPreferences {
        guard let threadID, !threadID.isEmpty else { return defaultPreference() }
        if let existing = threadPreferences[threadID] {
            return ChatThreadPreferences(
                mode: normalizeMode(existing.mode),
                model: trimmed(existing.model).isEmpty ? defaultPreference().model : trimmed(existing.model),
                effort: normalizeEffort(existing.effort)
            )
        }
        return defaultPreference()
    }

    private func updateThreadPreference(
        threadID: String,
        mutate: (ChatThreadPreferences) -> ChatThreadPreferences
    ) {
        let current = preference(for: threadID)
        let next = mutate(current)
        threadPreferences[threadID] = ChatThreadPreferences(
            mode: normalizeMode(next.mode),
            model: trimmed(next.model).isEmpty ? defaultPreference().model : trimmed(next.model),
            effort: normalizeEffort(next.effort)
        )
        persistThreadPreferences()
    }

    private func persistThreadPreferences() {
        if let data = try? JSONEncoder().encode(threadPreferences) {
            UserDefaults.standard.set(data, forKey: "chat.threadPreferences")
        }
    }

    private func persistThreadDrafts() {
        let sanitized = Self.sanitizedThreadDrafts(threadDrafts)
        if sanitized.isEmpty {
            UserDefaults.standard.removeObject(forKey: "chat.threadDrafts")
            return
        }
        if let data = try? JSONEncoder().encode(sanitized) {
            UserDefaults.standard.set(data, forKey: "chat.threadDrafts")
        }
    }

    private func workspaceForWrite(threadID: String?) -> String {
        if let threadID, let thread = threads.first(where: { $0.thread_id == threadID }) {
            return thread.workspace
        }
        if let selectedThreadID, let selected = threads.first(where: { $0.thread_id == selectedThreadID }) {
            return selected.workspace
        }
        if workspace != "*" {
            return workspace
        }
        return writeWorkspace
    }

    private struct TranscriptCacheEntry {
        let signature: String
        let messages: [ChatTranscriptMessage]
    }

    private func normalizeMode(_ value: String) -> String {
        let mode = trimmed(value).lowercased()
        if mode == "plan" { return "plan" }
        return "default"
    }

    private func normalizeEffort(_ value: String) -> String {
        let effort = trimmed(value).lowercased()
        let allowed = ["none", "minimal", "low", "medium", "high", "xhigh"]
        return allowed.contains(effort) ? effort : "xhigh"
    }

    private func buildChatPolicy(for threadID: String?) -> ChatPolicy {
        let pref = preference(for: threadID)
        let model = trimmed(pref.model)
        let effort = normalizeEffort(pref.effort)
        let mode = normalizeMode(pref.mode)
        let collaborationMode = model.isEmpty
            ? nil
            : ChatCollaborationMode(
                mode: mode,
                settings: ChatCollaborationModeSettings(
                    model: model,
                    reasoningEffort: effort,
                    developerInstructions: nil
                )
            )
        return ChatPolicy(
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            cwd: nil,
            model: model.isEmpty ? nil : model,
            personality: "pragmatic",
            effort: effort,
            summary: "auto",
            mode: mode,
            collaborationMode: collaborationMode
        )
    }

    private func normalizeInputItems(_ items: [ChatInputItem]) -> [ChatInputItem] {
        var out: [ChatInputItem] = []
        for item in items.prefix(8) {
            let type = trimmed(item.type)
            if type == "text" {
                let text = trimmed(item.text)
                guard !text.isEmpty else { continue }
                out.append(ChatInputItem(type: "text", text: text, url: nil, path: nil, name: nil))
                continue
            }
            if type == "image" {
                let url = trimmed(item.url)
                guard !url.isEmpty else { continue }
                out.append(ChatInputItem(type: "image", text: nil, url: url, path: nil, name: nil))
                continue
            }
            if type == "localImage" {
                let path = trimmed(item.path)
                guard !path.isEmpty else { continue }
                out.append(ChatInputItem(type: "localImage", text: nil, url: nil, path: path, name: nil))
                continue
            }
            if type == "skill" || type == "mention" {
                let name = trimmed(item.name)
                let path = trimmed(item.path)
                guard !name.isEmpty, !path.isEmpty else { continue }
                out.append(ChatInputItem(type: type, text: nil, url: nil, path: path, name: name))
            }
        }
        return out
    }

    private func applyConnection(baseURL: String, token: String, workspace: String, writeWorkspace: String?) {
        self.baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        self.workspace = normalizeWorkspaceFilter(workspace)

        let writeWorkspaceInput = trimmed(writeWorkspace)
        if !writeWorkspaceInput.isEmpty {
            self.writeWorkspace = writeWorkspaceInput
        } else if self.workspace != "*" {
            self.writeWorkspace = self.workspace
        } else if self.writeWorkspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.writeWorkspace = Self.defaultWriteWorkspace
        }

        UserDefaults.standard.set(self.baseURL, forKey: "relay.baseURL")
        if self.token.isEmpty {
            secrets.deleteToken(for: currentTokenRef())
        } else {
            _ = secrets.saveToken(self.token, for: currentTokenRef())
        }
        UserDefaults.standard.removeObject(forKey: "relay.token")
        UserDefaults.standard.set(self.workspace, forKey: "relay.workspace")
        UserDefaults.standard.set(self.writeWorkspace, forKey: "relay.writeWorkspace")

        threadJobs.removeAll()
        threadEvents.removeAll()
        threadLastSeq.removeAll()
        threads = []
        remoteWorkspaces = []
        selectedThreadID = nil
        usageSummary = nil
        authReloginPollTask?.cancel()
        authReloginPollTask = nil
        authReloginRequest = nil

        startPolling()
        Task { await refreshNow() }
    }

    private func syncActiveProfileWithCurrentConnection() {
        guard let activeProfileID,
              let idx = accountProfiles.firstIndex(where: { $0.id == activeProfileID }) else { return }
        var profile = accountProfiles[idx]
        if trimmed(profile.token_ref).isEmpty {
            profile.token_ref = "profile.\(profile.id)"
        }
        profile.base_url = baseURL
        profile.workspace = workspace
        profile.write_workspace = writeWorkspace
        profile.updated_at = nowIso()
        profile.legacy_token = nil
        if !token.isEmpty {
            _ = secrets.saveToken(token, for: profile.token_ref)
        } else {
            secrets.deleteToken(for: profile.token_ref)
        }
        accountProfiles[idx] = profile
        accountProfiles.sort(by: { $0.updated_at > $1.updated_at })
        persistAccountProfiles()
    }

    private func persistAccountProfiles() {
        if let data = try? JSONEncoder().encode(accountProfiles) {
            UserDefaults.standard.set(data, forKey: "relay.accountProfiles")
        }
        if let activeProfileID {
            UserDefaults.standard.set(activeProfileID, forKey: "relay.activeProfileID")
        } else {
            UserDefaults.standard.removeObject(forKey: "relay.activeProfileID")
        }
    }

    private func currentTokenRef() -> String {
        guard let activeProfileID,
              let profile = accountProfiles.first(where: { $0.id == activeProfileID }),
              !trimmed(profile.token_ref).isEmpty else {
            return Self.defaultTokenRef
        }
        return profile.token_ref
    }

    private func migrateTokenStorageIfNeeded() {
        var changedProfiles = false
        for index in accountProfiles.indices {
            var profile = accountProfiles[index]
            if trimmed(profile.token_ref).isEmpty {
                profile.token_ref = "profile.\(profile.id)"
                changedProfiles = true
            }
            if let legacy = profile.legacy_token, !trimmed(legacy).isEmpty {
                _ = secrets.saveToken(trimmed(legacy), for: profile.token_ref)
                profile.legacy_token = nil
                changedProfiles = true
            }
            accountProfiles[index] = profile
        }

        let legacyDefaultToken = trimmed(UserDefaults.standard.string(forKey: "relay.token"))
        if !legacyDefaultToken.isEmpty {
            _ = secrets.saveToken(legacyDefaultToken, for: Self.defaultTokenRef)
            UserDefaults.standard.removeObject(forKey: "relay.token")
            if token.isEmpty {
                token = legacyDefaultToken
            }
        }

        if changedProfiles {
            persistAccountProfiles()
        }
    }

    private var isUITestSeedModeEnabled: Bool {
        let raw = trimmed(ProcessInfo.processInfo.environment["CODEX_UI_TEST_SEED_THREADS"]).lowercased()
        return raw == "1" || raw == "true" || raw == "yes"
    }

    private func seedUITestThreadsIfNeeded() {
        let targetWorkspace: String
        if workspace == "*" {
            let fallback = trimmed(writeWorkspace)
            targetWorkspace = fallback.isEmpty ? Self.defaultWriteWorkspace : fallback
        } else {
            targetWorkspace = workspace
        }
        let ts = nowIso()
        threads = [
            ChatThread(
                thread_id: "ui-test-thread",
                workspace: targetWorkspace,
                title: "UI Test Thread",
                external_thread_id: nil,
                source: "ios",
                status: "completed",
                created_at: ts,
                updated_at: ts
            )
        ]
        remoteWorkspaces = [targetWorkspace]
        selectedThreadID = "ui-test-thread"
        errorMessage = nil
        isLoading = false
    }

    private func userFacingErrorMessage(_ error: Error) -> String {
        let raw = String(describing: error)
        let normalized = raw.lowercased()
        if normalized.contains("relayerror.invalidurl")
            || normalized.contains("invalid url")
            || normalized.contains("unsupported url") {
            return "Invalid Relay URL. Please enter a full URL such as https://relay.example.com."
        }
        if normalized.contains("http 401")
            || normalized.contains("http 403")
            || normalized.contains("api error: unauthorized")
            || normalized.contains("api error: forbidden") {
            return "Authentication failed. Please verify your Bearer token."
        }
        if normalized.contains("http 404") {
            return "Relay endpoint not found. Check the base URL and server deployment path."
        }
        if normalized.contains("http 5") {
            return "Relay server is unavailable (5xx). Please retry later or check server logs."
        }
        if normalized.contains("timed out")
            || normalized.contains("could not connect")
            || normalized.contains("network")
            || normalized.contains("offline") {
            return "Network error. Confirm internet access and Relay server reachability."
        }
        return raw
    }

    private func nowIso() -> String {
        Self.iso8601Fractional.string(from: Date())
    }

    private func parseISODate(_ value: String?) -> Date? {
        let raw = trimmed(value)
        guard !raw.isEmpty else { return nil }
        return Self.iso8601Fractional.date(from: raw) ?? Self.iso8601.date(from: raw)
    }

    private func trimmed(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isAuthReloginTerminalStatus(_ status: String) -> Bool {
        let normalized = status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "completed" || normalized == "failed"
    }

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
