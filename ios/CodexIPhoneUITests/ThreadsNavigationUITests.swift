import XCTest

final class ThreadsNavigationUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testOpenThreadByTappingTrailingEdge() throws {
        var relayBaseURL = envValue("CODEX_RELAY_BASE_URL")
        var relayToken = envValue("CODEX_RELAY_TOKEN")
        var relayWorkspace = ProcessInfo.processInfo.environment["CODEX_RELAY_WORKSPACE"] ?? "*"
        var hasRelayConfig = !relayBaseURL.isEmpty && !relayToken.isEmpty

        if !hasRelayConfig {
            let fallback = loadRelayConfigFromBundle()
            if relayBaseURL.isEmpty { relayBaseURL = fallback.baseURL }
            if relayToken.isEmpty { relayToken = fallback.token }
            if relayWorkspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                relayWorkspace = fallback.workspace
            }
            hasRelayConfig = !relayBaseURL.isEmpty && !relayToken.isEmpty
        }
        if !hasRelayConfig {
            relayBaseURL = "https://ui-test.local"
            relayToken = "ui-test-token"
            relayWorkspace = relayWorkspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "default" : relayWorkspace
            hasRelayConfig = true
        }

        let app = XCUIApplication()
        if hasRelayConfig {
            app.launchEnvironment["CODEX_RELAY_BASE_URL"] = relayBaseURL
            app.launchEnvironment["CODEX_RELAY_TOKEN"] = relayToken
            app.launchEnvironment["CODEX_RELAY_WORKSPACE"] = relayWorkspace
        }
        app.launchEnvironment["CODEX_UI_TEST_SEED_THREADS"] = "1"
        app.launchEnvironment["CODEX_RELAY_POLL_SECONDS"] = "2"
        app.launch()

        let threadsBar = app.navigationBars["Threads"]
        if !threadsBar.waitForExistence(timeout: 10) {
            _ = configureLoginIfNeeded(
                in: app,
                baseURL: relayBaseURL,
                token: relayToken,
                workspace: relayWorkspace,
                hasRelayConfig: hasRelayConfig
            )
        }
        XCTAssertTrue(threadsBar.waitForExistence(timeout: 20), "Threads screen did not load")

        XCTAssertTrue(
            prepareOpenableThread(
                in: app,
                threadsBar: threadsBar,
                baseURL: relayBaseURL,
                token: relayToken,
                workspace: relayWorkspace,
                hasRelayConfig: hasRelayConfig
            ),
            "Failed to prepare an openable thread row"
        )

        for attempt in 1...2 {
            XCTAssertTrue(openThreadRowByTrailingEdge(in: app), "Attempt \(attempt): failed to open thread row")

            let messageInput = app.descendants(matching: .any).matching(identifier: "chat-input-message").firstMatch
            XCTAssertTrue(messageInput.waitForExistence(timeout: 10), "Attempt \(attempt): chat input missing")

            let backButton = app.navigationBars.buttons.element(boundBy: 0)
            XCTAssertTrue(backButton.waitForExistence(timeout: 8), "Attempt \(attempt): back button missing")
            backButton.tap()

            XCTAssertTrue(threadsBar.waitForExistence(timeout: 10), "Attempt \(attempt): did not return to Threads list")
        }
    }

    private func prepareOpenableThread(
        in app: XCUIApplication,
        threadsBar: XCUIElement,
        baseURL: String,
        token: String,
        workspace: String,
        hasRelayConfig: Bool
    ) -> Bool {
        if waitForThreadRows(in: app, timeout: 6) {
            return true
        }
        expandAllFromToolbar(in: app)
        if waitForThreadRows(in: app, timeout: 10) {
            return true
        }
        if tryCreateThreadFromFallbackEntry(in: app),
           waitForThreadRows(in: app, timeout: 20) {
            return true
        }

        if !waitForWorkspaceHeader(in: app, timeout: 10) {
            _ = configureLoginIfNeeded(
                in: app,
                baseURL: baseURL,
                token: token,
                workspace: workspace,
                hasRelayConfig: hasRelayConfig
            )
            _ = threadsBar.waitForExistence(timeout: 10)
        }

        guard waitForWorkspaceHeader(in: app, timeout: 18) else { return false }

        let headerButtons = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workspace-header-"))

        let firstHeader = firstHittableElement(in: headerButtons)
        firstHeader?.tap()

        let addButtons = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workspace-add-"))
        if let add = firstHittableElement(in: addButtons) {
            add.tap()
        }

        if waitForThreadRows(in: app, timeout: 20) {
            return true
        }
        if tryCreateThreadFromFallbackEntry(in: app),
           waitForThreadRows(in: app, timeout: 20) {
            return true
        }
        expandAllFromToolbar(in: app)
        return waitForThreadRows(in: app, timeout: 10)
    }

    private func waitForWorkspaceHeader(in app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let headers = workspaceHeaderButtons(in: app)
        return headers.firstMatch.waitForExistence(timeout: timeout)
    }

    private func openThreadRowByTrailingEdge(in app: XCUIApplication) -> Bool {
        if !waitForThreadRows(in: app, timeout: 16) {
            expandAllFromToolbar(in: app)
            if !waitForThreadRows(in: app, timeout: 8) {
                return false
            }
        }

        var rows = threadRowsQuery(in: app).allElementsBoundByIndex
        if rows.isEmpty {
            rows = app.cells.allElementsBoundByIndex.filter { isLikelyThreadCell($0) }
        }
        guard let row = rows.first(where: { $0.isHittable }) ?? rows.first else { return false }
        let rightEdge = row.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.5))
        rightEdge.tap()
        return true
    }

    private func waitForThreadRows(in app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if threadRowsQuery(in: app).count > 0 {
                return true
            }
            if app.cells.allElementsBoundByIndex.contains(where: { isLikelyThreadCell($0) }) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return false
    }

    private func threadRowsQuery(in app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread-row-"))
    }

    private func workspaceHeaderButtons(in app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(
            NSPredicate(
                format: "identifier BEGINSWITH %@ OR label CONTAINS[c] %@",
                "workspace-header-",
                "("
            )
        )
    }

    private func expandAllFromToolbar(in app: XCUIApplication) {
        let folders = app.navigationBars.buttons["Folders"]
        guard folders.waitForExistence(timeout: 2), folders.isHittable else { return }
        folders.tap()
        let expandAll = app.buttons["Expand All"]
        guard expandAll.waitForExistence(timeout: 2) else { return }
        expandAll.tap()
    }

    private func tryCreateThreadFromFallbackEntry(in app: XCUIApplication) -> Bool {
        let addFromEmpty = app.buttons["threads-add-empty-state"]
        if addFromEmpty.waitForExistence(timeout: 2) {
            addFromEmpty.tap()
            return true
        }

        let addGlobal = app.buttons["threads-add-global"]
        if addGlobal.waitForExistence(timeout: 2) {
            addGlobal.tap()
            return true
        }
        return false
    }

    private func firstHittableElement(in query: XCUIElementQuery) -> XCUIElement? {
        let elements = query.allElementsBoundByIndex
        for element in elements where element.isHittable {
            return element
        }
        return elements.first
    }

    private func isLikelyThreadCell(_ cell: XCUIElement) -> Bool {
        let texts = cell.staticTexts.allElementsBoundByIndex
            .map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if texts.isEmpty { return false }
        let lowered = texts.map { $0.lowercased() }
        if lowered.contains("no matching threads") ||
            lowered.contains("no threads yet") ||
            lowered.contains("create your first thread to start chatting.") ||
            lowered.contains("new thread") {
            return false
        }
        if texts.contains("Show less") { return false }
        if texts.contains(where: { $0.hasPrefix("Show ") && $0.contains(" more") }) { return false }
        if texts.count == 1, texts[0].range(of: #"\(\d+\)\s*$"#, options: .regularExpression) != nil {
            return false
        }

        let hasWorkspaceCounter = texts.contains(where: { $0.range(of: #"^\(\d+\)$"#, options: .regularExpression) != nil })
        let hasTimeLabel = lowered.contains(where: {
            $0.contains("ago") || $0.contains("yesterday") || $0.contains("today")
                || $0.range(of: #"\b\d{1,2}:\d{2}\b"#, options: .regularExpression) != nil
        })
        let statusTokens: Set<String> = [
            "queued", "running", "streaming", "claimed", "interrupted",
            "notloaded", "not_loaded", "session_not_loaded", "session_not_found",
            "completed", "idle", "failed", "error", "timeout", "systemerror", "deleting"
        ]
        let hasStatus = lowered.contains(where: { statusTokens.contains($0) })

        if hasWorkspaceCounter && !hasStatus && !hasTimeLabel {
            return false
        }

        return hasStatus || hasTimeLabel
    }

    private func configureLoginIfNeeded(
        in app: XCUIApplication,
        baseURL: String,
        token: String,
        workspace: String,
        hasRelayConfig: Bool
    ) -> Bool {
        let save = app.buttons["login-save-start"]
        guard save.waitForExistence(timeout: 5) else { return false }
        guard hasRelayConfig else { return false }

        let baseField = app.textFields["login-base-url"]
        let tokenField = app.secureTextFields["login-token"]
        let workspaceField = app.textFields["login-workspace"]
        guard baseField.waitForExistence(timeout: 5),
              tokenField.waitForExistence(timeout: 5),
              workspaceField.waitForExistence(timeout: 5) else {
            return false
        }

        replaceText(baseField, with: baseURL)
        replaceText(tokenField, with: token)
        replaceText(workspaceField, with: workspace)
        save.tap()
        return app.navigationBars["Threads"].waitForExistence(timeout: 20)
    }

    private func replaceText(_ element: XCUIElement, with text: String) {
        element.tap()
        let current = (element.value as? String) ?? ""
        let deleteCount = max(20, current.count)
        element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: deleteCount))
        element.typeText(text)
    }

    private func envValue(_ key: String) -> String {
        ProcessInfo.processInfo.environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private func loadRelayConfigFromBundle() -> (baseURL: String, token: String, workspace: String) {
        guard let url = Bundle(for: Self.self).url(forResource: "RelayUITestConfig", withExtension: "json"),
              let data = try? Data(contentsOf: url) else {
            return ("", "", "*")
        }

        struct RelayConfig: Decodable {
            let base_url: String?
            let token: String?
            let workspace: String?
        }
        guard let cfg = try? JSONDecoder().decode(RelayConfig.self, from: data) else {
            return ("", "", "*")
        }
        let baseURL = cfg.base_url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = cfg.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let workspace = cfg.workspace?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? (cfg.workspace ?? "*")
            : "*"
        return (baseURL, token, workspace)
    }
}
