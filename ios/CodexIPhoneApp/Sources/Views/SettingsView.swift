import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: RelayStore
    @Environment(\.openURL) private var openURL
    @State private var workspaceText: String = UserDefaults.standard.string(forKey: "relay.workspace") ?? ""
    @State private var writeWorkspaceText: String = UserDefaults.standard.string(forKey: "relay.writeWorkspace") ?? ""
    @State private var modelText: String = UserDefaults.standard.string(forKey: "chat.model") ?? ""
    @State private var selectedThreadModelText: String = ""
    @State private var profileNameDraft: String = ""
    @State private var isCreateProfileAlertPresented = false
    @State private var isRenameProfileAlertPresented = false

    private var selectedThread: ChatThread? {
        guard let id = store.selectedThreadID else { return nil }
        return store.threads.first(where: { $0.thread_id == id })
    }

    private var activeProfile: RelayAccountProfile? {
        store.activeAccountProfile
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Account Profiles") {
                    Picker("Active Profile", selection: Binding(
                        get: { store.activeProfileID ?? Self.unsavedProfileTag },
                        set: { tag in
                            if tag == Self.unsavedProfileTag {
                                store.clearActiveAccountProfile()
                            } else {
                                store.switchAccountProfile(id: tag)
                            }
                            refreshLocalConnectionFields()
                        }
                    )) {
                        Text("Current (Unsaved)").tag(Self.unsavedProfileTag)
                        ForEach(store.accountProfiles) { profile in
                            Text("\(profile.name) • \(profile.workspace)").tag(profile.id)
                        }
                    }

                    Button("Save Current As Profile") {
                        profileNameDraft = store.defaultProfileName()
                        isCreateProfileAlertPresented = true
                    }

                    if activeProfile != nil {
                        Button("Update Active Profile") {
                            store.updateActiveAccountProfile()
                        }
                        Button("Rename Active Profile") {
                            profileNameDraft = activeProfile?.name ?? ""
                            isRenameProfileAlertPresented = true
                        }
                        Button("Delete Active Profile", role: .destructive) {
                            if let id = activeProfile?.id {
                                store.deleteAccountProfile(id: id)
                            }
                        }
                    }
                }

                Section("Connection") {
                    LabeledContent("Base URL", value: store.baseURL)
                    LabeledContent("Token", value: store.token.isEmpty ? "-" : "••••••••")
                    TextField("Workspace Filter (* = all)", text: $workspaceText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Write Workspace", text: $writeWorkspaceText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Apply Workspace") {
                        store.setWorkspace(workspaceText)
                        store.setWriteWorkspace(writeWorkspaceText)
                    }
                }

                Section("Desktop Re-Login") {
                    if let relogin = store.authReloginRequest {
                        LabeledContent("Status", value: relogin.status.uppercased())
                        if let code = relogin.user_code, !code.isEmpty {
                            LabeledContent("Code", value: code)
                        }
                        if let message = relogin.message, !message.isEmpty {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let error = relogin.error, !error.isEmpty {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                        if let authURLString = relogin.auth_url,
                           let authURL = URL(string: authURLString) {
                            Button("Open Login URL") {
                                openURL(authURL)
                            }
                        }
                        if let expires = relogin.expires_at, !expires.isEmpty {
                            LabeledContent("Expires", value: expires)
                        }
                    } else {
                        Text("Start desktop Codex device-auth from phone, then finish sign-in in browser.")
                            .foregroundStyle(.secondary)
                        Text("Use only when desktop auth is actually broken. Normal usage now keeps existing MCP credentials.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Button {
                        Task { await store.startDesktopRelogin() }
                    } label: {
                        if store.isAuthReloginLoading {
                            ProgressView("Starting...")
                        } else {
                            Text("Start Desktop Re-Login")
                        }
                    }
                    .disabled(store.isAuthReloginLoading)

                    if store.authReloginRequest != nil {
                        Button("Refresh Re-Login Status") {
                            Task { await store.refreshDesktopReloginStatus() }
                        }
                        Button("Clear Re-Login State", role: .destructive) {
                            store.clearDesktopReloginState()
                        }
                    }
                }

                Section("New Session Defaults") {
                    Text("These defaults apply only to newly created sessions.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Picker("Mode", selection: Binding(
                        get: { store.chatMode },
                        set: { store.setChatMode($0) }
                    )) {
                        Text("Default").tag("default")
                        Text("Plan").tag("plan")
                    }
                    .pickerStyle(.segmented)

                    TextField("Default Model (New Sessions)", text: $modelText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Picker("Reasoning", selection: Binding(
                        get: { store.chatReasoningEffort },
                        set: { store.setChatReasoningEffort($0) }
                    )) {
                        Text("xhigh").tag("xhigh")
                        Text("high").tag("high")
                        Text("medium").tag("medium")
                        Text("low").tag("low")
                        Text("minimal").tag("minimal")
                        Text("none").tag("none")
                    }

                    Button("Save New Session Defaults") {
                        store.setChatModel(modelText)
                    }
                }

                Section("Chat Display") {
                    Toggle("Show Internal Progress Messages", isOn: Binding(
                        get: { store.showThinkingMessages },
                        set: { store.setShowThinkingMessages($0) }
                    ))
                    Text("Includes thinking + tool/lifecycle/system logs. Off matches desktop's cleaner history view.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Toggle(t("settings.plan.default_collapsed", "Plan default collapse internal progress"), isOn: Binding(
                        get: { store.planProgressDefaultCollapsed },
                        set: { store.setPlanProgressDefaultCollapsed($0) }
                    ))
                    Text(t(
                        "settings.plan.default_collapsed.description",
                        "Plan sessions show only key states by default; expand in-session to view full internal progress."
                    ))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let selectedThread {
                    Section("Selected Session Override") {
                        LabeledContent("Thread", value: selectedThread.title.isEmpty ? selectedThread.thread_id : selectedThread.title)
                        LabeledContent("Workspace", value: selectedThread.workspace)
                        Text("This section changes only the current session. Use this when one session needs a different model.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Picker("Mode", selection: Binding(
                            get: { store.chatMode(for: selectedThread.thread_id) },
                            set: { store.setThreadChatMode($0, threadID: selectedThread.thread_id) }
                        )) {
                            Text("Default").tag("default")
                            Text("Plan").tag("plan")
                        }
                        .pickerStyle(.segmented)

                        TextField("Session Model Override", text: $selectedThreadModelText)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                        Button("Save Session Override") {
                            store.setThreadChatModel(selectedThreadModelText, threadID: selectedThread.thread_id)
                        }
                        Button("Reset Session Model to Default") {
                            selectedThreadModelText = store.chatModel
                            store.setThreadChatModel("", threadID: selectedThread.thread_id)
                        }

                        Picker("Reasoning", selection: Binding(
                            get: { store.chatReasoningEffort(for: selectedThread.thread_id) },
                            set: { store.setThreadChatReasoningEffort($0, threadID: selectedThread.thread_id) }
                        )) {
                            Text("xhigh").tag("xhigh")
                            Text("high").tag("high")
                            Text("medium").tag("medium")
                            Text("low").tag("low")
                            Text("minimal").tag("minimal")
                            Text("none").tag("none")
                        }
                    }
                } else {
                    Section("Selected Session Override") {
                        Text("Open a session first, then this section will control that session's mode/model.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Codex Usage (Server Metadata)") {
                    Text("Usage is read from Codex event metadata. Total Tokens prefers token_count.rate_limits.used_tokens.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if store.isUsageLoading {
                        ProgressView("Loading usage...")
                    }
                    if let usage = store.usageSummary {
                        LabeledContent("Workspace", value: usage.workspace)
                        LabeledContent("Threads", value: formatInt(usage.threads_count))
                        LabeledContent("Queued Jobs", value: formatInt(usage.jobs.queued))
                        LabeledContent("Running Jobs", value: formatInt(usage.jobs.running))
                        LabeledContent("Completed Jobs", value: formatInt(usage.jobs.completed))
                        LabeledContent("Failed Jobs", value: formatInt(usage.jobs.failed))
                        usageWindowRows(title: "5-Hour", window: usage.rate_limits?.five_hour)
                        usageWindowRows(title: "Weekly", window: usage.rate_limits?.weekly)
                        if let source = usage.rate_limits_source, !source.isEmpty {
                            LabeledContent("Rate Limits Source", value: source)
                        }
                        if let totalSource = usage.total_tokens_source, !totalSource.isEmpty {
                            LabeledContent("Total Tokens Source", value: totalSource)
                        }
                        if let windows = usage.rate_limits_windows_found {
                            LabeledContent("Rate Limit Windows", value: formatInt(windows))
                        }
                        if usage.rate_limits == nil {
                            Text("No token_count rate limits yet. Send a turn and refresh usage.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        LabeledContent(totalTokensLabel(usage), value: formatInt(usage.usage.total_tokens))
                        LabeledContent("Input Tokens", value: formatInt(usage.usage.input_tokens))
                        LabeledContent("Cached Input", value: formatInt(usage.usage.cached_input_tokens))
                        LabeledContent("Output Tokens", value: formatInt(usage.usage.output_tokens))
                        if let updated = usageUpdatedText(usage.usage_updated_at) {
                            LabeledContent("Updated", value: updated)
                        }
                    } else {
                        Text("No usage data yet. Send a turn, then tap Refresh Usage.")
                            .foregroundStyle(.secondary)
                    }
                    Button("Refresh Usage") {
                        Task { await store.refreshUsageSummary(force: true) }
                    }
                }

                Section("Version") {
                    LabeledContent("App", value: appVersionText())
                }

                Section("Polling") {
                    Picker("Interval", selection: Binding(
                        get: { store.pollSeconds },
                        set: { store.setPollSeconds($0) }
                    )) {
                        Text("1s").tag(1)
                        Text("3s").tag(3)
                        Text("10s").tag(10)
                    }
                    .pickerStyle(.segmented)
                }

                Section {
                    Button("Refresh Now") {
                        Task { await store.refreshNow() }
                    }
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                refreshLocalConnectionFields()
                modelText = store.chatModel
                if let selectedThread {
                    selectedThreadModelText = store.chatModel(for: selectedThread.thread_id)
                }
            }
            .onChange(of: store.selectedThreadID) { _, newID in
                guard let newID else {
                    selectedThreadModelText = ""
                    return
                }
                selectedThreadModelText = store.chatModel(for: newID)
            }
            .alert("Save Profile", isPresented: $isCreateProfileAlertPresented) {
                TextField("Profile Name", text: $profileNameDraft)
                Button("Save") {
                    store.createAccountProfile(name: profileNameDraft)
                    profileNameDraft = ""
                }
                Button("Cancel", role: .cancel) {
                    profileNameDraft = ""
                }
            } message: {
                Text("Store current Relay URL, token, and workspace as a switchable profile.")
            }
            .alert("Rename Profile", isPresented: $isRenameProfileAlertPresented) {
                TextField("Profile Name", text: $profileNameDraft)
                Button("Save") {
                    store.updateActiveAccountProfile(name: profileNameDraft)
                    profileNameDraft = ""
                }
                Button("Cancel", role: .cancel) {
                    profileNameDraft = ""
                }
            } message: {
                Text("Rename the active profile.")
            }
        }
    }

    private func refreshLocalConnectionFields() {
        workspaceText = store.workspace
        writeWorkspaceText = store.writeWorkspace
    }

    private func formatInt(_ value: Int) -> String {
        Self.numberFormatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    private func usedPercentValue(_ window: UsageRateLimitWindow?) -> Double? {
        guard let window else { return nil }
        if let used = window.used_percent {
            return clampedPercent(used)
        }
        if let remaining = window.remaining_percent {
            return clampedPercent(100 - remaining)
        }
        if let usedTokens = window.used_tokens, let limit = window.limit_tokens, limit > 0 {
            return clampedPercent((Double(usedTokens) / Double(limit)) * 100)
        }
        return nil
    }

    private func remainingPercentValue(_ window: UsageRateLimitWindow?) -> Double? {
        guard let window else { return nil }
        if let remaining = window.remaining_percent {
            return clampedPercent(remaining)
        }
        if let used = usedPercentValue(window) {
            return clampedPercent(100 - used)
        }
        return nil
    }

    private func clampedPercent(_ value: Double) -> Double {
        max(0, min(100, value))
    }

    private func formatPercent(_ value: Double) -> String {
        Self.percentFormatter.string(from: NSNumber(value: value / 100))
            ?? String(format: "%.1f%%", value)
    }

    @ViewBuilder
    private func usagePercentProgressRow(title: String, usedPercent: Double) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer()
                Text(formatPercent(usedPercent))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: usedPercent, total: 100)
                .tint(usageTint(for: usedPercent))
        }
    }

    private func usageTint(for usedPercent: Double) -> Color {
        if usedPercent >= 90 {
            return .red
        }
        if usedPercent >= 75 {
            return .orange
        }
        return .accentColor
    }

    @ViewBuilder
    private func usageWindowRows(title: String, window: UsageRateLimitWindow?) -> some View {
        if let usedPercent = usedPercentValue(window) {
            usagePercentProgressRow(title: "\(title) Usage", usedPercent: usedPercent)
        }
        LabeledContent("\(title) Remaining %", value: usageFieldText(remainingPercentText(window)))
        LabeledContent("\(title) Used %", value: usageFieldText(usedPercentText(window)))
        LabeledContent("\(title) Tokens", value: usageFieldText(tokenWindowText(window)))
        LabeledContent("\(title) Recovery", value: usageFieldText(resetTimeText(window)))
    }

    private func usageFieldText(_ value: String?) -> String {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Waiting for token_count metadata" : trimmed
    }

    private func remainingPercentText(_ window: UsageRateLimitWindow?) -> String? {
        guard let remaining = remainingPercentValue(window) else { return nil }
        return formatPercent(remaining)
    }

    private func usedPercentText(_ window: UsageRateLimitWindow?) -> String? {
        guard let used = usedPercentValue(window) else { return nil }
        return formatPercent(used)
    }

    private func tokenWindowText(_ window: UsageRateLimitWindow?) -> String? {
        guard let window else { return nil }
        guard let used = window.used_tokens, let limit = window.limit_tokens, limit > 0 else { return nil }
        return "\(formatInt(used)) / \(formatInt(limit))"
    }

    private func resetTimeText(_ window: UsageRateLimitWindow?) -> String? {
        let raw = (window?.reset_at ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let date = parsedISODate(raw) {
            let relative = Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
            return "\(relative) · \(Self.dateTimeFormatter.string(from: date))"
        }
        if !raw.isEmpty {
            return raw
        }
        guard let window else { return nil }
        guard window.window_minutes > 0 else { return nil }
        let updatedRaw = (window.updated_at ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let updatedAt = parsedISODate(updatedRaw) else { return nil }
        let estimatedReset = updatedAt.addingTimeInterval(Double(window.window_minutes) * 60)
        let relative = Self.relativeFormatter.localizedString(for: estimatedReset, relativeTo: Date())
        return "Est. \(relative) · \(Self.dateTimeFormatter.string(from: estimatedReset))"
    }

    private func parsedISODate(_ value: String) -> Date? {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        if let fractional = Self.iso8601Fractional.date(from: raw) {
            return fractional
        }
        return Self.iso8601.date(from: raw)
    }

    private func usageUpdatedText(_ raw: String?) -> String? {
        let ts = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ts.isEmpty else { return nil }
        guard let date = parsedISODate(ts) else { return ts }
        let relative = Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
        return "\(relative) · \(Self.dateTimeFormatter.string(from: date))"
    }

    private func totalTokensLabel(_ usage: UsageSummaryResponse) -> String {
        switch (usage.total_tokens_source ?? "").lowercased() {
        case "rate_limits":
            return "Total Tokens (Rate Limits)"
        case "token_usage":
            return "Total Tokens (Token Usage)"
        default:
            return "Total Tokens"
        }
    }

    private func appVersionText() -> String {
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "-"
        let build = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "-"
        return "\(version) (\(build))"
    }

    private func t(_ key: String, _ fallback: String) -> String {
        NSLocalizedString(key, tableName: nil, bundle: .main, value: fallback, comment: "")
    }

    private static let numberFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter
    }()

    private static let percentFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .percent
        formatter.maximumFractionDigits = 1
        formatter.minimumFractionDigits = 0
        return formatter
    }()

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

    private static let dateTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter
    }()

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    private static let unsavedProfileTag = "__unsaved__"
}
