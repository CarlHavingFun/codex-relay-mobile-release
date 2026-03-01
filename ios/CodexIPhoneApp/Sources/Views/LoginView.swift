import AVFoundation
import SwiftUI
import UIKit

struct LoginView: View {
    @EnvironmentObject private var store: RelayStore
    @State private var baseURL: String = UserDefaults.standard.string(forKey: "relay.baseURL") ?? ""
    @State private var token: String = UserDefaults.standard.string(forKey: "relay.token") ?? ""
    @State private var workspace: String = UserDefaults.standard.string(forKey: "relay.workspace") ?? ""
    @State private var platformBaseURL: String = UserDefaults.standard.string(forKey: "platform.baseURL") ?? ""
    @State private var platformEmail: String = UserDefaults.standard.string(forKey: "platform.email") ?? ""
    @State private var verificationCode: String = ""
    @State private var platformAccessToken: String = UserDefaults.standard.string(forKey: "platform.accessToken") ?? ""
    @State private var showScanner = false
    @State private var scannerMessage: String?
    @State private var authMessage: String?
    @State private var authBusy = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Onboarding") {
                    Text("Connect this app to hosted relay services.")
                        .font(.subheadline)
                    Text("Recommended: Scan desktop setup QR to configure automatically.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button {
                        scannerMessage = nil
                        showScanner = true
                    } label: {
                        Label("Scan Setup QR", systemImage: "qrcode.viewfinder")
                    }
                }

                if let scannerMessage, !scannerMessage.isEmpty {
                    Section("Scan Result") {
                        Text(scannerMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let error = store.errorMessage, !error.isEmpty {
                    Section("Connection Error") {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                if !store.accountProfiles.isEmpty {
                    Section("Saved Profiles") {
                        ForEach(store.accountProfiles) { profile in
                            Button {
                                store.switchAccountProfile(id: profile.id)
                                syncInputsFromStore()
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

                if let authMessage, !authMessage.isEmpty {
                    Section("Hosted Auth") {
                        Text(authMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Hosted Account") {
                    TextField("https://platform-api-domain", text: $platformBaseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login-platform-base-url")
                    TextField("Email", text: $platformEmail)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login-platform-email")
                    TextField("Verification Code", text: $verificationCode)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.numberPad)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login-platform-code")
                    Button("Send Email Code") {
                        sendEmailCode()
                    }
                    .disabled(authBusy || platformBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || platformEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Verify and Login") {
                        verifyAndLogin()
                    }
                    .disabled(authBusy || platformBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || platformEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || verificationCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if store.hasPlatformSession {
                    Section("Hosted Session") {
                        if !store.platformEmail.isEmpty {
                            LabeledContent("Email", value: store.platformEmail)
                        }
                        if !store.platformTenantID.isEmpty {
                            LabeledContent("Tenant", value: store.platformTenantID)
                        }
                        if !store.platformAccessTokenExpiresAt.isEmpty {
                            LabeledContent("Access Expiry", value: store.platformAccessTokenExpiresAt)
                        }
                        Button("Sync Hosted Relay Config") {
                            syncHostedRelayConfig()
                        }
                        .disabled(authBusy)
                        Button("Sign Out Hosted Session", role: .destructive) {
                            store.clearPlatformSession()
                            authMessage = "Hosted session cleared."
                            syncInputsFromStore()
                        }
                        .disabled(authBusy)
                    }
                }

                Section("Advanced Platform Override") {
                    SecureField("Platform Access Token", text: $platformAccessToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login-platform-access-token")
                    Button("Save Platform Auth") {
                        store.savePlatformConfig(
                            baseURL: platformBaseURL,
                            accessToken: platformAccessToken,
                            email: platformEmail
                        )
                        scannerMessage = "Saved platform auth settings."
                    }
                }

                Section("Relay") {
                    TextField("https://your-relay-domain", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login-base-url")
                    SecureField("Bearer Token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("login-token")
                    TextField("Workspace (optional, * = all)", text: $workspace)
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
                syncInputsFromStore()
            }
            .sheet(isPresented: $showScanner) {
                SetupQRScannerSheet { scannedText in
                    handleScannedPayload(scannedText)
                }
            }
        }
    }

    private func syncInputsFromStore() {
        baseURL = store.baseURL
        token = store.token
        workspace = store.workspace
        platformBaseURL = store.platformBaseURL
        platformEmail = store.platformEmail
        platformAccessToken = store.platformAccessToken
    }

    private func sendEmailCode() {
        authBusy = true
        authMessage = nil
        store.savePlatformConfig(
            baseURL: platformBaseURL,
            accessToken: platformAccessToken,
            email: platformEmail
        )
        Task {
            do {
                let dispatch = try await store.sendPlatformEmailCode(email: platformEmail)
                await MainActor.run {
                    verificationCode = dispatch.devCode ?? ""
                    if let devCode = dispatch.devCode, !devCode.isEmpty {
                        authMessage = "Code sent. Dev code: \(devCode)"
                    } else if let expires = dispatch.expiresAt, !expires.isEmpty {
                        authMessage = "Code sent to \(dispatch.email). Expires at \(expires)."
                    } else {
                        authMessage = "Code sent to \(dispatch.email)."
                    }
                    syncInputsFromStore()
                    authBusy = false
                }
            } catch {
                await MainActor.run {
                    authMessage = store.userFacingError(error)
                    authBusy = false
                }
            }
        }
    }

    private func verifyAndLogin() {
        authBusy = true
        authMessage = nil
        store.savePlatformConfig(
            baseURL: platformBaseURL,
            accessToken: platformAccessToken,
            email: platformEmail
        )
        Task {
            do {
                try await store.verifyPlatformEmailCode(
                    email: platformEmail,
                    code: verificationCode,
                    autoBootstrap: true
                )
                await MainActor.run {
                    authMessage = "Login succeeded. Hosted relay config synced."
                    verificationCode = ""
                    scannerMessage = nil
                    syncInputsFromStore()
                    authBusy = false
                }
            } catch {
                await MainActor.run {
                    authMessage = store.userFacingError(error)
                    authBusy = false
                }
            }
        }
    }

    private func syncHostedRelayConfig() {
        authBusy = true
        authMessage = nil
        Task {
            do {
                try await store.fetchPlatformBootstrapAndApply()
                await MainActor.run {
                    authMessage = "Hosted relay config synced."
                    syncInputsFromStore()
                    authBusy = false
                }
            } catch {
                await MainActor.run {
                    authMessage = store.userFacingError(error)
                    authBusy = false
                }
            }
        }
    }

    private func handleScannedPayload(_ payload: String) {
        let raw = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: raw) else {
            scannerMessage = "Scanned content is not a valid setup link."
            return
        }

        Task {
            let handled = await store.applySetupURL(url)
            await MainActor.run {
                if handled && (store.errorMessage?.isEmpty ?? true) {
                    scannerMessage = "Setup applied successfully."
                    showScanner = false
                    syncInputsFromStore()
                } else if handled {
                    scannerMessage = store.errorMessage ?? "Setup link was handled but configuration failed."
                } else {
                    scannerMessage = "Scanned QR is not a codexrelay setup link."
                }
            }
        }
    }
}

private struct SetupQRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onScanned: (String) -> Void

    var body: some View {
        NavigationStack {
            QRCodeScannerContainer { payload in
                onScanned(payload)
            }
            .navigationTitle("Scan Setup QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
        }
    }
}

private struct QRCodeScannerContainer: UIViewControllerRepresentable {
    let onScanned: (String) -> Void

    func makeUIViewController(context: Context) -> QRCodeScannerViewController {
        let controller = QRCodeScannerViewController()
        controller.onScanned = onScanned
        return controller
    }

    func updateUIViewController(_ uiViewController: QRCodeScannerViewController, context: Context) {}
}

private final class QRCodeScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScanned: ((String) -> Void)?

    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmitCode = false
    private let statusLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureStatusLabel()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        requestCameraAndStart()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        captureSession.stopRunning()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func configureStatusLabel() {
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.textColor = .white
        statusLabel.numberOfLines = 0
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium)
        statusLabel.textAlignment = .center
        statusLabel.text = "Point the camera at a setup QR code."
        view.addSubview(statusLabel)

        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            statusLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24)
        ])
    }

    private func requestCameraAndStart() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            startCapture()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.startCapture()
                    } else {
                        self?.statusLabel.text = "Camera access denied. Enable camera permission in Settings."
                    }
                }
            }
        default:
            statusLabel.text = "Camera access denied. Enable camera permission in Settings."
        }
    }

    private func startCapture() {
        guard previewLayer == nil else {
            if !captureSession.isRunning {
                captureSession.startRunning()
            }
            return
        }
        do {
            try configureSession()
            let previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
            previewLayer.videoGravity = .resizeAspectFill
            previewLayer.frame = view.bounds
            view.layer.insertSublayer(previewLayer, at: 0)
            self.previewLayer = previewLayer
            captureSession.startRunning()
        } catch {
            statusLabel.text = "Unable to start camera scanner."
        }
    }

    private func configureSession() throws {
        captureSession.beginConfiguration()
        captureSession.sessionPreset = .high

        defer {
            captureSession.commitConfiguration()
        }

        guard let device = AVCaptureDevice.default(for: .video) else {
            throw RelayError.invalidResponse
        }
        let input = try AVCaptureDeviceInput(device: device)
        if captureSession.canAddInput(input) {
            captureSession.addInput(input)
        }

        let output = AVCaptureMetadataOutput()
        if captureSession.canAddOutput(output) {
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didEmitCode else { return }
        guard let first = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = first.stringValue,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        didEmitCode = true
        captureSession.stopRunning()
        onScanned?(value)
    }
}
