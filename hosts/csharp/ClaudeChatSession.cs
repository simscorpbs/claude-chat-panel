// A Claude Code session behind the chat page: the `claude` CLI in its
// structured mode, one process per session. See PROTOCOL.md.
//
// .NET 8, no packages beyond the base library. ChatPanelWebView2.cs wires it
// to a WebView2 control.

using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudeChatPanel;

public static class ClaudeChat
{
    /// <summary>The CLI's arguments for the structured mode, before the session's own.</summary>
    public static readonly string[] CliArguments =
    [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool", "stdio",
    ];

    /// <summary>The session's transcript, <c>~/.claude/projects/&lt;project&gt;/&lt;id&gt;.jsonl</c>.</summary>
    public static string? TranscriptPath(string sessionId, string? home = null)
    {
        home ??= Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var projects = Path.Combine(home, ".claude", "projects");
        if (!Directory.Exists(projects)) return null;
        foreach (var project in Directory.GetDirectories(projects))
        {
            var path = Path.Combine(project, sessionId + ".jsonl");
            if (File.Exists(path)) return path;
        }
        return null;
    }

    /// <summary>The session's past, for <c>chat.history</c>, without sub-agents' turns.</summary>
    public static JsonArray History(string sessionId, string? home = null)
    {
        var records = new JsonArray();
        var path = TranscriptPath(sessionId, home);
        if (path is null) return records;
        foreach (var line in File.ReadLines(path))
        {
            JsonNode? record;
            try { record = JsonNode.Parse(line); } catch (JsonException) { continue; }
            var type = record?["type"]?.GetValue<string>();
            if (type is not ("user" or "assistant")) continue;
            if (record!["isSidechain"]?.GetValue<bool>() == true || record["isMeta"]?.GetValue<bool>() == true) continue;
            records.Add(new JsonObject
            {
                ["type"] = type,
                ["message"] = new JsonObject { ["content"] = record["message"]?["content"]?.DeepClone() },
            });
        }
        return records;
    }

    /// <summary>Whether a CLI line goes to the page.</summary>
    public static bool Shown(JsonNode e) => e["type"]?.GetValue<string>() switch
    {
        "system" => e["subtype"]?.GetValue<string>() == "init",
        "stream_event" or "assistant" or "user" or "result" or "control_request" => true,
        _ => false,
    };

    public static JsonObject UserMessage(string text) => new()
    {
        ["type"] = "user",
        ["message"] = new JsonObject
        {
            ["role"] = "user",
            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }),
        },
    };

    public static JsonObject Interrupt() => new()
    {
        ["type"] = "control_request",
        ["request_id"] = Guid.NewGuid().ToString(),
        ["request"] = new JsonObject { ["subtype"] = "interrupt" },
    };

    /// <summary>The answer to a <c>can_use_tool</c> request: allowed as asked (and from now on,
    /// with the CLI's suggested rules, when <paramref name="always"/>), or denied.</summary>
    public static JsonObject PermissionResponse(string requestId, JsonNode? request, bool allow, bool always,
        string denyMessage = "The user denied this.")
    {
        JsonObject response;
        if (allow)
        {
            response = new JsonObject
            {
                ["behavior"] = "allow",
                ["updatedInput"] = request?["input"]?.DeepClone() ?? new JsonObject(),
            };
            if (always && request?["permission_suggestions"] is { } suggestions)
                response["updatedPermissions"] = suggestions.DeepClone();
        }
        else
        {
            response = new JsonObject { ["behavior"] = "deny", ["message"] = denyMessage };
        }
        return new JsonObject
        {
            ["type"] = "control_response",
            ["response"] = new JsonObject { ["subtype"] = "success", ["request_id"] = requestId, ["response"] = response },
        };
    }
}

/// <summary>One conversation's session. <see cref="Event"/> gets what goes to the page's
/// <c>chat.events</c>, on a background thread; the process starts on the first message.</summary>
public sealed class ClaudeChatSession(ClaudeChatSession.Options options) : IDisposable
{
    public sealed record Options(string SessionId, string Directory)
    {
        /// <summary>The <c>claude</c> executable; <c>claude</c> on the PATH by default.</summary>
        public string Command { get; init; } = "claude";
        /// <summary>More CLI arguments, such as <c>--model</c>.</summary>
        public IReadOnlyList<string> ExtraArguments { get; init; } = [];
        public string? Home { get; init; }
        public string DenyMessage { get; init; } = "The user denied this.";
    }

    public event Action<JsonNode>? Event;

    private readonly Dictionary<string, JsonNode?> permissions = [];
    private readonly object gate = new();
    private Process? process;

    public static string NewSessionId() => Guid.NewGuid().ToString();

    /// <summary>The past to hand <c>chat.history</c> when the page is ready.</summary>
    public JsonArray History() => ClaudeChat.History(options.SessionId, options.Home);

    /// <summary>Handles a message from the page. <c>copy</c>, <c>link</c> and <c>paste</c> are the
    /// host's own; this returns false for them.</summary>
    public bool HandlePageMessage(JsonNode message)
    {
        switch (message["t"]?.GetValue<string>())
        {
            case "send": Send(message["text"]?.GetValue<string>() ?? ""); return true;
            case "stop": Stop(); return true;
            case "perm":
                AnswerPermission(message["id"]?.GetValue<string>() ?? "", message["allow"]?.GetValue<bool>() ?? false,
                    message["always"]?.GetValue<bool>() ?? false);
                return true;
            case "ready": return true;
            default: return false;
        }
    }

    public void Send(string text) => Write(ClaudeChat.UserMessage(text));

    public void Stop()
    {
        if (process is not null) Write(ClaudeChat.Interrupt());
    }

    public void AnswerPermission(string requestId, bool allow, bool always)
    {
        JsonNode? request;
        lock (gate) { permissions.Remove(requestId, out request); }
        Write(ClaudeChat.PermissionResponse(requestId, request, allow, always, options.DenyMessage));
    }

    /// <summary>Ends the CLI and what it started. The next message resumes the session.</summary>
    public void Dispose()
    {
        var running = process;
        process = null;
        if (running is null) return;
        try { running.StandardInput.Close(); } catch (InvalidOperationException) { }
        try { if (!running.HasExited) running.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
    }

    private void Write(JsonNode message)
    {
        var running = process ?? Start();
        running.StandardInput.WriteLine(message.ToJsonString());
        running.StandardInput.Flush();
    }

    private static bool OnlyCmdOnPath(string command)
    {
        var folders = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator);
        bool Has(string extension) => folders.Any(folder => File.Exists(Path.Combine(folder, command + extension)));
        return !Has(".exe") && Has(".cmd");
    }

    private Process Start()
    {
        var resume = ClaudeChat.TranscriptPath(options.SessionId, options.Home) is not null;
        var info = new ProcessStartInfo
        {
            FileName = options.Command,
            WorkingDirectory = options.Directory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardInputEncoding = new UTF8Encoding(false),
        };
        // An npm install puts `claude.cmd` on the PATH, which a process cannot
        // start by itself: through cmd.exe. The native installer's claude.exe
        // starts as it is.
        if (OperatingSystem.IsWindows() && Path.GetExtension(options.Command) == "" && OnlyCmdOnPath(options.Command))
        {
            info.FileName = "cmd.exe";
            info.ArgumentList.Add("/c");
            info.ArgumentList.Add(options.Command + ".cmd");
        }
        foreach (var argument in ClaudeChat.CliArguments) info.ArgumentList.Add(argument);
        info.ArgumentList.Add(resume ? "--resume" : "--session-id");
        info.ArgumentList.Add(options.SessionId);
        foreach (var argument in options.ExtraArguments) info.ArgumentList.Add(argument);

        var started = new Process { StartInfo = info, EnableRaisingEvents = true };
        started.OutputDataReceived += (_, line) =>
        {
            if (string.IsNullOrEmpty(line.Data)) return;
            JsonNode? e;
            try { e = JsonNode.Parse(line.Data); } catch (JsonException) { return; }
            if (e is null) return;
            if (e["type"]?.GetValue<string>() == "control_request" &&
                e["request"]?["subtype"]?.GetValue<string>() == "can_use_tool" &&
                e["request_id"]?.GetValue<string>() is { } id)
            {
                lock (gate) { permissions[id] = e["request"]?.DeepClone(); }
            }
            if (ClaudeChat.Shown(e)) Event?.Invoke(e);
        };
        started.ErrorDataReceived += (_, _) => { };
        started.Exited += (_, _) =>
        {
            if (ReferenceEquals(process, started)) process = null;
            Event?.Invoke(new JsonObject { ["type"] = "exited" });
        };
        try
        {
            started.Start();
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Event?.Invoke(new JsonObject { ["type"] = "error", ["text"] = error.Message });
            throw;
        }
        started.BeginOutputReadLine();
        started.BeginErrorReadLine();
        process = started;
        return started;
    }
}
