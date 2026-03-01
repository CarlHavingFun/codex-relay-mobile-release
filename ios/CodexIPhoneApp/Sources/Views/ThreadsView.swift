import SwiftUI
import UIKit

struct ThreadsView: View {
    @EnvironmentObject private var store: RelayStore
    @State private var searchText: String = ""
    @State private var navigationPath: [String] = []
    @State private var collapsedWorkspaces: Set<String> = Set(UserDefaults.standard.stringArray(forKey: Self.collapsedWorkspacesKey) ?? [])
    @State private var lastOpenedWorkspace: String = UserDefaults.standard.string(forKey: Self.lastOpenedWorkspaceKey) ?? ""
    @State private var expandedWorkspaceThreads: Set<String> = []
    @State private var isSyncingAllSessions: Bool = false
    @State private var copiedThreadID: String?

    private var filteredGroups: [ChatThreadWorkspaceGroup] {
        let groups = store.threadWorkspaceGroups()
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return groups }
        return groups.compactMap { group in
            let hits = group.threads.filter { thread in
                thread.thread_id.lowercased().contains(query) ||
                thread.title.lowercased().contains(query) ||
                group.workspace.lowercased().contains(query)
            }
            guard !hits.isEmpty else { return nil }
            return ChatThreadWorkspaceGroup(workspace: group.workspace, threads: hits)
        }
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            List {
                if filteredGroups.isEmpty {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(isSearchActive ? "No matching threads" : "No threads yet")
                                .font(.headline)
                            Text(isSearchActive ? "Try another keyword." : "Create your first thread to start chatting.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Button {
                                createThread(in: activeWorkspaceForNewThread())
                            } label: {
                                Label("New Thread", systemImage: "plus.circle.fill")
                            }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("threads-add-empty-state")
                        }
                        .padding(.vertical, 8)
                    }
                }
                ForEach(filteredGroups) { group in
                    Section {
                        if isSearchActive || !isCollapsed(group.workspace) {
                            ForEach(visibleThreads(for: group)) { thread in
                                threadRow(thread, includeWorkspace: false)
                            }
                            if shouldShowMore(for: group) {
                                Button {
                                    expandedWorkspaceThreads.insert(group.workspace)
                                } label: {
                                    Text("Show \(group.threads.count - Self.previewThreadLimit) more")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                            } else if shouldShowLess(for: group) {
                                Button {
                                    expandedWorkspaceThreads.remove(group.workspace)
                                } label: {
                                    Text("Show less")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    } header: {
                        HStack {
                            Button {
                                toggleWorkspaceCollapse(group.workspace)
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: isCollapsed(group.workspace) ? "chevron.right" : "chevron.down")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    Image(systemName: "folder.fill")
                                        .foregroundStyle(.secondary)
                                    Text(group.workspace)
                                    Text("(\(group.threads.count))")
                                        .foregroundStyle(.secondary)
                                    Spacer(minLength: 0)
                                }
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("workspace-header-\(group.workspace)")
                            Button {
                                createThread(in: group.workspace)
                            } label: {
                                Image(systemName: "plus.circle")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("workspace-add-\(group.workspace)")
                        }
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Threads")
            .searchable(text: $searchText, prompt: "Search thread")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button("Expand All") {
                            expandAllWorkspaces()
                        }
                        Button("Collapse All") {
                            collapseAllWorkspaces()
                        }
                    } label: {
                        Label("Folders", systemImage: "folder")
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        syncAllSessions()
                    } label: {
                        if isSyncingAllSessions {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                    }
                    .accessibilityIdentifier("threads-sync-all-sessions")
                    .disabled(!canSyncAllSessions || isSyncingAllSessions)

                    Button {
                        createThread(in: activeWorkspaceForNewThread())
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityIdentifier("threads-add-global")
                }
            }
            .refreshable {
                await store.refreshNow()
            }
            .task {
                await store.refreshNow()
                applyWorkspaceCollapseDefaults(force: true)
            }
            .onAppear {
                applyWorkspaceCollapseDefaults(force: true)
            }
            .onChange(of: store.threads) { _, _ in
                applyWorkspaceCollapseDefaults(force: false)
            }
            .navigationDestination(for: String.self) { threadID in
                ChatView(threadID: threadID)
                    .environmentObject(store)
            }
        }
    }

    @ViewBuilder
    private func threadRow(_ thread: ChatThread, includeWorkspace: Bool) -> some View {
        Button {
            dismissKeyboard()
            rememberLastOpenedWorkspace(thread.workspace, persistCollapsedState: false)
            navigationPath.append(thread.thread_id)
        } label: {
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(thread.title.isEmpty ? thread.thread_id : thread.title)
                        .lineLimit(2)
                        .font(.body)
                    if store.isThreadInFlight(threadID: thread.thread_id),
                       let progress = store.threadProgressSummary(threadID: thread.thread_id),
                       !progress.isEmpty {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(statusColor(thread.status))
                                .frame(width: 6, height: 6)
                            Text(progress)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    HStack(spacing: 8) {
                        Text(shortThreadID(thread.thread_id))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                        if includeWorkspace {
                            Text(thread.workspace)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        statusPill(thread.status)
                        if let source = sourceTag(for: thread.source) {
                            Text(source)
                                .font(.caption2)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color(.secondarySystemFill), in: Capsule())
                                .foregroundStyle(.secondary)
                        }
                        Text(interactionTimeLabel(from: thread.updated_at))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.forward")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 2)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("thread-row-\(thread.thread_id)")
        .contextMenu {
            Button(copiedThreadID == thread.thread_id ? "Copied Thread ID" : "Copy Thread ID") {
                copyThreadID(thread.thread_id)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                copyThreadID(thread.thread_id)
            } label: {
                Label("Copy ID", systemImage: copiedThreadID == thread.thread_id ? "checkmark" : "doc.on.doc")
            }
            .tint(.gray)

            Button {
                Task {
                    await store.requestSessionSyncIfNeeded(threadID: thread.thread_id)
                    await store.refreshThread(threadID: thread.thread_id)
                }
            } label: {
                Label("Sync", systemImage: "arrow.triangle.2.circlepath")
            }
            .tint(.blue)

            Button(role: .destructive) {
                Task {
                    await store.deleteThread(threadID: thread.thread_id)
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func shortThreadID(_ threadID: String) -> String {
        let trimmed = threadID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "ID: -" }
        let suffix = String(trimmed.suffix(8))
        return "ID: \(suffix)"
    }

    private func copyThreadID(_ threadID: String) {
        UIPasteboard.general.string = threadID
        copiedThreadID = threadID
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            if copiedThreadID == threadID {
                copiedThreadID = nil
            }
        }
    }

    @ViewBuilder
    private func statusPill(_ status: String) -> some View {
        Text(status.uppercased())
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(statusColor(status).opacity(0.2), in: Capsule())
            .foregroundStyle(statusColor(status))
    }

    private func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "running", "streaming", "active": return .blue
        case "queued", "claimed", "deleting", "interrupted", "waiting_on_approval", "waiting_on_user_input", "notloaded", "not_loaded", "session_not_loaded", "session_not_found": return .orange
        case "completed", "idle": return .green
        case "failed", "error", "timeout", "systemerror": return .red
        default: return .secondary
        }
    }

    private func sourceTag(for source: String) -> String? {
        let value = source.lowercased()
        if value.contains("session") { return "Desktop Thread" }
        if value == "ios" { return "iPhone" }
        if value == "connector" { return "Connector" }
        return nil
    }

    private var isSearchActive: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSyncAllSessions: Bool {
        store.isConfigured && store.syncableSessionThreadsCount() > 0
    }

    private func isCollapsed(_ workspace: String) -> Bool {
        collapsedWorkspaces.contains(workspace)
    }

    private func toggleWorkspaceCollapse(_ workspace: String) {
        dismissKeyboard()
        if collapsedWorkspaces.contains(workspace) {
            let names = store.threadWorkspaceGroups().map(\.workspace)
            collapsedWorkspaces = Set(names)
            collapsedWorkspaces.remove(workspace)
            rememberLastOpenedWorkspace(workspace, persistCollapsedState: false)
        } else {
            collapsedWorkspaces.insert(workspace)
            expandedWorkspaceThreads.remove(workspace)
        }
        persistCollapsedWorkspaces()
    }

    private func collapseAllWorkspaces() {
        dismissKeyboard()
        let names = store.threadWorkspaceGroups().map(\.workspace)
        collapsedWorkspaces = Set(names)
        expandedWorkspaceThreads.removeAll()
        persistCollapsedWorkspaces()
    }

    private func expandAllWorkspaces() {
        dismissKeyboard()
        collapsedWorkspaces.removeAll()
        persistCollapsedWorkspaces()
    }

    private func dismissKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func persistCollapsedWorkspaces() {
        UserDefaults.standard.set(Array(collapsedWorkspaces).sorted(), forKey: Self.collapsedWorkspacesKey)
    }

    private func createThread(in workspace: String?) {
        dismissKeyboard()
        let targetWorkspace = normalizedWorkspace(workspace) ?? activeWorkspaceForNewThread()
        Task {
            if let threadID = await store.createThread(workspace: targetWorkspace) {
                await store.refreshThread(threadID: threadID)
                if let created = store.threads.first(where: { $0.thread_id == threadID }) {
                    rememberLastOpenedWorkspace(created.workspace, persistCollapsedState: true)
                }
            }
        }
    }

    private func syncAllSessions() {
        dismissKeyboard()
        guard canSyncAllSessions, !isSyncingAllSessions else { return }
        Task { @MainActor in
            isSyncingAllSessions = true
            defer { isSyncingAllSessions = false }
            _ = await store.requestSessionSyncForAllThreads()
            await store.refreshNow()
        }
    }

    private func activeWorkspaceForNewThread() -> String? {
        let groups = isSearchActive ? filteredGroups : store.threadWorkspaceGroups()
        let valid = Set(groups.map(\.workspace))
        if let expandedWorkspace = primaryExpandedWorkspace(from: groups),
           let workspace = normalizedWorkspace(expandedWorkspace) {
            return workspace
        }
        if let preferred = preferredWorkspace(from: valid),
           let workspace = normalizedWorkspace(preferred) {
            return workspace
        }
        if let firstVisible = groups.first?.workspace,
           let workspace = normalizedWorkspace(firstVisible) {
            return workspace
        }
        if let selectedThreadID = store.selectedThreadID,
           let selected = store.threads.first(where: { $0.thread_id == selectedThreadID }),
           let workspace = normalizedWorkspace(selected.workspace) {
            return workspace
        }
        if let firstGroup = store.threadWorkspaceGroups().first?.workspace,
           let workspace = normalizedWorkspace(firstGroup) {
            return workspace
        }
        return nil
    }

    private func primaryExpandedWorkspace(from groups: [ChatThreadWorkspaceGroup]) -> String? {
        guard !groups.isEmpty else { return nil }
        for group in groups where !isCollapsed(group.workspace) {
            return group.workspace
        }
        return nil
    }

    private func normalizedWorkspace(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func rememberLastOpenedWorkspace(_ workspace: String, persistCollapsedState: Bool = true) {
        let value = workspace.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        lastOpenedWorkspace = value
        UserDefaults.standard.set(value, forKey: Self.lastOpenedWorkspaceKey)
        let names = store.threadWorkspaceGroups().map(\.workspace)
        collapsedWorkspaces = Set(names)
        collapsedWorkspaces.remove(value)
        if persistCollapsedState {
            persistCollapsedWorkspaces()
        }
    }

    private func visibleThreads(for group: ChatThreadWorkspaceGroup) -> [ChatThread] {
        if isSearchActive { return group.threads }
        if expandedWorkspaceThreads.contains(group.workspace) { return group.threads }
        if group.threads.count <= Self.previewThreadLimit { return group.threads }
        return Array(group.threads.prefix(Self.previewThreadLimit))
    }

    private func shouldShowMore(for group: ChatThreadWorkspaceGroup) -> Bool {
        if isSearchActive { return false }
        if expandedWorkspaceThreads.contains(group.workspace) { return false }
        return group.threads.count > Self.previewThreadLimit
    }

    private func shouldShowLess(for group: ChatThreadWorkspaceGroup) -> Bool {
        if isSearchActive { return false }
        if !expandedWorkspaceThreads.contains(group.workspace) { return false }
        return group.threads.count > Self.previewThreadLimit
    }

    private func applyWorkspaceCollapseDefaults(force: Bool) {
        let groups = store.threadWorkspaceGroups()
        let names = groups.map(\.workspace)
        let valid = Set(names)
        var nextCollapsed = collapsedWorkspaces.intersection(valid)

        if force {
            guard !names.isEmpty else {
                collapsedWorkspaces.removeAll()
                persistCollapsedWorkspaces()
                return
            }
            if let persisted = UserDefaults.standard.stringArray(forKey: Self.collapsedWorkspacesKey) {
                nextCollapsed = Set(persisted).intersection(valid)
            } else if let preferred = preferredWorkspace(from: valid), !preferred.isEmpty {
                nextCollapsed = Set(names)
                nextCollapsed.remove(preferred)
            } else {
                nextCollapsed.removeAll()
            }
            collapsedWorkspaces = nextCollapsed
            persistCollapsedWorkspaces()
            return
        }

        if nextCollapsed != collapsedWorkspaces {
            collapsedWorkspaces = nextCollapsed
            persistCollapsedWorkspaces()
        }
    }

    private func preferredWorkspace(from valid: Set<String>) -> String? {
        let trimmedLastOpened = lastOpenedWorkspace.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLastOpened.isEmpty else { return nil }
        return valid.contains(trimmedLastOpened) ? trimmedLastOpened : nil
    }

    private func interactionTimeLabel(from raw: String) -> String {
        if let date = Self.iso8601Fractional.date(from: raw) ?? Self.iso8601.date(from: raw) {
            let relative = Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
            let absolute = Self.clockFormatter.string(from: date)
            return "\(relative) · \(absolute)"
        }
        return raw
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

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static let collapsedWorkspacesKey = "threads.collapsedWorkspaces"
    private static let lastOpenedWorkspaceKey = "threads.lastOpenedWorkspace"
    private static let previewThreadLimit = 6
}
