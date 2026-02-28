import Foundation

enum CPAPIError: Error {
    case invalidURL
    case invalidResponse
    case serverError(String)
}

actor CPAPIClient {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    func get<T: Decodable>(_ path: String, baseURL: String, token: String) async throws -> T {
        try await request(path: path, baseURL: baseURL, token: token, method: "GET", body: nil)
    }

    func post<T: Decodable, B: Encodable>(_ path: String, baseURL: String, token: String, body: B) async throws -> T {
        try await request(
            path: path,
            baseURL: baseURL,
            token: token,
            method: "POST",
            body: try encoder.encode(body)
        )
    }

    private func request<T: Decodable>(
        path: String,
        baseURL: String,
        token: String,
        method: String,
        body: Data?
    ) async throws -> T {
        var req = try makeRequest(path: path, baseURL: baseURL, token: token)
        req.httpMethod = method
        req.httpBody = body
        if body != nil {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw CPAPIError.invalidResponse }

        guard (200..<300).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw CPAPIError.serverError("HTTP \(http.statusCode): \(text)")
        }

        if let apiError = apiErrorText(from: data) {
            throw CPAPIError.serverError("API error: \(apiError)")
        }

        return try decoder.decode(T.self, from: data)
    }

    private func makeRequest(path: String, baseURL: String, token: String) throws -> URLRequest {
        let trimmedBase = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBase.isEmpty else { throw CPAPIError.invalidURL }

        let baseWithoutTrailingSlash = trimmedBase.hasSuffix("/") ? String(trimmedBase.dropLast()) : trimmedBase
        let normalizedPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let joined = "\(baseWithoutTrailingSlash)/\(normalizedPath)"

        guard let url = URL(string: joined) else { throw CPAPIError.invalidURL }

        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        req.setValue("no-cache", forHTTPHeaderField: "Pragma")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    private func apiErrorText(from data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        guard (obj["ok"] as? Bool) == false else { return nil }
        if let errorText = obj["error"] as? String {
            let normalized = errorText.trimmingCharacters(in: .whitespacesAndNewlines)
            return normalized.isEmpty ? "unknown_error" : normalized
        }
        return "unknown_error"
    }
}
