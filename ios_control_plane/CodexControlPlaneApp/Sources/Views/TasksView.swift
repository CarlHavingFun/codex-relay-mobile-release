import SwiftUI

struct TasksView: View {
    @EnvironmentObject private var store: ControlPlaneStore
    @State private var showingNewTaskSheet = false

    var body: some View {
        NavigationStack {
            Group {
                if !store.isConfigured {
                    ContentUnavailableView(
                        LocalizedStringKey("tasks.empty.not_configured_title"),
                        systemImage: "exclamationmark.triangle",
                        description: Text("tasks.empty.not_configured_desc")
                    )
                } else if store.tasks.isEmpty {
                    ContentUnavailableView(
                        LocalizedStringKey("tasks.empty.no_tasks_title"),
                        systemImage: "tray",
                        description: Text("tasks.empty.no_tasks_desc")
                    )
                } else {
                    List {
                        Section {
                            LabeledContent("tasks.metric.total", value: "\(store.portfolioSummary.totalTasks)")
                            LabeledContent("tasks.metric.groups", value: "\(store.portfolioSummary.groupCount)")
                            LabeledContent("tasks.metric.active", value: "\(store.portfolioSummary.activeCount)")
                            LabeledContent("tasks.metric.running", value: "\(store.portfolioSummary.runningCount)")
                            LabeledContent("tasks.metric.failed", value: "\(store.portfolioSummary.failedCount)")
                            LabeledContent("tasks.metric.waiting_approval", value: "\(store.portfolioSummary.waitingApprovalCount)")
                        } header: {
                            Text("tasks.section.portfolio")
                        }

                        Section {
                            NavigationLink {
                                WorkspaceListView()
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("tasks.link.projects")
                                            .font(.body)
                                        Text("tasks.link.projects_desc")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text("\(store.workspaceGroups.count)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        } header: {
                            Text("tasks.section.navigation")
                        }

                        if !store.workspaceGroups.isEmpty {
                            Section("tasks.section.top_projects") {
                                ForEach(Array(store.workspaceGroups.prefix(3))) { group in
                                    NavigationLink {
                                        WorkspaceDetailView(groupKey: group.id)
                                    } label: {
                                        VStack(alignment: .leading, spacing: 6) {
                                            Text(group.displayName)
                                                .font(.subheadline).bold()
                                            HStack(spacing: 10) {
                                                Text("\(store.localizedText("tasks.metric.active")): \(group.activeCount)")
                                                Text("\(store.localizedText("tasks.metric.running")): \(group.runningCount)")
                                                Text("\(store.localizedText("tasks.metric.failed")): \(group.failedCount)")
                                            }
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        }
                                        .padding(.vertical, 2)
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("tasks.nav.overview")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await store.refreshNow() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(!store.isConfigured)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingNewTaskSheet = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .disabled(!store.isConfigured)
                }
            }
            .sheet(isPresented: $showingNewTaskSheet) {
                NewTaskView()
                    .environmentObject(store)
            }
            .task {
                if store.isConfigured {
                    await store.refreshNow()
                }
            }
        }
    }
}

private struct WorkspaceListView: View {
    @EnvironmentObject private var store: ControlPlaneStore

    var body: some View {
        List {
            ForEach(store.workspaceGroups) { group in
                NavigationLink {
                    WorkspaceDetailView(groupKey: group.id)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(group.displayName)
                            .font(.body).bold()
                        HStack(spacing: 10) {
                            Text("\(store.localizedText("tasks.metric.active")): \(group.activeCount)")
                            Text("\(store.localizedText("tasks.metric.running")): \(group.runningCount)")
                            Text("\(store.localizedText("tasks.metric.failed")): \(group.failedCount)")
                            Text("\(store.localizedText("tasks.metric.waiting_approval")): \(group.waitingApprovalCount)")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 3)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("tasks.nav.projects")
    }
}

private struct WorkspaceDetailView: View {
    @EnvironmentObject private var store: ControlPlaneStore
    let groupKey: String

    @State private var showSubTasks = false

    private var group: CPWorkspaceGroup? {
        store.workspaceGroups.first(where: { $0.id == groupKey })
    }

    var body: some View {
        Group {
            if let group {
                List {
                    Section("tasks.section.project_summary") {
                        LabeledContent("tasks.metric.total", value: "\(group.tasks.count)")
                        LabeledContent("tasks.metric.active", value: "\(group.activeCount)")
                        LabeledContent("tasks.metric.running", value: "\(group.runningCount)")
                        LabeledContent("tasks.metric.failed", value: "\(group.failedCount)")
                        LabeledContent("tasks.metric.waiting_approval", value: "\(group.waitingApprovalCount)")
                    }

                    if !group.masterTasks.isEmpty {
                        Section("tasks.section.master_tasks") {
                            ForEach(group.masterTasks) { task in
                                NavigationLink {
                                    TaskDetailView(taskID: task.task_id)
                                } label: {
                                    TaskRowView(task: task)
                                }
                            }
                        }
                    }

                    if !group.manualTasks.isEmpty {
                        Section("tasks.section.manual_tasks") {
                            ForEach(group.manualTasks) { task in
                                NavigationLink {
                                    TaskDetailView(taskID: task.task_id)
                                } label: {
                                    TaskRowView(task: task)
                                }
                            }
                        }
                    }

                    if !group.subTasks.isEmpty {
                        Section("tasks.section.sub_tasks") {
                            if store.showFineGrainedTasks || showSubTasks {
                                ForEach(group.subTasks) { task in
                                    NavigationLink {
                                        TaskDetailView(taskID: task.task_id)
                                    } label: {
                                        TaskRowView(task: task)
                                    }
                                }
                            } else {
                                Button {
                                    showSubTasks = true
                                } label: {
                                    Text(store.localizedFormat("tasks.button.show_sub_tasks", group.subTasks.count))
                                }
                            }
                        }
                    }

                    if !group.unknownTasks.isEmpty {
                        Section("tasks.section.unknown_tasks") {
                            ForEach(group.unknownTasks) { task in
                                NavigationLink {
                                    TaskDetailView(taskID: task.task_id)
                                } label: {
                                    TaskRowView(task: task)
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .navigationTitle(group.displayName)
                .navigationBarTitleDisplayMode(.inline)
            } else {
                ContentUnavailableView(
                    LocalizedStringKey("tasks.empty.project_not_found_title"),
                    systemImage: "questionmark.folder",
                    description: Text("tasks.empty.project_not_found_desc")
                )
            }
        }
    }
}

private struct TaskRowView: View {
    @EnvironmentObject private var store: ControlPlaneStore
    let task: CPTask

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(titleText)
                .font(.body)
                .lineLimit(2)
            HStack(spacing: 8) {
                statusPill(task.status)
                Text(task.priority)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let thread = task.semantic?.threadID, !thread.isEmpty {
                    Text(thread)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 3)
    }

    private var titleText: String {
        let line = task.goal
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })

        if let line, !line.isEmpty {
            return line
        }
        return task.task_id
    }

    private func statusPill(_ status: String) -> some View {
        Text(store.localizedStatus(status))
            .font(.caption2).bold()
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(statusColor(status).opacity(0.18), in: Capsule())
            .foregroundStyle(statusColor(status))
    }

    private func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "done", "completed": return .green
        case "running", "reviewing", "releasing", "planning", "claimed": return .blue
        case "failed", "rolled_back": return .red
        case "paused", "canceled", "cancelled", "rejected", "waiting_approval": return .orange
        default: return .gray
        }
    }
}
