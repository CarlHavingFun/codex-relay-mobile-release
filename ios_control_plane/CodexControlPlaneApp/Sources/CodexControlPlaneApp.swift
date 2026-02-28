import SwiftUI

@main
struct CodexControlPlaneApp: App {
    @StateObject private var store = ControlPlaneStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environment(\.locale, store.preferredLocale)
                .task {
                    store.bootstrap()
                }
        }
    }
}
