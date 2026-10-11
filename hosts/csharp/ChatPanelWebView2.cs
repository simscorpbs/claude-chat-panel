// The chat page in a WebView2 control, wired to a ClaudeChatSession.
// Needs the Microsoft.Web.WebView2 package; compiled only when the project
// defines WEBVIEW2 (see ClaudeChatPanel.csproj).

#if WEBVIEW2
using System.Text;
using System.Threading;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace ClaudeChatPanel;

public sealed class ChatPanelWebView2
{
    private readonly CoreWebView2 web;
    private readonly ClaudeChatSession session;
    private readonly SynchronizationContext? ui = SynchronizationContext.Current;

    /// <summary>Wires <paramref name="web"/> (an initialised CoreWebView2) to <paramref name="session"/>
    /// and opens the page from <paramref name="webFolder"/> (this repository's <c>web</c>).</summary>
    public ChatPanelWebView2(CoreWebView2 web, ClaudeChatSession session, string webFolder,
        IReadOnlyDictionary<string, string>? strings = null)
    {
        this.web = web;
        this.session = session;
        if (strings is not null)
        {
            var json = new JsonObject();
            foreach (var (key, value) in strings) json[key] = value;
            _ = web.AddScriptToExecuteOnDocumentCreatedAsync($"window.CHAT_STRINGS = {json.ToJsonString()};");
        }
        web.SetVirtualHostNameToFolderMapping("chat.local", webFolder, CoreWebView2HostResourceAccessKind.Allow);
        web.WebMessageReceived += (_, args) => Receive(args.TryGetWebMessageAsString());
        session.Event += e => OnUi(() => Call("events", new JsonArray(e.DeepClone())));
        web.Navigate("https://chat.local/index.html");
    }

    /// <summary>What the host does with <c>link</c> (open it) and <c>copy</c>; the defaults
    /// open the default browser and use the clipboard through the page.</summary>
    public Action<string> OpenLink { get; set; } =
        url => System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });

    public Action<string>? Copy { get; set; }

    private void Receive(string text)
    {
        var message = JsonNode.Parse(text);
        if (message is null) return;
        switch (message["t"]?.GetValue<string>())
        {
            case "ready": Call("history", session.History()); break;
            case "link": OpenLink(message["d"]?.GetValue<string>() ?? ""); break;
            case "copy": Copy?.Invoke(message["d"]?.GetValue<string>() ?? ""); break;
            default: session.HandlePageMessage(message); break;
        }
    }

    private void Call(string function, JsonNode events)
    {
        // Base64 of the JSON, so nothing in it needs escaping in the script.
        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(events.ToJsonString()));
        _ = web.ExecuteScriptAsync($"window.chat.{function}('{b64}')");
    }

    private void OnUi(Action action)
    {
        if (ui is null) action(); else ui.Post(_ => action(), null);
    }
}
#endif
