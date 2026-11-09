import AVFoundation
import SwiftUI
import UIKit

struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onError: (String) -> Void
    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode; controller.onError = onError
        return controller
    }
    func updateUIViewController(_ controller: ScannerController, context: Context) {}
    static func dismantleUIViewController(_ controller: ScannerController, coordinator: ()) { controller.stop() }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onError: ((String) -> Void)?
    private let capture = AVCaptureSession()
    private let queue = DispatchQueue(label: "xyz.iptnet.kivo.camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var delivered = false
    private var stopped = false // Only accessed on the capture queue.

    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
            guard let self else { return }
            if allowed { self.configure() }
            else { self.report("未获得相机权限。请在 iPhone 设置 → kivo 中允许相机访问后重试。") }
        }
    }
    private func configure() {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device), self.capture.canAddInput(input)
            else { self.report("当前设备没有可用相机。请在真实 iPhone 上扫码。"); return }
            self.capture.beginConfiguration()
            self.capture.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard self.capture.canAddOutput(output) else {
                self.capture.commitConfiguration(); self.report("无法启动二维码扫描，请重试。"); return
            }
            self.capture.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            guard output.availableMetadataObjectTypes.contains(.qr) else {
                self.capture.commitConfiguration(); self.report("当前相机不支持二维码扫描。"); return
            }
            output.metadataObjectTypes = [.qr]
            self.capture.commitConfiguration()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let layer = AVCaptureVideoPreviewLayer(session: self.capture)
                layer.videoGravity = .resizeAspectFill; layer.frame = self.view.bounds
                self.view.layer.insertSublayer(layer, at: 0); self.preview = layer
            }
            self.capture.startRunning()
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews(); preview?.frame = view.bounds
        if let scene = view.window?.windowScene, let connection = preview?.connection,
           connection.isVideoOrientationSupported {
            switch scene.interfaceOrientation {
            case .landscapeLeft: connection.videoOrientation = .landscapeLeft
            case .landscapeRight: connection.videoOrientation = .landscapeRight
            case .portraitUpsideDown: connection.videoOrientation = .portraitUpsideDown
            default: connection.videoOrientation = .portrait
            }
        }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !delivered, let value = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        delivered = true; stop(); onCode?(value)
    }
    private func report(_ message: String) { DispatchQueue.main.async { [weak self] in self?.onError?(message) } }
    func stop() {
        queue.async { [weak self] in
            guard let self else { return }; self.stopped = true
            if self.capture.isRunning { self.capture.stopRunning() }
        }
    }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); stop() }
}
