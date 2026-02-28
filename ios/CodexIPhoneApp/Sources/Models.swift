import Foundation

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
            return
        }
        if let value = try? container.decode(Double.self) {
            self = .number(value)
            return
        }
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
            return
        }
        if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Unsupported JSON value"
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }
}

struct RelayAccountProfile: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var base_url: String
    var workspace: String
    var write_workspace: String
    var updated_at: String
    var token_ref: String
    var legacy_token: String?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case base_url
        case workspace
        case write_workspace
        case updated_at
        case token_ref
        case token
    }

    init(
        id: String,
        name: String,
        base_url: String,
        workspace: String,
        write_workspace: String,
        updated_at: String,
        token_ref: String,
        legacy_token: String? = nil
    ) {
        self.id = id
        self.name = name
        self.base_url = base_url
        self.workspace = workspace
        self.write_workspace = write_workspace
        self.updated_at = updated_at
        self.token_ref = token_ref
        self.legacy_token = legacy_token
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        base_url = try c.decode(String.self, forKey: .base_url)
        workspace = try c.decode(String.self, forKey: .workspace)
        write_workspace = try c.decode(String.self, forKey: .write_workspace)
        updated_at = try c.decode(String.self, forKey: .updated_at)
        token_ref = try c.decodeIfPresent(String.self, forKey: .token_ref) ?? "profile.\(id)"
        legacy_token = try c.decodeIfPresent(String.self, forKey: .token)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(base_url, forKey: .base_url)
        try c.encode(workspace, forKey: .workspace)
        try c.encode(write_workspace, forKey: .write_workspace)
        try c.encode(updated_at, forKey: .updated_at)
        try c.encode(token_ref, forKey: .token_ref)
    }
}

struct RelayWorkspacesResponse: Codable {
    var ok: Bool
    var workspaces: [RelayWorkspace]
}

struct RelayWorkspace: Codable, Hashable {
    var name: String
    var source: String?
}

struct RunnerStatus: Codable {
    var runner_id: String?
    var workspace: String?
    var runner_online: Bool?
    var online: Bool?
    var current_task: CurrentTask?
    var last_success_at: String?
    var last_error: String?
    var updated_at: String?
}

struct CurrentTask: Codable {
    var id: String?
    var text: String?
    var mode: String?
    var status: String?
}

struct RunEvent: Codable, Identifiable {
    var id: String
    var runner_id: String?
    var workspace: String?
    var task_id: String?
    var level: String?
    var phase: String?
    var message: String?
    var ts: String?
}

struct ApprovalTicket: Codable, Identifiable {
    var id: String
    var runner_id: String?
    var workspace: String?
    var task_id: String?
    var task_text: String?
    var risk_reason: [String]?
    var state: String
    var decision_by: String?
    var decision_at: String?
    var created_at: String?
    var updated_at: String?
}

struct StatusResponse: Codable {
    var ok: Bool
    var status: RunnerStatus?
}

struct RelayStatusResponse: Codable {
    var ok: Bool
    var workspace: String?
    var status: RelayRuntimeStatus
}

struct RelayRuntimeStatus: Codable {
    var source: String?
    var connector_online: Bool?
    var runner_online: Bool?
    var online: Bool?
    var state: String?
    var message: String?
    var runner: RelayRunnerRuntime?
    var connector: RelayConnectorRuntime?
}

struct RelayRunnerRuntime: Codable {
    var runner_id: String?
    var workspace: String?
    var reported_online: Bool?
    var runner_online: Bool?
    var online: Bool?
    var heartbeat_stale: Bool?
    var current_task: CurrentTask?
    var last_success_at: String?
    var last_error: String?
    var updated_at: String?
    var state: String?
    var stale_after_seconds: Int?
}

struct RelayConnectorRuntime: Codable {
    var connector_id: String?
    var workspace: String?
    var status: String?
    var reported_status: String?
    var connector_online: Bool?
    var online: Bool?
    var heartbeat_stale: Bool?
    var last_heartbeat_at: String?
    var updated_at: String?
    var last_error_code: String?
    var last_error_message: String?
    var version: String?
    var stale_after_seconds: Int?
}

struct TaskCurrentResponse: Codable {
    struct TaskRow: Codable {
        var workspace: String?
        var task_id: String?
        var task_text: String?
        var task_mode: String?
        var status: String?
        var updated_at: String?
    }
    var ok: Bool
    var task: TaskRow?
}

struct ApprovalsResponse: Codable {
    var ok: Bool
    var approvals: [ApprovalTicket]
}

struct EventsResponse: Codable {
    var ok: Bool
    var events: [RunEvent]
}

struct ChatThread: Codable, Identifiable, Hashable {
    var thread_id: String
    var workspace: String
    var title: String
    var external_thread_id: String?
    var source: String
    var status: String
    var created_at: String
    var updated_at: String

    var id: String { thread_id }
}

struct ChatThreadWorkspaceGroup: Identifiable, Hashable {
    let workspace: String
    let threads: [ChatThread]

    var id: String { workspace }
    var updated_at: String { threads.first?.updated_at ?? "" }
}

struct ChatPolicy: Codable {
    var approvalPolicy: String?
    var sandbox: String?
    var cwd: String?
    var model: String?
    var personality: String?
    var effort: String?
    var summary: String?
    var mode: String?
    var collaborationMode: ChatCollaborationMode?
}

struct ChatInputItem: Codable, Hashable {
    var type: String
    var text: String?
    var url: String?
    var path: String?
    var name: String?
}

struct ChatThreadPreferences: Codable, Hashable {
    var mode: String
    var model: String
    var effort: String
}

struct ChatCollaborationMode: Codable {
    var mode: String
    var settings: ChatCollaborationModeSettings
}

struct ChatCollaborationModeSettings: Codable {
    var model: String
    var reasoningEffort: String?
    var developerInstructions: String?

    enum CodingKeys: String, CodingKey {
        case model
        case reasoningEffort = "reasoning_effort"
        case developerInstructions = "developer_instructions"
    }
}

struct ChatJob: Codable, Identifiable {
    var job_id: String
    var thread_id: String
    var workspace: String
    var input_text: String
    var input_items: [ChatInputItem]?
    var policy: ChatPolicy?
    var status: String
    var connector_id: String?
    var turn_id: String?
    var idempotency_key: String?
    var error_code: String?
    var error_message: String?
    var stop_requested_at: String?
    var stop_requested_by: String?
    var created_at: String
    var updated_at: String

    var id: String { job_id }
}

struct ChatEvent: Codable, Identifiable, Hashable {
    var seq: Int
    var thread_id: String
    var workspace: String
    var job_id: String?
    var turn_id: String?
    var type: String
    var delta: String?
    var payload: JSONValue?
    var ts: String

    var id: String { "\(thread_id)#\(seq)" }
}

struct ChatThreadsResponse: Codable {
    var ok: Bool
    var threads: [ChatThread]
    var next_cursor: String?
}

struct ChatThreadResponse: Codable {
    var ok: Bool
    var thread: ChatThread
    var jobs: [ChatJob]?
    var user_input_request: ChatUserInputRequest?
}

struct ChatThreadCreateResponse: Codable {
    var ok: Bool
    var thread: ChatThread
}

struct ChatThreadDeleteResponse: Codable {
    var ok: Bool
    var thread: ChatThread
    var request: SessionSyncRequest?
}

struct SessionSyncRequest: Codable {
    var request_id: String
    var workspace: String
    var thread_id: String?
    var requested_by: String?
    var status: String
}

struct ChatMessageResponse: Codable {
    var ok: Bool
    var thread: ChatThread
    var job: ChatJob
    var duplicate: Bool?
}

struct ChatThreadInterruptResponse: Codable {
    var ok: Bool
    var thread: ChatThread
    var job: ChatJob?
    var requested: Bool?
    var mode: String?
}

struct ChatUserInputOption: Codable, Hashable {
    var label: String
    var description: String
}

struct ChatUserInputQuestion: Codable, Identifiable, Hashable {
    var id: String
    var header: String
    var question: String
    var isOther: Bool?
    var isSecret: Bool?
    var options: [ChatUserInputOption]?
}

struct ChatUserInputAnswerPayload: Codable, Hashable {
    var answers: [String]
}

struct ChatUserInputRequest: Codable, Identifiable, Hashable {
    var request_id: String
    var job_id: String
    var thread_id: String
    var workspace: String
    var connector_id: String?
    var turn_id: String?
    var item_id: String?
    var questions: [ChatUserInputQuestion]
    var answers: [String: ChatUserInputAnswerPayload]?
    var status: String
    var created_at: String
    var answered_at: String?
    var completed_at: String?
    var updated_at: String

    var id: String { request_id }
}

struct ChatUserInputRespondResponse: Codable {
    var ok: Bool
    var request: ChatUserInputRequest
}

struct ChatEventsResponse: Codable {
    var ok: Bool
    var thread_id: String
    var events: [ChatEvent]
    var last_seq: Int
}

struct ChatTranscriptAttachment: Identifiable, Hashable {
    var id: String
    var type: String
    var url: String?
    var path: String?
}

struct ChatTranscriptMessage: Identifiable, Hashable {
    var id: String
    var role: String
    var text: String
    var ts: String?
    var attachments: [ChatTranscriptAttachment] = []
}

struct UsageSummaryResponse: Codable {
    var ok: Bool
    var workspace: String
    var threads_count: Int
    var jobs: UsageJobs
    var usage: UsageTotals
    var total_tokens_source: String?
    var rate_limits: UsageRateLimits?
    var rate_limits_source: String?
    var rate_limits_windows_found: Int?
    var usage_updated_at: String?
}

struct UsageRateLimits: Codable, Hashable {
    var five_hour: UsageRateLimitWindow?
    var weekly: UsageRateLimitWindow?
}

struct UsageRateLimitWindow: Codable, Hashable {
    var scope: String?
    var window_minutes: Int
    var used_percent: Double?
    var remaining_percent: Double?
    var used_tokens: Int?
    var limit_tokens: Int?
    var reset_at: String?
    var updated_at: String?
}

struct UsageJobs: Codable {
    var queued: Int
    var claimed: Int
    var running: Int
    var completed: Int
    var failed: Int
}

struct UsageTotals: Codable {
    var total_tokens: Int
    var input_tokens: Int
    var cached_input_tokens: Int
    var output_tokens: Int
    var reasoning_output_tokens: Int
    var model_context_window_max: Int
    var threads_with_usage: Int
}

struct AuthReloginRequestResponse: Codable {
    var ok: Bool
    var request: AuthReloginRequest
}

struct AuthReloginRequest: Codable, Identifiable, Hashable {
    var request_id: String
    var workspace: String
    var requested_by: String?
    var status: String
    var connector_id: String?
    var auth_url: String?
    var user_code: String?
    var verification_uri_complete: String?
    var expires_at: String?
    var message: String?
    var error: String?
    var created_at: String
    var claimed_at: String?
    var completed_at: String?
    var updated_at: String?

    var id: String { request_id }
}
