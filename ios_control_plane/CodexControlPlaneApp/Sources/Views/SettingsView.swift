import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: ControlPlaneStore

    @State private var baseURLDraft = ""
    @State private var tokenDraft = ""
    @State private var workspaceDraft = ""
    @State private var languageDraft: AppLanguage = .system
    @State private var showFineDraft = false
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("settings.section.connection") {
                    TextField("settings.field.base_url", text: $baseURLDraft)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()

                    SecureField("settings.field.token", text: $tokenDraft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("settings.field.workspace", text: $workspaceDraft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Text("settings.connection.help")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Button {
                        saveConnection()
                    } label: {
                        if isSaving {
                            ProgressView("settings.action.saving")
                        } else {
                            Text("settings.action.save_connection")
                        }
                    }
                    .disabled(baseURLDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                }

                Section("settings.section.display") {
                    Picker("settings.field.language", selection: $languageDraft) {
                        ForEach(AppLanguage.allCases) { language in
                            Text(languageLabel(language)).tag(language)
                        }
                    }
                    .onChange(of: languageDraft) { _, newValue in
                        store.setLanguage(newValue)
                    }

                    Toggle("settings.field.show_fine_grained", isOn: $showFineDraft)
                        .onChange(of: showFineDraft) { _, newValue in
                            store.setShowFineGrainedTasks(newValue)
                        }
                }

                Section("settings.section.current") {
                    LabeledContent("settings.current.base_url", value: store.baseURL.isEmpty ? "-" : store.baseURL)
                    LabeledContent("settings.current.token", value: store.token.isEmpty ? "-" : "••••••••")
                    LabeledContent("settings.current.workspace", value: store.workspace.isEmpty ? "-" : store.workspace)
                    LabeledContent("settings.current.backend", value: store.backendModeLabel)
                    LabeledContent("settings.current.configured", value: store.isConfigured ? store.localizedText("common.yes") : store.localizedText("common.no"))
                }

                if let error = store.errorMessage, !error.isEmpty {
                    Section("settings.section.last_error") {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)

                        if let raw = store.rawErrorMessage, !raw.isEmpty {
                            Text(raw)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("settings.section.actions") {
                    Button {
                        Task { await store.refreshNow() }
                    } label: {
                        Label("settings.action.refresh_now", systemImage: "arrow.clockwise")
                    }
                    .disabled(!store.isConfigured)
                }
            }
            .navigationTitle("settings.nav.title")
            .onAppear {
                baseURLDraft = store.baseURL
                tokenDraft = store.token
                workspaceDraft = store.workspace
                languageDraft = store.appLanguage
                showFineDraft = store.showFineGrainedTasks
            }
        }
    }

    private func saveConnection() {
        isSaving = true
        store.saveSettings(baseURL: baseURLDraft, token: tokenDraft, workspace: workspaceDraft)
        Task {
            await store.refreshNow()
            isSaving = false
        }
    }

    private func languageLabel(_ language: AppLanguage) -> LocalizedStringKey {
        switch language {
        case .system:
            return "settings.language.system"
        case .zhHans:
            return "settings.language.zh_hans"
        case .en:
            return "settings.language.en"
        }
    }
}
