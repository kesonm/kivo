import XCTest
@testable import Kivo

final class LoginCodeTests: XCTestCase {
    private let token = String(repeating: "a", count: 43)
    func testAcceptsOnlyTheVersionedLoginPayload() {
        XCTAssertEqual(LoginCode.token(from: "kivo://web-login?v=1&token=\(token)"), token)
        XCTAssertEqual(LoginCode.token(from: "kivo://web-login?token=\(token)&v=1"), token)
    }
    func testRejectsForeignOriginsMalformedAndAmbiguousPayloads() {
        for payload in [
            "https://attacker.example/?token=\(token)", "https://kivo.iptnet.xyz/?token=\(token)",
            "kivo://web-login.evil?v=1&token=\(token)", "kivo://user@web-login?v=1&token=\(token)",
            "kivo://web-login:443?v=1&token=\(token)", "kivo://web-login/path?v=1&token=\(token)",
            "kivo://web-login?v=2&token=\(token)", "kivo://web-login?v=1&token=short",
            "kivo://web-login?v=1&token=\(token)&token=\(token)",
            "kivo://web-login?v=1&v=1", "kivo://web-login?v=1&token=\(token)#extra",
            "kivo://web-login?v=1&token=\(token)&redirect=https://attacker.example",
            "kivo://web-login?v=1&token=\(String(repeating: "/", count: 43))"
        ] { XCTAssertNil(LoginCode.token(from: payload), payload) }
    }
}
