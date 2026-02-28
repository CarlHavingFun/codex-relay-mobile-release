import Foundation

actor RelayClient {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    func get<T: Decodable>(_ path: String, baseURL: String, token: String) async throws -> T {
        try await request(path: path, baseURL: baseURL, token: token, method: "GET", body: nil, allowCompatRetry: true)
    }

    func post<T: Decodable, B: Encodable>(_ path: String, baseURL: String, token: String, body: B) async throws -> T {
        try await request(
            path: path,
            baseURL: baseURL,
            token: token,
            method: "POST",
            body: try encoder.encode(body),
            allowCompatRetry: true
        )
    }

    private func request<T: Decodable>(
        path: String,
        baseURL: String,
        token: String,
        method: String,
        body: Data?,
        allowCompatRetry: Bool
    ) async throws -> T {
        var req = try makeRequest(path: path, baseURL: baseURL, token: token)
        req.httpMethod = method
        req.httpBody = body
        if body != nil {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw RelayError.invalidResponse }

        if !(200..<300).contains(http.statusCode) {
            if allowCompatRetry,
               http.statusCode == 404,
               let fallback = compatibilityFallbackPath(for: path) {
                return try await request(
                    path: fallback,
                    baseURL: baseURL,
                    token: token,
                    method: method,
                    body: body,
                    allowCompatRetry: false
                )
            }
            let text = String(data: data, encoding: .utf8) ?? ""
            throw RelayError.serverError("HTTP \(http.statusCode): \(text)")
        }

        if let apiError = apiErrorText(from: data) {
            if allowCompatRetry,
               apiError == "not_found",
               let fallback = compatibilityFallbackPath(for: path) {
                return try await request(
                    path: fallback,
                    baseURL: baseURL,
                    token: token,
                    method: method,
                    body: body,
                    allowCompatRetry: false
                )
            }
            throw RelayError.serverError("API error: \(apiError)")
        }

        return try decoder.decode(T.self, from: data)
    }

    private func makeRequest(path: String, baseURL: String, token: String) throws -> URLRequest {
        let trimmedBase = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBase.isEmpty else {
            throw RelayError.invalidURL
        }

        let baseWithoutTrailingSlash = trimmedBase.hasSuffix("/") ? String(trimmedBase.dropLast()) : trimmedBase
        let normalizedPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let joined = "\(baseWithoutTrailingSlash)/\(normalizedPath)"

        guard let url = URL(string: joined) else {
            throw RelayError.invalidURL
        }

        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        req.timeoutInterval = 15
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        req.setValue("no-cache", forHTTPHeaderField: "Pragma")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    private func compatibilityFallbackPath(for path: String) -> String? {
        let normalized = path.hasPrefix("/") ? String(path.dropFirst()) : path
        if normalized.hasPrefix("v1/") || normalized.hasPrefix("v2/") {
            return nil
        }
        if normalized.hasPrefix("legacy-runner/") {
            let rest = String(normalized.dropFirst("legacy-runner/".count))
            if rest == "heartbeat" || rest.hasPrefix("heartbeat?") {
                return "v1/runner/heartbeat"
            }
            return "v1/" + rest
        }
        if normalized.hasPrefix("codex-iphone-connector/") {
            let rest = String(normalized.dropFirst("codex-iphone-connector/".count))
            if rest.hasPrefix("chat/")
                || rest == "status"
                || rest.hasPrefix("status?")
                || rest == "workspaces"
                || rest.hasPrefix("usage/")
                || rest.hasPrefix("sessions/backfill/") {
                return "v2/" + rest
            }
            if rest == "register"
                || rest == "heartbeat"
                || rest.hasPrefix("sessions/")
                || rest.hasPrefix("auth/")
                || rest.hasPrefix("jobs/") {
                return "v2/connector/" + rest
            }
            return "v2/" + rest
        }
        return nil
    }

    private func apiErrorText(from data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let okValue = obj["ok"] as? Bool
        guard okValue == false else { return nil }
        if let errorText = obj["error"] as? String {
            let normalized = errorText.trimmingCharacters(in: .whitespacesAndNewlines)
            return normalized.isEmpty ? "unknown_error" : normalized
        }
        return "unknown_error"
    }
}

enum RelayError: Error {
    case invalidURL
    case invalidResponse
    case serverError(String)
}
