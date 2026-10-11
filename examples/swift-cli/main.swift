// The session without the page: sends one message and prints the answer as
// it streams. `swift run claude-chat-demo "your question" [folder]`
import ClaudeChatPanel
import Foundation

let arguments = CommandLine.arguments.dropFirst()
let question = arguments.first ?? "Say hello in one short sentence."
let folder = URL(fileURLWithPath: arguments.dropFirst().first ?? FileManager.default.currentDirectoryPath)

var options = ClaudeChatSession.Options(directory: folder)
options.extraArguments = ["--model", "haiku"]
let session = ClaudeChatSession(options: options)
session.onEvent = { event in
    switch event["type"] as? String {
    case "stream_event":
        if let delta = (event["event"] as? [String: Any])?["delta"] as? [String: Any], let text = delta["text"] as? String {
            FileHandle.standardOutput.write(Data(text.utf8))
        }
    case "result":
        print("\n[done, US$ \(event["total_cost_usd"] ?? 0)]")
        session.close()
        exit(0)
    case "error":
        print("error: \(event["text"] ?? "")"); exit(1)
    default: break
    }
}
session.send(question)
RunLoop.main.run()
