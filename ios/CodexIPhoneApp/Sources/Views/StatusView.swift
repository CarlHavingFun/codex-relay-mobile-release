import SwiftUI

struct StatusView: View {
    @EnvironmentObject private var store: RelayStore

    var body: some View {
        NavigationStack {
            List {
                Section("Relay Status") {
                    keyValue("Status Source", statusSourceText())
                    keyValue("connector_online", onlineText(connectorOnlineValue()))
                    keyValue("runner_online", onlineText(runnerOnlineValue()))
                    keyValue("State", upperText(store.relayRuntimeStatus?.state))
                    keyValue("Message", valueOrDash(store.relayRuntimeStatus?.message))
                }

                Section("Connector") {
                    keyValue("Connector ID", valueOrDash(store.relayRuntimeStatus?.connector?.connector_id))
                    keyValue("Workspace", valueOrDash(store.relayRuntimeStatus?.connector?.workspace))
                    keyValue("connector_online", onlineText(connectorOnlineValue()))
                    keyValue("Status", upperText(store.relayRuntimeStatus?.connector?.status))
                    keyValue("Heartbeat", relativeText(store.relayRuntimeStatus?.connector?.last_heartbeat_at))
                    keyValue("Last Error", valueOrDash(store.relayRuntimeStatus?.connector?.last_error_message))
                }

                Section("Legacy Runner") {
                    keyValue("Runner ID", valueOrDash(store.relayRuntimeStatus?.runner?.runner_id ?? store.status?.runner_id))
                    keyValue(
                        "runner_online",
                        onlineText(runnerOnlineValue())
                    )
                    keyValue("Updated", relativeText(store.relayRuntimeStatus?.runner?.updated_at ?? store.status?.updated_at))
                    keyValue("Last Success", relativeText(store.relayRuntimeStatus?.runner?.last_success_at ?? store.status?.last_success_at))
                    keyValue("Last Error", valueOrDash(store.relayRuntimeStatus?.runner?.last_error ?? store.status?.last_error))
                }

                Section("Current Task") {
                    keyValue("Task ID", store.currentTask?.task_id ?? "-")
                    keyValue("Mode", store.currentTask?.task_mode ?? "-")
                    keyValue("Status", store.currentTask?.status ?? "-")
                    keyValue("Text", store.currentTask?.task_text ?? "-")
                }

                Section("Recent Events") {
                    ForEach(store.events.prefix(30)) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("[\(event.level ?? "info")] \(event.phase ?? "-")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(event.message ?? "")
                                .font(.body)
                            Text(event.ts ?? "")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if let err = store.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(Color.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
                        .padding(.bottom, 8)
                }
            }
            .refreshable {
                await store.refreshNow()
            }
            .navigationTitle("Status")
            .toolbar {
                Button("Refresh") {
                    Task { await store.refreshNow() }
                }
            }
        }
    }

    @ViewBuilder
    private func keyValue(_ key: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(key)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
    }

    private func valueOrDash(_ value: String?) -> String {
        let text = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "-" : text
    }

    private func upperText(_ value: String?) -> String {
        let text = valueOrDash(value)
        return text == "-" ? text : text.uppercased()
    }

    private func onlineText(_ value: Bool?) -> String {
        guard let value else { return "-" }
        return value ? "ONLINE" : "OFFLINE"
    }

    private func statusSourceText() -> String {
        switch (store.relayRuntimeStatus?.source ?? "").lowercased() {
        case "codex-iphone-connector":
            return "codex-iphone-connector (primary)"
        case "legacy-runner":
            return "legacy-runner"
        case "connector":
            return "codex-iphone-connector (legacy value)"
        case "runner":
            return "legacy-runner (legacy value)"
        case "none":
            return "NO HEARTBEAT"
        default:
            return "-"
        }
    }

    private func connectorOnlineValue() -> Bool? {
        store.relayRuntimeStatus?.connector_online
            ?? store.relayRuntimeStatus?.connector?.connector_online
    }

    private func runnerOnlineValue() -> Bool? {
        store.relayRuntimeStatus?.runner_online
            ?? store.relayRuntimeStatus?.runner?.runner_online
            ?? store.status?.runner_online
    }

    private func relativeText(_ raw: String?) -> String {
        let text = valueOrDash(raw)
        guard text != "-" else { return text }
        guard let date = Self.iso8601Fractional.date(from: text) ?? Self.iso8601.date(from: text) else {
            return text
        }
        let rel = Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
        return "\(rel) · \(Self.dateTimeFormatter.string(from: date))"
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
}
