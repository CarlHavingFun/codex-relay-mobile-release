import Foundation

enum RelaySetupLink {
    case legacy(baseURL: String, token: String, workspace: String)
    case v2(setupCode: String, expiresAt: Date?, platformBaseURL: String?)

    static func parse(_ url: URL) -> RelaySetupLink? {
        guard url.scheme?.lowercased() == "codexrelay" else { return nil }

        let host = (url.host ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let path = url.path.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard host == "setup" || path == "/setup" else { return nil }

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let query = components.queryItems ?? []

        let version = firstNonEmpty(query, keys: ["v", "version"]) ?? "1"
        if version == "2" {
            let setupCode = firstNonEmpty(query, keys: ["setup_code", "code"])
            guard let setupCode else { return nil }
            let expRaw = firstNonEmpty(query, keys: ["exp", "expires_at", "expiresAt"])
            let platformBaseURL = firstNonEmpty(query, keys: ["platform_base_url", "platform_url", "api_base_url"])
            return .v2(
                setupCode: setupCode,
                expiresAt: parseISO8601(expRaw),
                platformBaseURL: platformBaseURL
            )
        }

        let baseURL = firstNonEmpty(query, keys: ["base_url", "baseurl", "relay_base_url", "url"])
        let token = firstNonEmpty(query, keys: ["token", "relay_token", "bearer", "bearer_token"])
        let workspace = firstNonEmpty(query, keys: ["workspace", "ws"]) ?? "*"

        guard let baseURL, let token else { return nil }
        return .legacy(baseURL: baseURL, token: token, workspace: workspace)
    }

    private static func firstNonEmpty(_ items: [URLQueryItem], keys: [String]) -> String? {
        let keySet = Set(keys.map { $0.lowercased() })
        for item in items {
            guard keySet.contains(item.name.lowercased()) else { continue }
            let value = (item.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private static func parseISO8601(_ value: String?) -> Date? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return ISO8601DateFormatter().date(from: value)
    }
}
