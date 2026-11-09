import Foundation
import WebKit

struct LoginChallenge: Decodable, Identifiable {
    let id: String
    let verificationCode: String
    let browser: String
    let origin: String
    let expiresAt: Double
    let username: String
}

private struct PhoneSession: Decodable {
    struct User: Decodable { let id: String }
    let user: User?
    let csrfToken: String
}
private struct APIErrorBody: Decodable { let error: String }

struct PhoneError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class PhoneAPI {
    static let origin = URL(string: "https://kivo.iptnet.xyz")!
    private let cookieStore: WKHTTPCookieStore
    private let session: URLSession

    init(cookieStore: WKHTTPCookieStore) {
        self.cookieStore = cookieStore
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }

    private func credentials() async throws -> (String, String) {
        let cookies: [HTTPCookie] = await withCheckedContinuation { continuation in
            cookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        let valid = cookies.filter {
            $0.name == "cw_session" && $0.domain == Self.origin.host! && $0.path == "/"
                && $0.isSecure && ($0.expiresDate ?? .distantFuture) > Date()
        }
        guard valid.count == 1 else { throw PhoneError(message: "请先在 App 内使用账号密码登录，再扫码授权网页。") }
        let cookie = HTTPCookie.requestHeaderFields(with: valid)["Cookie"] ?? ""
        let data = try await request("/api/session", cookie: cookie)
        let result = try JSONDecoder().decode(PhoneSession.self, from: data)
        guard result.user != nil else { throw PhoneError(message: "登录已过期，请先在 App 中重新登录。") }
        return (cookie, result.csrfToken)
    }

    func requireLogin() async throws { _ = try await credentials() }

    func scan(token: String) async throws -> LoginChallenge {
        let (cookie, csrf) = try await credentials()
        let data = try await request("/api/auth/qr/scan", cookie: cookie, csrf: csrf, body: ["token": token])
        return try JSONDecoder().decode(LoginChallenge.self, from: data)
    }

    func decide(token: String, approve: Bool) async throws {
        let (cookie, csrf) = try await credentials()
        _ = try await request("/api/auth/qr/confirm", cookie: cookie, csrf: csrf,
                              body: ["token": token, "decision": approve ? "approve" : "deny"])
    }

    private func request(_ path: String, cookie: String, csrf: String? = nil,
                         body: [String: String]? = nil) async throws -> Data {
        // Fixed origin and paths: QR content can never choose a request URL.
        let url = Self.origin.appendingPathComponent(String(path.dropFirst()))
        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(Self.origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("kivo-iOS/1.5.0", forHTTPHeaderField: "User-Agent")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw PhoneError(message: "服务器未返回有效响应。") }
        guard (200..<300).contains(response.statusCode) else {
            let detail = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            throw PhoneError(message: detail?.error ?? "服务暂时不可用（\(response.statusCode)），请稍后重试。")
        }
        return data
    }
}
