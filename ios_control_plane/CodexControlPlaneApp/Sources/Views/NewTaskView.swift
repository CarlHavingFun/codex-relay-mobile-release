import SwiftUI

struct NewTaskView: View {
    @EnvironmentObject private var store: ControlPlaneStore
    @Environment(\.dismiss) private var dismiss

    @State private var goal = ""
    @State private var repo = ""
    @State private var branch = "main"
    @State private var criteriaText = ""
    @State private var priority = "P1"
    @State private var riskProfile = "medium"
    @State private var isSubmitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("new_task.section.goal") {
                    TextField("new_task.placeholder.goal", text: $goal, axis: .vertical)
                        .lineLimit(3...6)
                }
                Section("new_task.section.repo") {
                    TextField("new_task.placeholder.repo", text: $repo)
                    TextField("new_task.placeholder.branch", text: $branch)
                }
                Section("new_task.section.acceptance") {
                    TextEditor(text: $criteriaText)
                        .frame(minHeight: 120)
                }
                Section("new_task.section.policy") {
                    Picker("new_task.priority", selection: $priority) {
                        Text("P0").tag("P0")
                        Text("P1").tag("P1")
                        Text("P2").tag("P2")
                    }
                    Picker("new_task.risk_profile", selection: $riskProfile) {
                        Text("new_task.risk.low").tag("low")
                        Text("new_task.risk.medium").tag("medium")
                        Text("new_task.risk.high").tag("high")
                    }
                }
            }
            .navigationTitle("new_task.nav.title")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("new_task.action.cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("new_task.action.create") {
                        submit()
                    }
                    .disabled(!isValid || isSubmitting)
                }
            }
        }
    }

    private var isValid: Bool {
        !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        guard isValid else { return }
        isSubmitting = true
        let criteria = criteriaText
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        let spec = CPTaskSpec(
            goal: goal.trimmingCharacters(in: .whitespacesAndNewlines),
            repo: repo.trimmingCharacters(in: .whitespacesAndNewlines),
            branch: branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "main" : branch.trimmingCharacters(in: .whitespacesAndNewlines),
            acceptanceCriteria: criteria,
            priority: priority,
            riskProfile: riskProfile
        )

        Task {
            await store.createTask(spec: spec)
            isSubmitting = false
            if store.errorMessage == nil {
                dismiss()
            }
        }
    }
}
