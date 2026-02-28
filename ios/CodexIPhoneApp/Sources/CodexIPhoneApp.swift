import SwiftUI

@main
struct CodexIPhoneApp: App {
    @StateObject private var store = RelayStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .task {
                    store.applyLaunchEnvironmentIfNeeded()
                    await store.bootstrap()
                    await store.runLaunchE2EIfNeeded()
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: RelayStore

    var body: some View {
        if store.isConfigured {
            TabView {
                ThreadsView()
                    .tabItem { Label("Chat", systemImage: "message") }
                StatusView()
                    .tabItem { Label("Status", systemImage: "waveform.path.ecg") }
                ApprovalsView()
                    .tabItem { Label("Approvals", systemImage: "checkmark.shield") }
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gear") }
            }
        } else {
            LoginView()
        }
    }
}
