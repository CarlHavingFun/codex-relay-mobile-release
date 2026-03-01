import XCTest

final class PlanModeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testPlanModeIgnoreRestoreAndSubmitFlow() throws {
        let app = XCUIApplication()
        app.launchEnvironment["CODEX_UI_TEST_SEED_THREADS"] = "1"
        app.launchEnvironment["CODEX_UI_TEST_SEED_PLAN_MODE"] = "1"
        app.launchEnvironment["CODEX_UI_TEST_SHOW_THINKING_MESSAGES"] = "1"
        app.launchEnvironment["CODEX_UI_TEST_PLAN_COLLAPSED"] = "1"
        app.launch()

        let threadsBar = app.navigationBars["Threads"]
        XCTAssertTrue(threadsBar.waitForExistence(timeout: 12), "Threads screen did not load")

        let threadRow = app.descendants(matching: .any).matching(identifier: "thread-row-ui-test-plan-thread").firstMatch
        XCTAssertTrue(threadRow.waitForExistence(timeout: 10), "Plan seed thread row missing")
        threadRow.tap()

        let messageInput = app.descendants(matching: .any).matching(identifier: "chat-input-message").firstMatch
        XCTAssertTrue(messageInput.waitForExistence(timeout: 10), "Chat view did not open")

        let proposedPlanCard = app.descendants(matching: .any).matching(identifier: "proposed-plan-card").firstMatch
        XCTAssertTrue(proposedPlanCard.waitForExistence(timeout: 8), "Proposed plan card not rendered")

        let progressToggle = app.descendants(matching: .any).matching(identifier: "plan-progress-toggle").firstMatch
        XCTAssertTrue(progressToggle.waitForExistence(timeout: 8), "Plan progress toggle missing")

        let expandedLifecycleText = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "Asked 2 questions on iPhone.")).firstMatch
        XCTAssertFalse(expandedLifecycleText.exists, "Lifecycle text should be hidden before expand")

        progressToggle.tap()
        XCTAssertTrue(expandedLifecycleText.waitForExistence(timeout: 5), "Lifecycle text did not appear after expand")
        progressToggle.tap()

        let ignoreButton = app.buttons.matching(identifier: "user-input-ignore").firstMatch
        XCTAssertTrue(ignoreButton.waitForExistence(timeout: 8), "Ignore button missing")
        ignoreButton.tap()

        let restoreButton = app.buttons.matching(identifier: "user-input-restore").firstMatch
        XCTAssertTrue(restoreButton.waitForExistence(timeout: 5), "Restore bar did not appear")
        restoreButton.tap()
        XCTAssertTrue(ignoreButton.waitForExistence(timeout: 5), "User input card did not restore")

        let submitButton = app.buttons.matching(identifier: "user-input-submit").firstMatch
        XCTAssertTrue(submitButton.waitForExistence(timeout: 8), "Submit button missing")
        for _ in 0..<5 where !submitButton.isHittable {
            app.swipeDown()
        }
        XCTAssertTrue(submitButton.isHittable, "Submit button is not hittable")
        submitButton.tap()

        let submittedSummary = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Submitted answers", "已提交")
        ).firstMatch
        XCTAssertTrue(submittedSummary.waitForExistence(timeout: 8), "Submitted summary did not appear")

        XCTAssertFalse(app.buttons.matching(identifier: "user-input-ignore").firstMatch.exists, "Ignore button should disappear after submit")
        XCTAssertFalse(app.buttons.matching(identifier: "user-input-restore").firstMatch.exists, "Restore button should disappear after submit")
    }

}
