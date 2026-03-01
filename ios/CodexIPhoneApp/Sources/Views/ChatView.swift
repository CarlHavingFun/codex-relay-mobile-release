import PhotosUI
import SwiftUI
import UIKit

struct ChatView: View {
    @EnvironmentObject private var store: RelayStore
    let threadID: String

    @State private var draft: String = ""
    @State private var modelDraft: String = ""
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var pendingImage: PendingImageAttachment?
    @State private var isPreparingImage = false
    @State private var hasPerformedInitialScroll = false
    @State private var isSessionSettingsPresented = false
    @State private var liveEventPollTask: Task<Void, Never>?
    @State private var scrollViewportMaxY: CGFloat = .zero
    @State private var scrollBottomMaxY: CGFloat = .zero
    @State private var isPinnedToBottom = true
    @State private var copiedMessageID: String?
    @State private var initialBottomSnapTask: Task<Void, Never>?
    @State private var expandedLogMessageIDs: Set<String> = []
    @State private var userInputSelections: [String: String] = [:]
    @State private var userInputTextValues: [String: String] = [:]
    @State private var isInitialThreadLoadPending = false
    @State private var isSubmittingUserInput = false
    @State private var activeUserInputRequestID: String?
    @State private var isLoadingMoreHistory = false
    @State private var isPlanProgressExpanded = false
    @State private var ignoredUserInputRequestIDs: Set<String> = []
    @FocusState private var inputFocused: Bool

    private var transcript: [ChatTranscriptMessage] {
        store.transcript(for: threadID)
    }

    private var isPlanMode: Bool {
        store.chatMode(for: threadID) == "plan"
    }

    private var visibleTranscript: [ChatTranscriptMessage] {
        guard isPlanMode, store.showThinkingMessages, !isPlanProgressExpanded else {
            return transcript
        }
        return transcript.filter { message in
            switch message.role {
            case "thinking":
                return false
            case "system":
                return isCriticalPlanSystemMessage(message.text)
            default:
                return true
            }
        }
    }

    private var threadTitle: String {
        if let thread = store.threads.first(where: { $0.thread_id == threadID }) {
            return thread.title.isEmpty ? "Chat" : thread.title
        }
        return "Chat"
    }

    private var thread: ChatThread? {
        store.threads.first(where: { $0.thread_id == threadID })
    }

    private var latestJob: ChatJob? {
        store.jobs(for: threadID).first
    }

    private var pendingUserInputRequest: ChatUserInputRequest? {
        store.pendingUserInputRequest(for: threadID)
    }

    private var visiblePendingUserInputRequest: ChatUserInputRequest? {
        guard let request = pendingUserInputRequest else { return nil }
        if ignoredUserInputRequestIDs.contains(request.request_id) {
            return nil
        }
        return request
    }

    private var ignoredPendingUserInputRequest: ChatUserInputRequest? {
        guard let request = pendingUserInputRequest else { return nil }
        if ignoredUserInputRequestIDs.contains(request.request_id) {
            return request
        }
        return nil
    }

    private var runtimeBanner: (text: String, icon: String, color: Color)? {
        let status = (thread?.status ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch status {
        case "queued":
            return ("Queued on desktop connector", "hourglass", .orange)
        case "running", "streaming", "claimed":
            return ("Running on desktop connector", "bolt.fill", .blue)
        case "waiting_on_user_input":
            return ("Waiting for your plan selection", "list.bullet.rectangle", .orange)
        case "interrupted":
            return ("Stopped on desktop", "pause.fill", .orange)
        case "notloaded", "not_loaded", "session_not_loaded", "session_not_found":
            return ("Session not loaded on desktop, syncing...", "arrow.triangle.2.circlepath", .orange)
        case "failed":
            if isSessionNotLoadedJob(latestJob) {
                return ("Session not loaded on desktop, syncing...", "arrow.triangle.2.circlepath", .orange)
            }
            if let message = latestJob?.error_message, !message.isEmpty {
                return ("Failed: \(message)", "exclamationmark.triangle.fill", .red)
            }
            return ("Run failed on desktop", "exclamationmark.triangle.fill", .red)
        case "timeout":
            return ("Timed out on desktop", "clock.badge.exclamationmark", .orange)
        case "deleting":
            return ("Deleting on desktop...", "trash", .orange)
        default:
            if let job = latestJob {
                let jobStatus = job.status.lowercased()
                if jobStatus == "queued" || jobStatus == "claimed" {
                    return ("Queued (\(jobStatus))", "hourglass", .orange)
                }
                if jobStatus == "running" {
                    return ("Running", "bolt.fill", .blue)
                }
                if jobStatus == "interrupted" {
                    return ("Stopped on desktop", "pause.fill", .orange)
                }
                if jobStatus == "timeout" {
                    return ("Timed out on desktop", "clock.badge.exclamationmark", .orange)
                }
                if jobStatus == "failed", isSessionNotLoadedJob(job) {
                    return ("Session not loaded on desktop, syncing...", "arrow.triangle.2.circlepath", .orange)
                }
            }
            return nil
        }
    }

    private func isSessionNotLoadedJob(_ job: ChatJob?) -> Bool {
        guard let job else { return false }
        let code = (job.error_code ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: ".", with: "_")
        if ["session_not_loaded", "session_not_found", "thread_not_found", "thread_not_loaded"].contains(code) {
            return true
        }
        let message = (job.error_message ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return message.contains("session not loaded")
            || message.contains("session_not_loaded")
            || message.contains("session not found")
            || message.contains("session_not_found")
            || message.contains("thread not found")
            || message.contains("thread_not_found")
            || message.contains("no rollout found for thread id")
            || message.contains("no archived rollout found")
            || message.contains("rollout not found")
            || message.contains("missing rollout")
    }

    private var liveProgressText: String? {
        store.threadProgressSummary(threadID: threadID)
    }

    private var planProgressSummaryText: String? {
        guard isPlanMode else { return nil }
        if let request = pendingUserInputRequest {
            let count = request.questions.count
            return count > 0
                ? String(
                    format: t("plan.progress.asking_questions", "Asking %d questions on iPhone."),
                    count
                )
                : t("plan.progress.waiting_answers", "Waiting for your answers on iPhone.")
        }
        if let liveProgressText,
           !liveProgressText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return liveProgressText
        }
        return nil
    }

    private var scrollSpaceName: String {
        "chat-scroll-\(threadID)"
    }

    var body: some View {
        VStack(spacing: 0) {
            if let banner = runtimeBanner {
                runtimeBannerView(text: banner.text, icon: banner.icon, color: banner.color)
            }
            if store.isThreadInFlight(threadID: threadID),
               let progress = liveProgressText,
               !progress.isEmpty,
               progress != runtimeBanner?.text {
                runtimeBannerView(text: progress, icon: "waveform.path.ecg", color: .secondary)
            }
            if let summary = planProgressSummaryText {
                planProgressSummaryBar(summary)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if !transcript.isEmpty {
                            historyWindowControl(proxy: proxy)
                        }
                        ForEach(visibleTranscript) { msg in
                            messageRow(msg)
                            .id(msg.id)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomAnchorID)
                            .background(
                                GeometryReader { geo in
                                    Color.clear.preference(
                                        key: ChatScrollBottomPreferenceKey.self,
                                        value: geo.frame(in: .named(scrollSpaceName)).maxY
                                    )
                                }
                            )
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
                .id("chat-scroll-\(threadID)")
                .coordinateSpace(name: scrollSpaceName)
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: ChatScrollViewportPreferenceKey.self,
                            value: geo.frame(in: .named(scrollSpaceName)).maxY
                        )
                    }
                )
                .onPreferenceChange(ChatScrollViewportPreferenceKey.self) { value in
                    scrollViewportMaxY = value
                    updatePinnedToBottomState()
                }
                .onPreferenceChange(ChatScrollBottomPreferenceKey.self) { value in
                    scrollBottomMaxY = value
                    updatePinnedToBottomState()
                }
                .overlay(alignment: .bottomTrailing) {
                    if !isPinnedToBottom && !visibleTranscript.isEmpty {
                        Button {
                            isPinnedToBottom = true
                            scrollToBottom(proxy, animated: true)
                        } label: {
                            Label("Latest", systemImage: "arrow.down.circle.fill")
                                .labelStyle(.iconOnly)
                                .font(.title3)
                                .foregroundStyle(.white)
                                .padding(10)
                                .background(Color.black.opacity(0.75), in: Circle())
                        }
                        .padding(.trailing, 12)
                        .padding(.bottom, 10)
                    }
                }
                .scrollDismissesKeyboard(.interactively)
                .contentShape(Rectangle())
                .onTapGesture {
                    inputFocused = false
                }
                .overlay {
                    if visibleTranscript.isEmpty {
                        VStack(spacing: 8) {
                            if emptyStateShowsLoading {
                                ProgressView()
                            }
                            Text(emptyStateShowsLoading ? "Loading session…" : "No messages yet")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .onChange(of: visibleTranscript.last?.id) { _, newID in
                    guard newID != nil else { return }
                    if !hasPerformedInitialScroll {
                        scheduleInitialBottomSnap(proxy)
                        return
                    }
                    if isPinnedToBottom {
                        scrollToBottom(proxy, animated: true)
                    }
                }
                .task(id: threadID) {
                    store.selectedThreadID = threadID
                    draft = store.threadDraft(for: threadID)
                    modelDraft = store.chatModel(for: threadID)
                    hasPerformedInitialScroll = false
                    isPinnedToBottom = true
                    scrollViewportMaxY = .zero
                    scrollBottomMaxY = .zero
                    expandedLogMessageIDs.removeAll()
                    userInputSelections.removeAll()
                    userInputTextValues.removeAll()
                    activeUserInputRequestID = nil
                    isSubmittingUserInput = false
                    isLoadingMoreHistory = false
                    ignoredUserInputRequestIDs.removeAll()
                    isPlanProgressExpanded = !store.planProgressDefaultCollapsed
                    scheduleInitialBottomSnap(proxy)
                    isInitialThreadLoadPending = true
                    await refreshThreadWithSessionWarmup()
                    isInitialThreadLoadPending = false
                    syncUserInputDraftState()
                    scheduleInitialBottomSnap(proxy)
                    startLiveEventPolling()
                }
                .refreshable {
                    let wasPinned = isPinnedToBottom
                    isInitialThreadLoadPending = true
                    await refreshThreadWithSessionWarmup()
                    isInitialThreadLoadPending = false
                    if wasPinned || !hasPerformedInitialScroll {
                        scrollToBottom(proxy, animated: false)
                    }
                }
            }
            .layoutPriority(1)

            Divider()

            VStack(spacing: 8) {
                if let request = visiblePendingUserInputRequest {
                    userInputRequestCard(request)
                }
                if let request = ignoredPendingUserInputRequest {
                    ignoredUserInputRestoreBar(request)
                }

                if let pendingImage {
                    pendingImageRow(pendingImage)
                }

                if store.chatMode(for: threadID) == "plan" {
                    HStack {
                        Button {
                            sendPlanImplementationMessage()
                        } label: {
                            Label("实施计划", systemImage: "play.fill")
                                .font(.subheadline.weight(.semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color(.secondarySystemFill), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(store.isSendingMessage || isPreparingImage)
                        Spacer()
                    }
                }

                HStack(spacing: 8) {
                    PhotosPicker(
                        selection: $selectedPhotoItem,
                        matching: .images,
                        preferredItemEncoding: .automatic
                    ) {
                        Image(systemName: "plus")
                            .font(.title3.weight(.medium))
                    }
                    .disabled(store.isSendingMessage || isPreparingImage)

                    TextField("Message", text: $draft, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...5)
                        .focused($inputFocused)
                        .accessibilityIdentifier("chat-input-message")

                    Button {
                        let text = draft
                        let imageItems = pendingImage.map {
                            ChatInputItem(type: "image", text: nil, url: $0.dataURL, path: nil, name: nil)
                        }.map { [$0] } ?? []
                        draft = ""
                        store.setThreadDraft("", threadID: threadID)
                        inputFocused = false
                        pendingImage = nil
                        selectedPhotoItem = nil
                        sendMessageToThread(text: text, inputItems: imageItems)
                    } label: {
                        Group {
                            if store.isSendingMessage || isPreparingImage {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.headline.weight(.semibold))
                            }
                        }
                        .frame(width: 36, height: 36)
                        .foregroundStyle(.white)
                        .background(Color.black, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isSendDisabled)
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        Menu {
                            ForEach(Self.modelPresets, id: \.self) { model in
                                Button {
                                    modelDraft = model
                                    store.setThreadChatModel(model, threadID: threadID)
                                } label: {
                                    if store.chatModel(for: threadID) == model {
                                        Label(model, systemImage: "checkmark")
                                    } else {
                                        Text(model)
                                    }
                                }
                            }
                            Divider()
                            Button("Session Settings…") {
                                modelDraft = store.chatModel(for: threadID)
                                isSessionSettingsPresented = true
                            }
                        } label: {
                            optionPill(text: shortModelName(store.chatModel(for: threadID)))
                        }
                        .buttonStyle(.plain)

                        Menu {
                            ForEach(Self.effortOptions, id: \.self) { effort in
                                Button {
                                    store.setThreadChatReasoningEffort(effort, threadID: threadID)
                                } label: {
                                    if store.chatReasoningEffort(for: threadID) == effort {
                                        Label(effortDisplayName(effort), systemImage: "checkmark")
                                    } else {
                                        Text(effortDisplayName(effort))
                                    }
                                }
                            }
                        } label: {
                            optionPill(text: effortDisplayName(store.chatReasoningEffort(for: threadID)))
                        }
                        .buttonStyle(.plain)

                        Menu {
                            Button {
                                store.setThreadChatMode("default", threadID: threadID)
                            } label: {
                                if store.chatMode(for: threadID) == "default" {
                                    Label("Default", systemImage: "checkmark")
                                } else {
                                    Text("Default")
                                }
                            }
                            Button {
                                store.setThreadChatMode("plan", threadID: threadID)
                            } label: {
                                if store.chatMode(for: threadID) == "plan" {
                                    Label("Plan", systemImage: "checkmark")
                                } else {
                                    Text("Plan")
                                }
                            }
                        } label: {
                            optionPill(text: store.chatMode(for: threadID).uppercased())
                        }
                        .buttonStyle(.plain)
                    }
                }

                HStack(spacing: 10) {
                    Text("Local")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.primary)
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.shield")
                            .font(.caption2.weight(.semibold))
                        Text("Full access")
                            .font(.caption.weight(.medium))
                    }
                    .foregroundStyle(.orange)
                    Spacer()
                }
            }
            .padding()
            .background(.thinMaterial)
        }
        .navigationTitle(threadTitle)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    modelDraft = store.chatModel(for: threadID)
                    isSessionSettingsPresented = true
                } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(store.chatMode(for: threadID).uppercased()) · \(store.chatReasoningEffort(for: threadID))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(shortModelName(store.chatModel(for: threadID)))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
            }
            ToolbarItem(placement: .topBarTrailing) {
                if store.isThreadInFlight(threadID: threadID) {
                    Button {
                        Task {
                            await store.interruptThread(threadID: threadID)
                            await store.refreshThread(threadID: threadID)
                        }
                    } label: {
                        if store.isInterruptingThread(threadID: threadID) {
                            ProgressView()
                        } else {
                            Image(systemName: "stop.circle.fill")
                                .foregroundStyle(.red)
                        }
                    }
                    .disabled(store.isInterruptingThread(threadID: threadID))
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh") {
                    Task {
                        isInitialThreadLoadPending = true
                        await refreshThreadWithSessionWarmup()
                        isInitialThreadLoadPending = false
                    }
                }
            }
        }
        .sheet(isPresented: $isSessionSettingsPresented) {
            sessionSettingsSheet
        }
        .onDisappear {
            store.setThreadDraft(draft, threadID: threadID)
            initialBottomSnapTask?.cancel()
            initialBottomSnapTask = nil
            stopLiveEventPolling()
        }
        .onChange(of: draft) { _, next in
            store.setThreadDraft(next, threadID: threadID)
        }
        .onChange(of: selectedPhotoItem) { _, newItem in
            guard let item = newItem else { return }
            Task { await loadPhotoPickerItem(item) }
        }
        .onChange(of: pendingUserInputRequest?.request_id) { _, _ in
            syncUserInputDraftState()
            if let pendingUserInputRequest {
                ignoredUserInputRequestIDs = ignoredUserInputRequestIDs.filter { $0 == pendingUserInputRequest.request_id }
            } else {
                ignoredUserInputRequestIDs.removeAll()
            }
        }
        .onChange(of: store.chatMode(for: threadID)) { _, mode in
            guard mode == "plan" else { return }
            isPlanProgressExpanded = !store.planProgressDefaultCollapsed
        }
    }

    @ViewBuilder
    private func messageRow(_ msg: ChatTranscriptMessage) -> some View {
        let copyText = copyableMessageText(for: msg)
        let textWindow = messageTextWindow(for: msg)
        HStack(alignment: .bottom) {
            if msg.role == "user" { Spacer(minLength: 40) }
            VStack(alignment: msg.role == "user" ? .trailing : .leading, spacing: 4) {
                if let label = roleLabel(for: msg.role) {
                    Text(label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if !textWindow.text.isEmpty {
                    if let segments = parseProposedPlanSegments(in: textWindow.text), !segments.isEmpty {
                        messageTextSegmentsView(segments: segments, role: msg.role)
                    } else {
                        Text(textWindow.text)
                            .textSelection(.enabled)
                            .padding(10)
                            .background(backgroundColor(role: msg.role), in: RoundedRectangle(cornerRadius: 10))
                            .foregroundStyle(foregroundColor(role: msg.role))
                    }
                }
                if textWindow.isLogMessage {
                    HStack(spacing: 8) {
                        Text(
                            textWindow.isWindowed
                            ? "Latest window: \(textWindow.shownCount)/\(textWindow.totalCount) chars"
                            : "Full log: \(textWindow.totalCount) chars"
                        )
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        Button(textWindow.isWindowed ? "Expand" : "Show Latest") {
                            if textWindow.isWindowed {
                                expandedLogMessageIDs.insert(msg.id)
                            } else {
                                expandedLogMessageIDs.remove(msg.id)
                            }
                        }
                        .font(.caption2.weight(.semibold))
                        .buttonStyle(.plain)
                    }
                }
                if !msg.attachments.isEmpty {
                    ForEach(msg.attachments) { attachment in
                        transcriptAttachmentView(attachment, role: msg.role)
                    }
                }
                if let timeText = interactionTime(from: msg.ts) {
                    Text(timeText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if msg.role != "user", !copyText.isEmpty {
                    Button {
                        UIPasteboard.general.string = copyText
                        copiedMessageID = msg.id
                        Task {
                            try? await Task.sleep(nanoseconds: 1_200_000_000)
                            if copiedMessageID == msg.id {
                                copiedMessageID = nil
                            }
                        }
                    } label: {
                        Label(
                            copiedMessageID == msg.id ? "Copied" : "Copy",
                            systemImage: copiedMessageID == msg.id ? "checkmark.circle.fill" : "doc.on.doc"
                        )
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .foregroundStyle(.secondary)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .contextMenu {
                if !copyText.isEmpty {
                    Button("Copy") {
                        UIPasteboard.general.string = copyText
                    }
                }
            }
            if msg.role != "user" { Spacer(minLength: 40) }
        }
    }

    private func isCriticalPlanSystemMessage(_ text: String) -> Bool {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return false }
        return normalized.contains("failed")
            || normalized.contains("error")
            || normalized.contains("timed out")
            || normalized.contains("timeout")
            || normalized.contains("stopped")
            || normalized.contains("interrupted")
            || normalized.contains("session not loaded")
    }

    @ViewBuilder
    private func messageTextSegmentsView(segments: [MessageTextSegment], role: String) -> some View {
        VStack(alignment: role == "user" ? .trailing : .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let text):
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        Text(trimmed)
                            .textSelection(.enabled)
                            .padding(10)
                            .background(backgroundColor(role: role), in: RoundedRectangle(cornerRadius: 10))
                            .foregroundStyle(foregroundColor(role: role))
                    }
                case .proposedPlan(let markdownBody):
                    proposedPlanCard(markdownBody)
                }
            }
        }
    }

    @ViewBuilder
    private func proposedPlanCard(_ markdownBody: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "list.bullet.clipboard")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.blue)
                Text(t("plan.proposed_plan.title", "Implementation Plan"))
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("proposed-plan-card")
                Spacer()
            }
            if let markdown = try? AttributedString(markdown: markdownBody) {
                Text(markdown)
                    .textSelection(.enabled)
            } else {
                Text(markdownBody)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.blue.opacity(0.25), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    private func parseProposedPlanSegments(in text: String) -> [MessageTextSegment]? {
        let startTag = "<proposed_plan>"
        let endTag = "</proposed_plan>"
        guard text.contains(startTag) else { return nil }
        guard text.contains(endTag) else { return nil }

        var segments: [MessageTextSegment] = []
        var cursor = text.startIndex
        while cursor < text.endIndex {
            guard let startRange = text.range(of: startTag, range: cursor..<text.endIndex) else {
                let tail = String(text[cursor...])
                if !tail.isEmpty {
                    segments.append(.text(tail))
                }
                break
            }

            if startRange.lowerBound > cursor {
                let plain = String(text[cursor..<startRange.lowerBound])
                if !plain.isEmpty {
                    segments.append(.text(plain))
                }
            }

            guard let endRange = text.range(of: endTag, range: startRange.upperBound..<text.endIndex) else {
                return nil
            }

            let body = String(text[startRange.upperBound..<endRange.lowerBound])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty {
                segments.append(.proposedPlan(body))
            }

            cursor = endRange.upperBound
        }

        return segments
    }

    @ViewBuilder
    private func transcriptAttachmentView(_ attachment: ChatTranscriptAttachment, role: String) -> some View {
        let normalizedType = attachment.type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalizedType == "image" || normalizedType == "localimage" {
            if let imageData = inlineImageData(from: attachment),
               let uiImage = UIImage(data: imageData) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 260, maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(Color.black.opacity(0.08), lineWidth: 1)
                    )
            } else if let rawURL = attachment.url,
                      !rawURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !rawURL.lowercased().hasPrefix("data:"),
                      let url = URL(string: rawURL) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                    case .failure:
                        attachmentFallbackPill("Image unavailable", role: role)
                    default:
                        ProgressView()
                    }
                }
                .frame(maxWidth: 260, maxHeight: 260)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if let path = attachment.path,
                      !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                attachmentFallbackPill("Desktop image: \(URL(fileURLWithPath: path).lastPathComponent)", role: role)
            } else {
                attachmentFallbackPill("Image unavailable", role: role)
            }
        } else {
            attachmentFallbackPill("Attachment unavailable", role: role)
        }
    }

    @ViewBuilder
    private func attachmentFallbackPill(_ text: String, role: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                (role == "user" ? Color.blue.opacity(0.14) : Color(.tertiarySystemFill)),
                in: RoundedRectangle(cornerRadius: 10)
            )
    }

    private func inlineImageData(from attachment: ChatTranscriptAttachment) -> Data? {
        guard let url = attachment.url?.trimmingCharacters(in: .whitespacesAndNewlines),
              url.lowercased().hasPrefix("data:image") else {
            return nil
        }
        guard let comma = url.firstIndex(of: ",") else { return nil }
        let encoded = String(url[url.index(after: comma)...])
        return Data(base64Encoded: encoded)
    }

    @ViewBuilder
    private func pendingImageRow(_ image: PendingImageAttachment) -> some View {
        HStack(spacing: 10) {
            if let uiImage = UIImage(data: image.previewData) {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Image attached")
                    .font(.subheadline.weight(.medium))
                Text(Self.byteFormatter.string(fromByteCount: Int64(image.bytes)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                pendingImage = nil
                selectedPhotoItem = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(8)
        .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 10))
    }

    private func copyableMessageText(for msg: ChatTranscriptMessage) -> String {
        var parts: [String] = []
        let text = msg.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            parts.append(text)
        }
        for attachment in msg.attachments {
            let url = (attachment.url ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !url.isEmpty {
                parts.append(url)
                continue
            }
            let path = (attachment.path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !path.isEmpty {
                parts.append(path)
            }
        }
        return parts.joined(separator: "\n")
    }

    private func isLogWindowRole(_ role: String) -> Bool {
        role == "thinking" || role == "system"
    }

    private func messageTextWindow(for msg: ChatTranscriptMessage) -> MessageTextWindow {
        let fullText = msg.text
        let totalCount = fullText.count
        let isLogMessage = isLogWindowRole(msg.role) && totalCount > Self.logWindowCharacterLimit
        guard isLogMessage else {
            return MessageTextWindow(
                text: fullText,
                shownCount: totalCount,
                totalCount: totalCount,
                isWindowed: false,
                isLogMessage: false
            )
        }
        if expandedLogMessageIDs.contains(msg.id) {
            return MessageTextWindow(
                text: fullText,
                shownCount: totalCount,
                totalCount: totalCount,
                isWindowed: false,
                isLogMessage: true
            )
        }
        let tail = String(fullText.suffix(Self.logWindowCharacterLimit))
        return MessageTextWindow(
            text: tail,
            shownCount: tail.count,
            totalCount: totalCount,
            isWindowed: true,
            isLogMessage: true
        )
    }

    private func updatePinnedToBottomState() {
        guard scrollViewportMaxY > 0, scrollBottomMaxY > 0 else { return }
        let distance = scrollBottomMaxY - scrollViewportMaxY
        let nearBottom = distance <= 36
        if nearBottom != isPinnedToBottom {
            isPinnedToBottom = nearBottom
        }
    }

    private func scheduleInitialBottomSnap(_ proxy: ScrollViewProxy) {
        hasPerformedInitialScroll = true
        isPinnedToBottom = true
        scrollToBottom(proxy, animated: false)
        initialBottomSnapTask?.cancel()
        initialBottomSnapTask = Task { @MainActor in
            let delays: [UInt64] = [120_000_000, 350_000_000, 800_000_000]
            for delay in delays {
                try? await Task.sleep(nanoseconds: delay)
                if Task.isCancelled { return }
                isPinnedToBottom = true
                scrollToBottom(proxy, animated: false)
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let action = {
            proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
        }
        if animated {
            withAnimation {
                action()
            }
        } else {
            action()
        }
    }

    private func startLiveEventPolling() {
        stopLiveEventPolling()
        liveEventPollTask = Task {
            var tick = 0
            while !Task.isCancelled {
                await store.refreshThreadEventsSilently(threadID: threadID)
                tick += 1
                let normalizedStatus = (thread?.status ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                let waitingOnUserInput = normalizedStatus == "waiting_on_user_input"
                let needsSessionSync = [
                    "notloaded",
                    "not_loaded",
                    "session_not_loaded",
                    "session_not_found",
                ].contains(normalizedStatus)
                let waitingForInitialMessages = transcript.isEmpty && store.isSessionBackedThread(threadID: threadID)
                if (needsSessionSync && tick % 8 == 0) || (waitingForInitialMessages && tick % 3 == 0) {
                    await store.requestSessionSyncIfNeeded(threadID: threadID)
                }
                if waitingOnUserInput || waitingForInitialMessages || (needsSessionSync && tick % 2 == 0) || tick % 4 == 0 {
                    await store.refreshThread(threadID: threadID)
                }
                let isActive = store.isThreadInFlight(threadID: threadID)
                let sleepNs: UInt64
                if waitingForInitialMessages {
                    sleepNs = 550_000_000
                } else {
                    sleepNs = isActive ? 450_000_000 : 1_200_000_000
                }
                try? await Task.sleep(nanoseconds: sleepNs)
            }
        }
    }

    private var emptyStateShowsLoading: Bool {
        if isInitialThreadLoadPending { return true }
        return store.isThreadInFlight(threadID: threadID)
    }

    private func refreshThreadWithSessionWarmup() async {
        await store.refreshThread(threadID: threadID)
        guard store.isSessionBackedThread(threadID: threadID) else { return }

        let didRequestSync = await store.requestSessionSyncIfNeeded(threadID: threadID)
        var shouldRetry = didRequestSync
        if !shouldRetry {
            shouldRetry = store.transcript(for: threadID).isEmpty
        }
        guard shouldRetry else { return }

        let delays: [UInt64] = [350_000_000, 900_000_000]
        for delay in delays {
            try? await Task.sleep(nanoseconds: delay)
            if Task.isCancelled { return }
            await store.refreshThread(threadID: threadID)
            if !store.transcript(for: threadID).isEmpty {
                return
            }
        }
    }

    private func stopLiveEventPolling() {
        liveEventPollTask?.cancel()
        liveEventPollTask = nil
    }

    private func interactionTime(from raw: String?) -> String? {
        let value = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        guard let date = Self.iso8601Fractional.date(from: value) ?? Self.iso8601.date(from: value) else {
            return value
        }
        if Calendar.current.isDateInToday(date) {
            let relative = Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
            return "\(relative) · \(Self.timeFormatter.string(from: date))"
        }
        let relative = Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
        return "\(relative) · \(Self.dateTimeFormatter.string(from: date))"
    }

    private func backgroundColor(role: String) -> Color {
        switch role {
        case "user": return .blue
        case "thinking": return Color(.tertiarySystemFill)
        case "system": return Color.orange.opacity(0.18)
        case "assistant": return Color(.secondarySystemFill)
        default: return Color.orange.opacity(0.2)
        }
    }

    private func foregroundColor(role: String) -> Color {
        switch role {
        case "user": return .white
        case "thinking": return .secondary
        default: return .primary
        }
    }

    private func roleLabel(for role: String) -> String? {
        switch role {
        case "thinking": return "Thinking"
        case "system": return "Status"
        default: return nil
        }
    }

    @ViewBuilder
    private func runtimeBannerView(text: String, icon: String, color: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.caption.weight(.semibold))
            Text(text)
                .font(.caption)
                .lineLimit(2)
            Spacer()
        }
        .foregroundStyle(color)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(color.opacity(0.08))
    }

    @ViewBuilder
    private func planProgressSummaryBar(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "list.bullet.rectangle")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
            Text(text)
                .font(.caption)
                .lineLimit(2)
            Spacer(minLength: 8)
            if store.showThinkingMessages {
                Button {
                    isPlanProgressExpanded.toggle()
                } label: {
                    Text(
                        isPlanProgressExpanded
                        ? t("plan.progress.collapse_details", "Collapse details")
                        : t("plan.progress.expand_details", "Expand details")
                    )
                    .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("plan-progress-toggle")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.08))
    }

    @ViewBuilder
    private func historyWindowControl(proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 8) {
            Text(store.historyWindowLabel(threadID: threadID))
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer()
            if store.canLoadMoreHistory(threadID: threadID) {
                Button {
                    guard !isLoadingMoreHistory else { return }
                    let shouldKeepBottom = isPinnedToBottom
                    isLoadingMoreHistory = true
                    Task { @MainActor in
                        let loaded = await store.loadMoreHistory(threadID: threadID)
                        isLoadingMoreHistory = false
                        if loaded && shouldKeepBottom {
                            scrollToBottom(proxy, animated: false)
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        if isLoadingMoreHistory {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "clock.arrow.trianglehead.counterclockwise.rotate.90")
                        }
                        Text(isLoadingMoreHistory ? "Loading…" : "Load older")
                    }
                    .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .disabled(isLoadingMoreHistory)
            }
        }
        .padding(.horizontal, 2)
    }

    @ViewBuilder
    private func userInputRequestCard(_ request: ChatUserInputRequest) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "list.bullet.rectangle")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                Text(t("plan.user_input.title", "Plan selection required"))
                    .font(.subheadline.weight(.semibold))
                Spacer()
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(request.questions.enumerated()), id: \.element.id) { index, question in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("\(index + 1).")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text(question.header)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                            Text(question.question)
                                .font(.subheadline)
                            userInputQuestionInput(question)
                        }
                        .padding(.top, 2)
                    }
                }
            }
            .frame(maxHeight: 260)

            HStack(spacing: 10) {
                Button {
                    ignoreUserInputRequest(request)
                } label: {
                    Text(t("plan.user_input.ignore", "Ignore"))
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .foregroundStyle(.primary)
                        .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .disabled(isSubmittingUserInput)
                .accessibilityIdentifier("user-input-ignore")

                Button {
                    submitUserInputRequest(request)
                } label: {
                    HStack {
                        if isSubmittingUserInput {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Image(systemName: "paperplane.fill")
                        }
                        Text(
                            isSubmittingUserInput
                            ? t("plan.user_input.submitting", "Submitting...")
                            : t("plan.user_input.submit", "Submit")
                        )
                        .font(.subheadline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .foregroundStyle(.white)
                    .background(Color.black, in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .disabled(isSubmittingUserInput || !isUserInputSubmissionReady(request))
                .accessibilityIdentifier("user-input-submit")
            }
        }
        .padding(10)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func ignoredUserInputRestoreBar(_ request: ChatUserInputRequest) -> some View {
        HStack(spacing: 8) {
            Text(
                String(
                    format: t("plan.user_input.pending_compact", "Pending questions (%d)"),
                    request.questions.count
                )
            )
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            Spacer()
            Button {
                restoreUserInputRequest(request)
            } label: {
                Text(t("plan.user_input.restore", "Restore"))
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("user-input-restore")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func userInputQuestionInput(_ question: ChatUserInputQuestion) -> some View {
        let options = question.options ?? []
        if !options.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                    let optionMeta = userInputOptionMetadata(option)
                    let isSelected = (userInputSelections[question.id] ?? "") == option.label
                        && (userInputTextValues[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    Button {
                        userInputSelections[question.id] = option.label
                        userInputTextValues[question.id] = ""
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(isSelected ? .blue : .secondary)
                                Text("\(index + 1).")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text(optionMeta.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                if optionMeta.isRecommended {
                                    Text(t("plan.user_input.recommended", "Recommended"))
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .foregroundStyle(.orange)
                                        .background(Color.orange.opacity(0.15), in: Capsule())
                                }
                                Spacer()
                            }
                            Text(option.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.leading, 34)
                        }
                        .padding(8)
                        .background(
                            optionRowBackground(isSelected: isSelected, isRecommended: optionMeta.isRecommended),
                            in: RoundedRectangle(cornerRadius: 10)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }

        let shouldShowTextInput = question.isOther == true || options.isEmpty
        if shouldShowTextInput {
            let placeholder = question.isOther == true
                ? t("plan.user_input.other_placeholder", "Other...")
                : t("plan.user_input.answer_placeholder", "Type your answer...")
            let textBinding = Binding<String>(
                get: { userInputTextValues[question.id] ?? "" },
                set: { newValue in
                    userInputTextValues[question.id] = newValue
                }
            )
            if question.isSecret == true {
                SecureField(placeholder, text: textBinding)
                    .textFieldStyle(.roundedBorder)
            } else {
                TextField(placeholder, text: textBinding, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...3)
            }
        }
    }

    private func userInputAnswerText(for question: ChatUserInputQuestion) -> String {
        let freeText = (userInputTextValues[question.id] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !freeText.isEmpty {
            return freeText
        }
        return (userInputSelections[question.id] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func isUserInputSubmissionReady(_ request: ChatUserInputRequest) -> Bool {
        request.questions.allSatisfy { !userInputAnswerText(for: $0).isEmpty }
    }

    private func buildUserInputAnswers(_ request: ChatUserInputRequest) -> [String: ChatUserInputAnswerPayload] {
        var out: [String: ChatUserInputAnswerPayload] = [:]
        for question in request.questions {
            let answer = userInputAnswerText(for: question)
            guard !answer.isEmpty else { continue }
            out[question.id] = ChatUserInputAnswerPayload(answers: [answer])
        }
        return out
    }

    private func submitUserInputRequest(_ request: ChatUserInputRequest) {
        let answers = buildUserInputAnswers(request)
        guard !answers.isEmpty else { return }
        isSubmittingUserInput = true
        inputFocused = false
        Task { @MainActor in
            let submitted = await store.submitUserInputRequest(
                threadID: threadID,
                requestID: request.request_id,
                answers: answers
            )
            isSubmittingUserInput = false
            if submitted {
                userInputSelections.removeAll()
                userInputTextValues.removeAll()
                activeUserInputRequestID = nil
                ignoredUserInputRequestIDs.removeAll()
            }
        }
    }

    private func ignoreUserInputRequest(_ request: ChatUserInputRequest) {
        ignoredUserInputRequestIDs.insert(request.request_id)
    }

    private func restoreUserInputRequest(_ request: ChatUserInputRequest) {
        ignoredUserInputRequestIDs.remove(request.request_id)
    }

    private func userInputOptionMetadata(_ option: ChatUserInputOption) -> UserInputOptionMetadata {
        let raw = option.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowered = raw.lowercased()
        let isRecommended = lowered.contains("(recommended)") || raw.contains("（推荐）")
        let title = raw
            .replacingOccurrences(of: "(Recommended)", with: "", options: [.caseInsensitive])
            .replacingOccurrences(of: "（推荐）", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return UserInputOptionMetadata(
            title: title.isEmpty ? raw : title,
            isRecommended: isRecommended
        )
    }

    private func optionRowBackground(isSelected: Bool, isRecommended: Bool) -> Color {
        if isSelected {
            return Color.blue.opacity(0.12)
        }
        if isRecommended {
            return Color.orange.opacity(0.10)
        }
        return Color(.secondarySystemFill)
    }

    private func syncUserInputDraftState() {
        guard let request = pendingUserInputRequest else {
            activeUserInputRequestID = nil
            userInputSelections.removeAll()
            userInputTextValues.removeAll()
            return
        }
        guard request.request_id != activeUserInputRequestID else { return }

        activeUserInputRequestID = request.request_id
        userInputSelections.removeAll()
        userInputTextValues.removeAll()

        if let existingAnswers = request.answers {
            for question in request.questions {
                let answer = existingAnswers[question.id]?.answers.first?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !answer.isEmpty else { continue }
                let hasMatchingOption = (question.options ?? []).contains(where: { $0.label == answer })
                if hasMatchingOption {
                    userInputSelections[question.id] = answer
                } else {
                    userInputTextValues[question.id] = answer
                }
            }
        }
    }

    private var isSendDisabled: Bool {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed.isEmpty && pendingImage == nil) || store.isSendingMessage || isPreparingImage
    }

    private func sendPlanImplementationMessage() {
        sendMessageToThread(
            text: "请按上面的计划直接开始实施，修改代码并运行必要验证，然后汇报结果。"
        )
    }

    private func sendMessageToThread(text: String, inputItems: [ChatInputItem] = []) {
        isPinnedToBottom = true
        Task {
            await store.sendMessage(
                threadID: threadID,
                text: text,
                inputItems: inputItems
            )
            await store.refreshThread(threadID: threadID)
        }
    }

    private var sessionSettingsSheet: some View {
        NavigationStack {
            Form {
                Section("Mode") {
                    Picker("Mode", selection: Binding(
                        get: { store.chatMode(for: threadID) },
                        set: { store.setThreadChatMode($0, threadID: threadID) }
                    )) {
                        Text("Default").tag("default")
                        Text("Plan").tag("plan")
                    }
                    .pickerStyle(.segmented)
                }

                Section("Model") {
                    TextField("Model", text: $modelDraft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Apply Model") {
                        store.setThreadChatModel(modelDraft, threadID: threadID)
                    }
                    .disabled(modelDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    ForEach(Self.modelPresets, id: \.self) { model in
                        Button {
                            modelDraft = model
                            store.setThreadChatModel(model, threadID: threadID)
                        } label: {
                            HStack {
                                Text(model)
                                Spacer()
                                if store.chatModel(for: threadID) == model {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section("Reasoning") {
                    Picker("Effort", selection: Binding(
                        get: { store.chatReasoningEffort(for: threadID) },
                        set: { store.setThreadChatReasoningEffort($0, threadID: threadID) }
                    )) {
                        Text("xhigh").tag("xhigh")
                        Text("high").tag("high")
                        Text("medium").tag("medium")
                        Text("low").tag("low")
                        Text("minimal").tag("minimal")
                        Text("none").tag("none")
                    }
                }
            }
            .navigationTitle("Session Settings")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { isSessionSettingsPresented = false }
                }
            }
        }
    }

    private func loadPhotoPickerItem(_ item: PhotosPickerItem) async {
        isPreparingImage = true
        defer { isPreparingImage = false }
        do {
            guard let rawData = try await item.loadTransferable(type: Data.self) else {
                return
            }
            guard let attachment = buildImageAttachment(from: rawData) else {
                store.errorMessage = "image preprocessing failed"
                return
            }
            pendingImage = attachment
            store.errorMessage = nil
        } catch {
            store.errorMessage = error.localizedDescription
        }
    }

    private func buildImageAttachment(from data: Data) -> PendingImageAttachment? {
        guard let image = UIImage(data: data) else { return nil }
        let resized = resizeImageIfNeeded(image, maxDimension: 1400)
        guard let jpegData = resized.jpegData(compressionQuality: 0.72) else { return nil }
        let dataURL = "data:image/jpeg;base64,\(jpegData.base64EncodedString())"
        return PendingImageAttachment(
            dataURL: dataURL,
            previewData: jpegData,
            bytes: jpegData.count
        )
    }

    private func resizeImageIfNeeded(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let size = image.size
        let largest = max(size.width, size.height)
        guard largest > maxDimension, largest > 0 else { return image }
        let scale = maxDimension / largest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    private func shortModelName(_ model: String) -> String {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Model" }
        if trimmed.count <= 22 { return trimmed }
        return "\(trimmed.prefix(22))…"
    }

    private func effortDisplayName(_ effort: String) -> String {
        let value = effort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch value {
        case "xhigh":
            return "Extra High"
        case "high":
            return "High"
        case "medium":
            return "Medium"
        case "low":
            return "Low"
        case "minimal":
            return "Minimal"
        case "none":
            return "None"
        default:
            return value.isEmpty ? "Reasoning" : value
        }
    }

    @ViewBuilder
    private func optionPill(text: String) -> some View {
        HStack(spacing: 4) {
            Text(text)
                .font(.subheadline)
                .lineLimit(1)
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.semibold))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(.secondarySystemFill), in: Capsule())
    }

    private func t(_ key: String, _ fallback: String) -> String {
        NSLocalizedString(key, tableName: nil, bundle: .main, value: fallback, comment: "")
    }

    private struct PendingImageAttachment: Identifiable {
        let id = UUID()
        let dataURL: String
        let previewData: Data
        let bytes: Int
    }

    private enum MessageTextSegment {
        case text(String)
        case proposedPlan(String)
    }

    private struct UserInputOptionMetadata {
        let title: String
        let isRecommended: Bool
    }

    private struct MessageTextWindow {
        let text: String
        let shownCount: Int
        let totalCount: Int
        let isWindowed: Bool
        let isLogMessage: Bool
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

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
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

    private static let byteFormatter: ByteCountFormatter = {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB]
        formatter.countStyle = .file
        return formatter
    }()

    private static let bottomAnchorID = "chat-bottom-anchor"
    private static let logWindowCharacterLimit = 12000

    private static let modelPresets: [String] = [
        "gpt-5.3-codex",
        "gpt-5-codex",
        "gpt-4.1",
        "o4-mini",
    ]

    private static let effortOptions: [String] = [
        "xhigh",
        "high",
        "medium",
        "low",
        "minimal",
        "none",
    ]
}

private struct ChatScrollViewportPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = .zero

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct ChatScrollBottomPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = .zero

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
