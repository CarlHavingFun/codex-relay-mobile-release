import Foundation

enum AppLanguage: String, CaseIterable, Codable, Identifiable {
    case system = "system"
    case zhHans = "zh-Hans"
    case en = "en"

    var id: String { rawValue }

    var localeIdentifier: String? {
        switch self {
        case .system:
            return nil
        case .zhHans:
            return "zh-Hans"
        case .en:
            return "en"
        }
    }
}

enum CPTaskKind: String, Codable, Hashable {
    case master
    case sub
    case manual
    case unknown
}

struct CPTaskSemantic: Codable, Hashable {
    let kind: CPTaskKind
    let sourceWorkspace: String?
    let threadID: String?
    let parentMasterTaskID: String?
    let groupDimension: String
    let groupKey: String
    let repoPath: String?
    let repoFolder: String?
}

struct CPWorkspaceGroup: Identifiable, Hashable {
    let key: String
    let displayName: String
    let dimension: String
    let tasks: [CPTask]
    let masterTasks: [CPTask]
    let subTasks: [CPTask]
    let manualTasks: [CPTask]
    let unknownTasks: [CPTask]
    let activeCount: Int
    let runningCount: Int
    let failedCount: Int
    let waitingApprovalCount: Int
    let lastUpdatedAt: String

    var id: String { key }
}

struct CPPortfolioSummary: Hashable {
    let totalTasks: Int
    let groupCount: Int
    let activeCount: Int
    let runningCount: Int
    let failedCount: Int
    let waitingApprovalCount: Int
    let lastUpdatedAt: String?

    static let empty = CPPortfolioSummary(
        totalTasks: 0,
        groupCount: 0,
        activeCount: 0,
        runningCount: 0,
        failedCount: 0,
        waitingApprovalCount: 0,
        lastUpdatedAt: nil
    )
}

struct CPTaskListResponse: Codable {
    let ok: Bool
    let tasks: [CPTask]
    let count: Int?
    let ts: String?
}

struct CPTaskCreateResponse: Codable {
    let ok: Bool
    let task_id: String
    let task: CPTask
    let ts: String?
}

struct CPTaskDetailResponse: Codable {
    let ok: Bool
    let task: CPTaskDetail
    let ts: String?
}

struct CPTaskControlResponse: Codable {
    let ok: Bool
    let task: CPTaskDetail
    let ts: String?
}

struct CPWorkerResultResponse: Codable {
    let ok: Bool
    let duplicate: Bool?
    let ts: String?
}

struct CPHealthResponse: Codable {
    let ok: Bool
    let ts: String?
    let loop_ms: Int?
    let tick_in_flight: Bool?
    let last_tick_at: String?
    let last_tick_error: String?
    let task_counts: CPTaskCounts?
    let system: CPSystemState?
}

struct CPGlobalControlResponse: Codable {
    let ok: Bool
    let result: CPGlobalControlResult
    let ts: String?
}

struct CPGlobalControlResult: Codable {
    let emergency_stop: CPEmergencyStop?
    let circuit_breaker: CPCircuitBreaker?
}

struct CPTaskCounts: Codable {
    let queued: Int?
    let planning: Int?
    let running: Int?
    let reviewing: Int?
    let releasing: Int?
    let done: Int?
    let failed: Int?
    let rolled_back: Int?
    let paused: Int?
    let canceled: Int?
}

struct CPSystemState: Codable {
    let emergency_stop: CPEmergencyStop?
    let circuit_breaker: CPCircuitBreaker?
    let global_active_jobs: Int?
}

struct CPEmergencyStop: Codable, Hashable {
    let active: Bool?
    let by: String?
    let reason: String?
    let at: String?
}

struct CPCircuitBreaker: Codable, Hashable {
    let scope: String?
    let status: String?
    let failure_count: Int?
    let threshold: Int?
    let opened_at: String?
    let reason: String?
    let updated_at: String?
}

struct CPTask: Codable, Identifiable, Hashable {
    let task_id: String
    let goal: String
    let repo: String
    let branch: String
    let acceptance_criteria: [String]
    let priority: String
    let risk_profile: String
    let status: String
    let parallelism_limit: Int
    let created_at: String
    let updated_at: String
    let started_at: String?
    let completed_at: String?
    let failed_reason: String?
    let degraded: Bool
    let semantic: CPTaskSemantic?

    var id: String { task_id }
}

struct CPTaskDetail: Codable, Identifiable, Hashable {
    let task_id: String
    let goal: String
    let repo: String
    let branch: String
    let acceptance_criteria: [String]
    let priority: String
    let risk_profile: String
    let status: String
    let parallelism_limit: Int
    let created_at: String
    let updated_at: String
    let started_at: String?
    let completed_at: String?
    let failed_reason: String?
    let degraded: Bool
    let semantic: CPTaskSemantic?
    let dag_progress: CPDagProgress?
    let sub_tasks: [CPSubTask]?
    let events: [CPTaskEvent]?
    let decisions: [CPDecisionRecord]?
    let rollbacks: [CPRollbackRecord]?
    let controls: CPTaskControls?

    var id: String { task_id }
}

struct CPTaskControls: Codable, Hashable {
    let emergency_stop: CPEmergencyStop?
    let circuit_breaker: CPCircuitBreaker?
}

struct CPDagProgress: Codable, Hashable {
    let total: Int?
    let blocked: Int?
    let queued: Int?
    let dispatched: Int?
    let running: Int?
    let completed: Int?
    let failed: Int?
    let timeout: Int?
    let canceled: Int?
}

struct CPSubTask: Codable, Identifiable, Hashable {
    let job_id: String
    let task_id: String
    let node_id: String
    let role: String
    let timeout_s: Int
    let max_retries: Int
    let attempt: Int
    let status: String
    let worker_id: String?
    let next_run_at: String?
    let last_error: String?
    let started_at: String?
    let finished_at: String?

    var id: String { job_id }
}

struct CPTaskEvent: Codable, Identifiable, Hashable {
    let id: Int
    let event_type: String
    let ts: String
}

struct CPDecisionRecord: Codable, Identifiable, Hashable {
    let id: Int
    let decision: String
    let reason: String
    let ts: String
}

struct CPRollbackRecord: Codable, Identifiable, Hashable {
    let id: Int
    let reason: String
    let status: String
    let ts: String
}

struct CPTaskSpec {
    var goal: String
    var repo: String
    var branch: String
    var acceptanceCriteria: [String]
    var priority: String
    var riskProfile: String
}

struct CPRelayHealthzResponse: Codable {
    let ok: Bool
    let ts: String?
    let db_path: String?
}

struct CPSupervisorTaskStep: Codable, Hashable {
    let id: String
    let title: String
    let status: String
}

struct CPSupervisorTask: Codable, Hashable {
    let id: String
    let workspace: String
    let title: String
    let objective: String
    let priority: String
    let approval_mode: String?
    let status: String
    let steps: [CPSupervisorTaskStep]
    let attempts: Int?
    let claim_runner_id: String?
    let claim_profile_id: String?
    let claim_at: String?
    let failed_reason: String?
    let created_at: String
    let updated_at: String
    let completed_at: String?
}

struct CPSupervisorTasksResponse: Codable {
    let ok: Bool
    let tasks: [CPSupervisorTask]
    let ts: String?
}

struct CPSupervisorTaskCreateResponse: Codable {
    let ok: Bool
    let task: CPSupervisorTask
    let ts: String?
}

struct CPSupervisorTaskUpdateResponse: Codable {
    let ok: Bool
    let task: CPSupervisorTask
    let ts: String?
}
