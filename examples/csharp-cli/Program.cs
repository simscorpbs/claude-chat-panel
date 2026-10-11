// The session without the page: sends one message and prints the answer as
// it streams. `dotnet run --project examples/csharp-cli -- "question" [folder] [claude arguments…]`
using System.Text.Json.Nodes;
using ClaudeChatPanel;

var question = args.Length > 0 ? args[0] : "Say hello in one short sentence.";
var folder = args.Length > 1 ? args[1] : Environment.CurrentDirectory;
var done = new TaskCompletionSource();

using var session = new ClaudeChatSession(new(ClaudeChatSession.NewSessionId(), folder)
{
    ExtraArguments = args.Skip(2).ToArray(),
});
session.Event += e =>
{
    switch (e["type"]?.GetValue<string>())
    {
        case "stream_event":
            if (e["event"]?["delta"]?["text"]?.GetValue<string>() is { } text) Console.Write(text);
            break;
        case "result":
            Console.WriteLine($"\n[done, US$ {e["total_cost_usd"]}]");
            done.TrySetResult();
            break;
        case "error" or "exited":
            Console.WriteLine($"\n[{e["text"]?.GetValue<string>() ?? "the session ended"}]");
            done.TrySetResult();
            break;
    }
};
session.Send(question);
await done.Task;

// A few checks of the protocol's messages, the same the other hosts test.
var request = JsonNode.Parse("""{"input":{"command":"ls"},"permission_suggestions":[{"type":"addRules"}]}""");
var always = ClaudeChat.PermissionResponse("r1", request, allow: true, always: true);
if (always["response"]?["response"]?["updatedPermissions"]?[0]?["type"]?.GetValue<string>() != "addRules"
    || !ClaudeChat.Shown(JsonNode.Parse("""{"type":"system","subtype":"init"}""")!)
    || ClaudeChat.Shown(JsonNode.Parse("""{"type":"rate_limit_event"}""")!))
{
    Console.WriteLine("protocol check failed");
    return 1;
}
Console.WriteLine("protocol checks passed");
return 0;
