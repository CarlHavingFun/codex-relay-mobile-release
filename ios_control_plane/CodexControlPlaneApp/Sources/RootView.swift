import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: ControlPlaneStore

    var body: some View {
        TabView {
            TasksView()
                .tabItem { Label(LocalizedStringKey("tab.tasks"), systemImage: "list.bullet.rectangle") }
            HealthView()
                .tabItem { Label(LocalizedStringKey("tab.health"), systemImage: "waveform.path.ecg") }
            SettingsView()
                .tabItem { Label(LocalizedStringKey("tab.settings"), systemImage: "gearshape") }
        }
    }
}
