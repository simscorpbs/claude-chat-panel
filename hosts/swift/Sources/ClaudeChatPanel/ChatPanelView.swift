// The chat page in a WKWebView, wired to a ClaudeChatSession, and a SwiftUI
// view around it. macOS only.

#if os(macOS)
import AppKit
import SwiftUI
import WebKit

/// Owns the web view and relays between the page and the session.
public final class ChatPanelController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    public let session: ClaudeChatSession
    public let webView: WKWebView

    /// - Parameters:
    ///   - strings: the page's words (`window.CHAT_STRINGS`), English by default.
    ///   - colors: CSS variables to set on `:root`, such as `["--accent": "#0969da"]`.
    public init(session: ClaudeChatSession, strings: [String: String] = [:], colors: [String: String] = [:]) {
        self.session = session
        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        let controller = configuration.userContentController
        controller.add(WeakHandler(self), name: "chat")
        var setup = ""
        if let data = try? JSONSerialization.data(withJSONObject: strings), let json = String(data: data, encoding: .utf8) {
            setup += "window.CHAT_STRINGS = \(json);"
        }
        for (name, value) in colors {
            setup += "document.documentElement.style.setProperty(\(Self.quoted(name)), \(Self.quoted(value)));"
        }
        controller.addUserScript(WKUserScript(source: setup, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView.navigationDelegate = self
        session.onEvent = { [weak self] event in self?.call("events", with: [event]) }
        if let page = Bundle.module.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }
    }

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String, let data = text.data(using: .utf8),
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        switch body["t"] as? String {
        case "ready": call("history", with: session.history())
        case "copy":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(body["d"] as? String ?? "", forType: .string)
        case "link": if let url = URL(string: body["d"] as? String ?? "") { NSWorkspace.shared.open(url) }
        case "paste": if let text = NSPasteboard.general.string(forType: .string) { insert(text) }
        default: session.handle(pageMessage: body)
        }
    }

    /// Puts `text` in the message field, at the cursor.
    public func insert(_ text: String) {
        webView.evaluateJavaScript("window.chat.insert(\(Self.quoted(text)))")
    }

    public func focus() { webView.evaluateJavaScript("window.chat.focus()") }

    private func call(_ function: String, with events: [CliEvent]) {
        // Base64 of the JSON, so nothing in it needs escaping in the script.
        guard let data = try? JSONSerialization.data(withJSONObject: events) else { return }
        webView.evaluateJavaScript("window.chat.\(function)('\(data.base64EncodedString())')")
    }

    private static func quoted(_ text: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [text])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }
}

/// Breaks the retain cycle WKUserContentController keeps with its handlers.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// The chat as a SwiftUI view.
public struct ClaudeChatView: NSViewRepresentable {
    public let controller: ChatPanelController

    public init(controller: ChatPanelController) { self.controller = controller }

    public func makeNSView(context: Context) -> WKWebView { controller.webView }
    public func updateNSView(_ view: WKWebView, context: Context) {}
}
#endif
