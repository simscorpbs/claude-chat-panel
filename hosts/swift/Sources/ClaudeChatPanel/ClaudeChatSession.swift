// A Claude Code session behind the chat page: the `claude` CLI in its
// structured mode, one process per session. See PROTOCOL.md.
//
// macOS only: iOS cannot start processes.

import Foundation

/// A line the CLI wrote, or an event of the host's own (`exited`, `error`).
public typealias CliEvent = [String: Any]

public enum ClaudeChat {
    /// The CLI's arguments for the structured mode, before the session's own.
    public static let cliArguments = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool", "stdio",
    ]

    /// The session's transcript, `~/.claude/projects/<project>/<id>.jsonl`.
    public static func transcriptURL(sessionId: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL? {
        let projects = home.appendingPathComponent(".claude/projects")
        guard let folders = try? FileManager.default.contentsOfDirectory(atPath: projects.path) else { return nil }
        for folder in folders {
            let url = projects.appendingPathComponent(folder).appendingPathComponent("\(sessionId).jsonl")
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        return nil
    }

    /// The session's past, for `chat.history`: the user's messages and the
    /// answers, with tools and results, without sub-agents' turns.
    public static func history(sessionId: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [CliEvent] {
        guard let url = transcriptURL(sessionId: sessionId, home: home),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { line in
            guard let data = line.data(using: .utf8),
                  let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let type = record["type"] as? String, type == "user" || type == "assistant",
                  record["isSidechain"] as? Bool != true, record["isMeta"] as? Bool != true
            else { return nil }
            let content = (record["message"] as? [String: Any])?["content"] ?? NSNull()
            return ["type": type, "message": ["content": content]]
        }
    }

    /// Whether a CLI line goes to the page.
    public static func shown(_ event: CliEvent) -> Bool {
        switch event["type"] as? String {
        case "system": return event["subtype"] as? String == "init"
        case "stream_event", "assistant", "user", "result", "control_request": return true
        default: return false
        }
    }

    public static func userMessage(_ text: String) -> CliEvent {
        ["type": "user", "message": ["role": "user", "content": [["type": "text", "text": text]]]]
    }

    public static func interrupt(requestId: String = UUID().uuidString) -> CliEvent {
        ["type": "control_request", "request_id": requestId, "request": ["subtype": "interrupt"]]
    }

    /// The answer to a `can_use_tool` request: allowed as asked (and from now
    /// on, with the CLI's suggested rules, when `always`), or denied.
    public static func permissionResponse(requestId: String, request: [String: Any]?, allow: Bool, always: Bool,
                                          denyMessage: String = "The user denied this.") -> CliEvent {
        var response: [String: Any]
        if allow {
            response = ["behavior": "allow", "updatedInput": request?["input"] ?? [String: Any]()]
            if always, let suggestions = request?["permission_suggestions"] { response["updatedPermissions"] = suggestions }
        } else {
            response = ["behavior": "deny", "message": denyMessage]
        }
        return ["type": "control_response", "response": ["subtype": "success", "request_id": requestId, "response": response]]
    }
}

/// One conversation's session. `onEvent` gets, on the main queue, what goes
/// to the page's `chat.events`; the process starts on the first message.
public final class ClaudeChatSession {
    public struct Options {
        /// The session's id, a UUID the host keeps for this conversation.
        public var sessionId: String
        /// The folder the CLI runs in (its project).
        public var directory: URL
        /// The `claude` executable, found on the PATH by default.
        public var command: String = "claude"
        /// More CLI arguments, such as `--model` or `--append-system-prompt`.
        public var extraArguments: [String] = []
        public var environment: [String: String] = [:]
        public var home: URL = FileManager.default.homeDirectoryForCurrentUser
        public var denyMessage = "The user denied this."

        public init(sessionId: String = UUID().uuidString.lowercased(), directory: URL) {
            self.sessionId = sessionId
            self.directory = directory
        }
    }

    public let options: Options
    public var onEvent: ((CliEvent) -> Void)?

    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var permissions: [String: [String: Any]] = [:]

    public init(options: Options) {
        self.options = options
    }

    deinit { close() }

    /// The past to hand `chat.history` when the page is ready.
    public func history() -> [CliEvent] {
        ClaudeChat.history(sessionId: options.sessionId, home: options.home)
    }

    /// Handles a message from the page. `copy`, `link` and `paste` are the
    /// host's own; this returns false for them.
    @discardableResult
    public func handle(pageMessage message: [String: Any]) -> Bool {
        switch message["t"] as? String {
        case "send": send(message["text"] as? String ?? ""); return true
        case "stop": stop(); return true
        case "perm":
            answerPermission(id: message["id"] as? String ?? "", allow: message["allow"] as? Bool ?? false,
                             always: message["always"] as? Bool ?? false)
            return true
        case "ready": return true
        default: return false
        }
    }

    public func send(_ text: String) { write(ClaudeChat.userMessage(text)) }

    public func stop() { if process != nil { write(ClaudeChat.interrupt()) } }

    public func answerPermission(id: String, allow: Bool, always: Bool) {
        let request = permissions.removeValue(forKey: id)
        write(ClaudeChat.permissionResponse(requestId: id, request: request, allow: allow, always: always,
                                            denyMessage: options.denyMessage))
    }

    /// Ends the CLI. Nothing is lost: the next message resumes the session.
    public func close() {
        guard let process else { return }
        self.process = nil
        try? input?.close()
        input = nil
        if process.isRunning { process.terminate() }
    }

    private func write(_ message: CliEvent) {
        if process == nil { start() }
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        input?.write(data + Data("\n".utf8))
    }

    private func start() {
        let resume = ClaudeChat.transcriptURL(sessionId: options.sessionId, home: options.home) != nil
        let own = resume ? ["--resume", options.sessionId] : ["--session-id", options.sessionId]
        let process = Process()
        // Through env, so `claude` is looked up on the PATH as a shell would.
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [options.command] + ClaudeChat.cliArguments + own + options.extraArguments
        process.currentDirectoryURL = options.directory
        var environment = ProcessInfo.processInfo.environment
        environment.merge(options.environment) { _, new in new }
        process.environment = environment
        let stdin = Pipe(), stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            DispatchQueue.main.async { self?.receive(chunk) }
        }
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                guard let self else { return }
                if self.process === ended { self.process = nil; self.input = nil }
                self.onEvent?(["type": "exited"])
            }
        }
        do {
            try process.run()
            self.process = process
            input = stdin.fileHandleForWriting
        } catch {
            onEvent?(["type": "error", "text": error.localizedDescription])
        }
    }

    private func receive(_ chunk: Data) {
        buffer.append(chunk)
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let event = (try? JSONSerialization.jsonObject(with: line)) as? CliEvent else { continue }
            if event["type"] as? String == "control_request",
               let request = event["request"] as? [String: Any], request["subtype"] as? String == "can_use_tool",
               let id = event["request_id"] as? String {
                permissions[id] = request
            }
            if ClaudeChat.shown(event) { onEvent?(event) }
        }
    }
}
