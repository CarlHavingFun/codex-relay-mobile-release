import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var store: RelayStore
    @State private var baseURL: String = UserDefaults.standard.string(forKey: "relay.baseURL") ?? ""
    @State private var token: String = UserDefaults.standard.string(forKey: "relay.token") ?? ""
    @State private var workspace: String = UserDefaults.standard.string(forKey: "relay.workspace") ?? "*"

    var body: some View {
        NavigationStack {
            Form {
                Section("Onboarding") {
                    Text("Connect this app to your self-hosted Relay server.")
                        .font(.subheadline)
                    Text("Required: Relay Base URL and Bearer token from your server deployment.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !store.accountProfiles.isEmpty {
                    Section("Saved Profiles") {
                        ForEach(store.accountProfiles) { profile in
                            Button {
                                store.switchAccountProfile(id: profile.id)
                                baseURL = store.baseURL
                                token = store.token
                                workspace = store.workspace
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(profile.name)
                                        .font(.body.weight(.medium))
                                    Text("\(profile.base_url) • \(profile.workspace)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section("Relay") {
                    TextField("https://relay.example.com", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login-base-url")
                    SecureField("Bearer Token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login-token")
                    TextField("Workspace (* = all)", text: $workspace)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login-workspace")
                }

                Section {
                    Button("Save and Start") {
                        store.saveConfig(baseURL: baseURL, token: token, workspace: workspace)
                    }
                    .disabled(baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("login-save-start")
                }
            }
            .navigationTitle("Relay Setup")
            .onAppear {
                baseURL = store.baseURL
                token = store.token
                workspace = store.workspace
            }
        }
    }
}
