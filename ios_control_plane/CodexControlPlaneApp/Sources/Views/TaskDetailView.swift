import SwiftUI

struct TaskDetailView: View {
    @EnvironmentObject private var store: ControlPlaneStore
    let taskID: String

    @State private var busyAction: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let task = task {
                    GroupBox(store.localizedText("task_detail.section.summary")) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(task.goal).font(.headline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if let semantic = task.semantic {
                                if let sourceWorkspace = semantic.sourceWorkspace, !sourceWorkspace.isEmpty {
                                    Text("\(store.localizedText("task_detail.source_workspace")): \(sourceWorkspace)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                if let threadID = semantic.threadID, !threadID.isEmpty {
                                    Text("\(store.localizedText("task_detail.thread_id")): \(threadID)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            HStack {
                                Text("\(store.localizedText("task_detail.status")): \(store.localizedStatus(task.status))")
                                Spacer()
                                Text("\(store.localizedText("task_detail.priority")): \(task.priority)")
                            }
                            .font(.subheadline)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    GroupBox(store.localizedText("task_detail.section.dag")) {
                        let d = task.dag_progress
                        VStack(alignment: .leading, spacing: 6) {
                            row(store.localizedText("task_detail.metric.total"), d?.total)
                            row(store.localizedText("task_detail.metric.queued"), d?.queued)
                            row(store.localizedText("task_detail.metric.running"), d?.running)
                            row(store.localizedText("task_detail.metric.completed"), d?.completed)
                            row(store.localizedText("task_detail.metric.failed"), d?.failed)
                            row(store.localizedText("task_detail.metric.canceled"), d?.canceled)
                        }
                    }

                    GroupBox(store.localizedText("task_detail.section.controls")) {
                        VStack(alignment: .leading, spacing: 10) {
                            controlButton(store.localizedText("task_detail.control.pause"), action: "pause")
                            controlButton(store.localizedText("task_detail.control.resume"), action: "resume")
                            controlButton(store.localizedText("task_detail.control.cancel"), action: "cancel")
                            controlButton(store.localizedText("task_detail.control.emergency_stop"), action: "emergency_stop", role: .destructive)
                            controlButton(store.localizedText("task_detail.control.force_rollback"), action: "force_rollback", role: .destructive)
                        }
                    }

                    if let jobs = task.sub_tasks, !jobs.isEmpty {
                        GroupBox(store.localizedText("task_detail.section.sub_tasks")) {
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(jobs) { job in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("\(job.node_id) · \(job.role)")
                                            .font(.subheadline).bold()
                                        Text(store.localizedFormat(
                                            "task_detail.sub_task.status_attempt",
                                            store.localizedStatus(job.status),
                                            job.attempt,
                                            job.max_retries
                                        ))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        if let err = job.last_error, !err.isEmpty {
                                            Text(err)
                                                .font(.caption)
                                                .foregroundStyle(.red)
                                                .lineLimit(3)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    if job.id != jobs.last?.id {
                                        Divider()
                                    }
                                }
                            }
                        }
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .padding(16)
        }
        .navigationTitle("task_detail.nav.title")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            try? await store.refreshTaskDetail(taskID: taskID)
        }
    }

    private var task: CPTaskDetail? {
        if store.selectedTask?.task_id == taskID {
            return store.selectedTask
        }
        return nil
    }

    @ViewBuilder
    private func row(_ title: String, _ value: Int?) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value.map(String.init) ?? "-")
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
    }

    @ViewBuilder
    private func controlButton(_ title: String, action: String, role: ButtonRole? = nil) -> some View {
        Button(role: role) {
            guard busyAction == nil else { return }
            busyAction = action
            Task {
                await store.controlTask(taskID: taskID, action: action)
                try? await store.refreshTaskDetail(taskID: taskID)
                busyAction = nil
            }
        } label: {
            HStack {
                if busyAction == action {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(title)
            }
        }
        .disabled(busyAction != nil || !store.supportsTaskAction(action))
    }
}
