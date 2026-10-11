import XCTest
@testable import ClaudeChatPanel

final class ClaudeChatTests: XCTestCase {
    func testPermissionIsAnsweredAsTheCLIAsks() {
        let request: [String: Any] = ["subtype": "can_use_tool", "input": ["command": "ls"],
                                      "permission_suggestions": [["type": "addRules"]]]
        let allowed = ClaudeChat.permissionResponse(requestId: "r1", request: request, allow: true, always: false)
        let inner = (allowed["response"] as? [String: Any])?["response"] as? [String: Any]
        XCTAssertEqual(inner?["behavior"] as? String, "allow")
        XCTAssertNil(inner?["updatedPermissions"])
        let always = ClaudeChat.permissionResponse(requestId: "r1", request: request, allow: true, always: true)
        XCTAssertNotNil(((always["response"] as? [String: Any])?["response"] as? [String: Any])?["updatedPermissions"])
        let denied = ClaudeChat.permissionResponse(requestId: "r1", request: request, allow: false, always: false)
        XCTAssertEqual(((denied["response"] as? [String: Any])?["response"] as? [String: Any])?["behavior"] as? String, "deny")
    }

    func testOnlyWhatThePageShowsGoesToIt() {
        XCTAssertTrue(ClaudeChat.shown(["type": "system", "subtype": "init"]))
        XCTAssertFalse(ClaudeChat.shown(["type": "system", "subtype": "thinking_tokens"]))
        XCTAssertTrue(ClaudeChat.shown(["type": "control_request"]))
        XCTAssertFalse(ClaudeChat.shown(["type": "rate_limit_event"]))
    }

    func testThePastComesFromTheTranscript() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let project = home.appendingPathComponent(".claude/projects/-x")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try [
            #"{"type":"queue-operation"}"#,
            #"{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}"#,
            #"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"sub"}]}}"#,
            #"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#,
        ].joined(separator: "\n").write(to: project.appendingPathComponent("abc.jsonl"), atomically: true, encoding: .utf8)
        let past = ClaudeChat.history(sessionId: "abc", home: home)
        XCTAssertEqual(past.count, 2)
        XCTAssertTrue(ClaudeChat.history(sessionId: "none", home: home).isEmpty)
    }
}
