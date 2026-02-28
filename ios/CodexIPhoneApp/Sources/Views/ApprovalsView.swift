import SwiftUI

struct ApprovalsView: View {
    @EnvironmentObject private var store: RelayStore

    var body: some View {
        NavigationStack {
            List {
                if store.approvals.isEmpty {
                    Text("No pending approvals")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.approvals) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.task_text ?? "")
                                .font(.body)
                            Text(item.risk_reason?.joined(separator: ", ") ?? "")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            HStack {
                                Button("Approve") {
                                    Task { await store.decide(item.id, decision: "approved") }
                                }
                                .buttonStyle(.borderedProminent)

                                Button("Reject") {
                                    Task { await store.decide(item.id, decision: "rejected") }
                                }
                                .buttonStyle(.bordered)
                                .tint(.red)
                            }
                            Text(item.id)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .refreshable {
                await store.refreshNow()
            }
            .navigationTitle("Approvals")
        }
    }
}
