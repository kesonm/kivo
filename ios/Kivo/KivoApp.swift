import SwiftUI

@main
struct KivoApp: App {
    var body: some Scene { WindowGroup { KivoHome().preferredColorScheme(.light) } }
}

struct KivoHome: View {
    @StateObject private var workspace = WorkspaceModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var scanner = false
    @State private var busy = false
    @State private var error: String?
    @State private var success = false
    @State private var challenge: LoginChallenge?
    @State private var scannedToken: String?
    @State private var pendingCode: String?
    @State private var scannerError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                WorkspaceView(model: workspace)
                if let failure = workspace.failure {
                    VStack(spacing: 18) {
                        Image(systemName: "wifi.exclamationmark").font(.largeTitle)
                        Text(failure).multilineTextAlignment(.center)
                        Button("重新连接", action: workspace.load).buttonStyle(.borderedProminent)
                    }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
                }
                if workspace.loading || busy {
                    VStack { ProgressView().padding(12).background(.regularMaterial, in: Capsule()); Spacer() }.padding(.top, 8)
                }
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    HStack(spacing: 5) {
                        Image("Brand").resizable().scaledToFit().frame(width: 36, height: 36)
                        Text("kivo").font(.headline)
                    }.accessibilityElement(children: .combine)
                }
                ToolbarItemGroup(placement: .navigationBarTrailing) {
                    Button { workspace.load() } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("刷新工作台")
                    Button { startScan() } label: { Label("扫码登录", systemImage: "qrcode.viewfinder") }.disabled(busy)
                }
            }
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarBackground(Color.white, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
        }
        .tint(.primary)
        .fullScreenCover(isPresented: $scanner, onDismiss: processScan) {
            NavigationStack {
                ZStack {
                    QRScanner(onCode: { value in pendingCode = value; scanner = false }, onError: { message in scannerError = message; scanner = false }).ignoresSafeArea()
                    VStack(spacing: 26) {
                        Text("扫描电脑上 kivo 登录页的二维码").font(.headline).padding().background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 14))
                        RoundedRectangle(cornerRadius: 24).stroke(.white, lineWidth: 3).frame(width: 250, height: 250)
                        Text("扫描后仍需你确认，才会登录网页。").font(.subheadline)
                    }.foregroundStyle(.white).padding().allowsHitTesting(false)
                }
                .navigationTitle("扫码授权登录")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { scanner = false } } }
            }
        }
        .sheet(item: $challenge, onDismiss: { scannedToken = nil }) { item in
            LoginConfirmation(challenge: item, api: workspace.api, token: scannedToken ?? "") { approved in
                challenge = nil; success = approved
            }.interactiveDismissDisabled()
        }
        .alert("提示", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("知道了", role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
        .alert("已授权网页登录", isPresented: $success) { Button("完成", role: .cancel) {} }
        .onChange(of: scenePhase) { phase in if phase == .background { scanner = false } }
    }

    private func startScan() {
        pendingCode = nil; scannerError = nil
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { try await workspace.api.requireLogin(); scanner = true }
            catch { self.error = error.localizedDescription }
        }
    }
    private func processScan() {
        if let scannerError { error = scannerError; self.scannerError = nil; return }
        guard let value = pendingCode else { return }; pendingCode = nil
        guard let token = LoginCode.token(from: value) else { error = "这不是 kivo 网页登录二维码，请在电脑登录页选择 App 扫码登录。"; return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let result = try await workspace.api.scan(token: token)
                guard result.origin == PhoneAPI.origin.absoluteString else { throw PhoneError(message: "二维码的网站不受信任。") }
                scannedToken = token; challenge = result
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct LoginConfirmation: View {
    let challenge: LoginChallenge
    let api: PhoneAPI
    let token: String
    let completion: (Bool) -> Void
    @State private var busy = false
    @State private var error: String?
    @State private var now = Date()
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    private var expired: Bool { now.timeIntervalSince1970 * 1000 >= challenge.expiresAt }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    Image(systemName: "desktopcomputer").font(.system(size: 52)).padding(.top, 30)
                    Text("授权这台浏览器登录？").font(.title2.bold())
                    Text("将使用 @\(challenge.username) 登录，浏览器可以访问你的会话、项目及账户设置。")
                        .multilineTextAlignment(.center).foregroundStyle(.secondary)
                    VStack(spacing: 10) {
                        Text(challenge.origin).font(.headline)
                        Text(challenge.browser).foregroundStyle(.secondary)
                        Text(challenge.verificationCode).font(.system(size: 38, weight: .medium, design: .monospaced)).tracking(6)
                        Text("请与电脑上显示的确认码核对").font(.footnote).foregroundStyle(.secondary)
                    }.padding(24).frame(maxWidth: .infinity).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                    Text("仅授权你本人正在使用的网页，不要扫描他人发来的二维码。").font(.footnote).foregroundStyle(.secondary)
                    if expired { Text("二维码已过期，请在电脑刷新后重新扫描。").foregroundStyle(.red) }
                    if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                    Button { decide(true) } label: {
                        HStack { Spacer(); if busy { ProgressView() }; Text("确认登录"); Spacer() }.padding(.vertical, 10)
                    }.buttonStyle(.borderedProminent).tint(.black).disabled(busy || expired)
                    Button("取消授权", role: .cancel) { decide(false) }.disabled(busy).padding(.bottom, 24)
                }.padding(26)
            }.navigationTitle("网页登录授权").navigationBarTitleDisplayMode(.inline)
        }.onReceive(timer) { now = $0 }
    }
    private func decide(_ approve: Bool) {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { try await api.decide(token: token, approve: approve); completion(approve) }
            catch {
                if !approve { completion(false) } else { self.error = error.localizedDescription }
            }
        }
    }
}
