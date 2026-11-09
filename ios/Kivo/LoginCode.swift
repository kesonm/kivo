import Foundation

enum LoginCode {
    static func token(from value: String) -> String? {
        guard value.count <= 160,
              let url = URLComponents(string: value), url.scheme == "kivo",
              url.host == "web-login", url.path.isEmpty, url.port == nil,
              url.user == nil, url.password == nil, url.fragment == nil,
              let items = url.queryItems, items.count == 2,
              items.filter({ $0.name == "v" && $0.value == "1" }).count == 1,
              let token = items.first(where: { $0.name == "token" })?.value,
              token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { return nil }
        return token
    }
}
