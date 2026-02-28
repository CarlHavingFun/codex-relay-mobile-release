import SwiftUI

struct HealthView: View {
    @EnvironmentObject private var store: ControlPlaneStore
    @State private var busyAction: String?

    var body: some View {
        NavigationStack {
            Form {
                if !store.isConfigured {
                    ContentUnavailableView(
                        LocalizedStringKey("health.empty.not_configured_title"),
                        systemImage: "gearshape",
                        description: Text("health.empty.not_configured_desc")
                    )
                } else {
                    Section("health.section.control_plane") {
                        metric("health.metric.loop", store.health?.loop_ms.map { "\($0) ms" })
                        metric("health.metric.tick_in_flight", boolText(store.health?.tick_in_flight))
                        metric("health.metric.last_tick_at", store.health?.last_tick_at)
                        metric("health.metric.last_tick_error", store.health?.last_tick_error)
                    }

                    Section("health.section.task_counts") {
                        metric("health.metric.queued", store.health?.task_counts?.queued.map(String.init))
                        metric("health.metric.planning", store.health?.task_counts?.planning.map(String.init))
                        metric("health.metric.running", store.health?.task_counts?.running.map(String.init))
                        metric("health.metric.reviewing", store.health?.task_counts?.reviewing.map(String.init))
                        metric("health.metric.releasing", store.health?.task_counts?.releasing.map(String.init))
                        metric("health.metric.done", store.health?.task_counts?.done.map(String.init))
                        metric("health.metric.failed", store.health?.task_counts?.failed.map(String.init))
                        metric("health.metric.rolled_back", store.health?.task_counts?.rolled_back.map(String.init))
                        metric("health.metric.paused", store.health?.task_counts?.paused.map(String.init))
                        metric("health.metric.canceled", store.health?.task_counts?.canceled.map(String.init))
                    }

                    Section("health.section.safety") {
                        metric("health.metric.emergency_stop", boolText(store.health?.system?.emergency_stop?.active))
                        metric("health.metric.circuit", store.health?.system?.circuit_breaker?.status)
                        metric("health.metric.circuit_failures", store.health?.system?.circuit_breaker?.failure_count.map(String.init))
                        metric("health.metric.global_active_jobs", store.health?.system?.global_active_jobs.map(String.init))
                    }

                    if store.supportsGlobalControls {
                        Section("health.section.global_controls") {
                            controlButton(
                                title: store.localizedText("health.control.clear_emergency_stop"),
                                action: "emergency_stop_clear",
                                role: .destructive
                            )
                            controlButton(
                                title: store.localizedText("health.control.reset_circuit"),
                                action: "circuit_reset",
                                role: .destructive
                            )
                        }
                    } else {
                        Section("health.section.global_controls") {
                            Text("health.global_controls.unsupported")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Section("health.section.actions") {
                        Button {
                            Task { await store.refreshNow() }
                        } label: {
                            Label("health.action.refresh_now", systemImage: "arrow.clockwise")
                        }
                    }
                }
            }
            .navigationTitle("health.nav.title")
            .task {
                if store.isConfigured {
                    await store.refreshNow()
                }
            }
        }
    }

    @ViewBuilder
    private func metric(_ name: LocalizedStringKey, _ value: String?) -> some View {
        LabeledContent(name, value: display(value))
    }

    private func display(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized.isEmpty ? "-" : normalized
    }

    private func boolText(_ value: Bool?) -> String {
        guard let value else { return "-" }
        return value ? store.localizedText("common.true") : store.localizedText("common.false")
    }

    @ViewBuilder
    private func controlButton(title: String, action: String, role: ButtonRole? = nil) -> some View {
        Button(role: role) {
            guard busyAction == nil else { return }
            busyAction = action
            Task {
                await store.controlGlobal(action: action, reason: "iOS operator action")
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
        .disabled(busyAction != nil)
    }
}
