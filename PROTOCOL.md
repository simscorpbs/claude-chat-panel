# Protocol

The panel has three parts. Each talks only to the one beside it.

```
 page (web/)  ⇄  host (your app)  ⇄  claude CLI (one process per session)
```

The page renders. The host owns the process, the session id and the
clipboard. The CLI is Claude Code itself, run in its structured mode, which is
the same interface the Claude apps and the Agent SDK use.

## Host ⇄ CLI

Start the CLI in the session's folder with:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --include-partial-messages --permission-prompt-tool stdio \
       (--session-id <uuid> | --resume <uuid>) [more arguments]
```

- Use `--session-id <uuid>` the first time and `--resume <uuid>` once the
  transcript exists (`~/.claude/projects/<project>/<uuid>.jsonl`).
- Any other flag passes through, for example `--model`,
  `--append-system-prompt`, `--add-dir` or `--permission-mode`.
- One JSON object goes per line, on stdin and on stdout.
- Discard stderr.
- End the process when the conversation closes. Nothing is lost: the next
  message resumes from the transcript.

### What the host writes

A message the user typed:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
```

To stop what the CLI is doing:

```json
{"type":"control_request","request_id":"<any id>","request":{"subtype":"interrupt"}}
```

The answer to a permission request (see below):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<the request's id>",
  "response":{"behavior":"allow","updatedInput":<the request's input>}}}
```

- **Always allow** also sends `"updatedPermissions": <the request's
  permission_suggestions>`.
- **Deny** sends `{"behavior":"deny","message":"…"}`.

### What the host reads

Forward these lines to the page. Keep the rest to yourself.

| `type` | When |
|---|---|
| `system` with `subtype: "init"` | The session started; it carries `model`. |
| `stream_event` | A piece of the answer as it streams (`content_block_delta` / `text_delta`). |
| `assistant` | A whole turn of the answer: text blocks and `tool_use` blocks. |
| `user` | The `tool_result` blocks of the tools the session used. |
| `control_request` with `request.subtype: "can_use_tool"` | A permission the session asks for. Keep the `request` by its `request_id`: the answer needs its `input` and `permission_suggestions`. |
| `result` | The turn ended. It carries `total_cost_usd`, and `is_error` when the turn failed or was stopped. |

The host also sends two events of its own:
- `{"type":"exited"}` when the process ends;
- `{"type":"error","text":"…"}` when it cannot start.

## Host → page

The host calls these functions in the page. Each takes an array of events,
given as an array, as a JSON string, or as base64 of a JSON string.

- **`window.chat.events(payload)`**: events from the CLI, as listed above.
- **`window.chat.history(payload)`**: the session's past, sent once after the
  page says `ready`. These are the transcript's `user` and `assistant`
  records, without sub-agents (`isSidechain`) or meta records (`isMeta`),
  each as `{"type":…,"message":{"content":…}}`.
- **`window.chat.insert(text)`**: puts text in the message field at the cursor.
- **`window.chat.focus()`**: focuses the message field.

Base64 is the simplest choice from a native host, because nothing inside it
needs escaping in the script string.

## Page → host

The page posts JSON strings through the transport it finds (`web/bridge.js`):

| Host | The page calls | The host listens with |
|---|---|---|
| WKWebView | `webkit.messageHandlers.chat.postMessage` | `WKScriptMessageHandler` named `chat` |
| WebView2 | `chrome.webview.postMessage` | `CoreWebView2.WebMessageReceived` |
| wry / Tauri | `window.ipc.postMessage` | the IPC handler |
| a plain browser | `POST post` (relative URL) | an HTTP endpoint; host-to-page goes over Server-Sent Events on `events`, as `{"kind":"events"\|"history"\|"insert"\|"focus","payload":…}` |

The messages are:

| `t` | Fields | The host |
|---|---|---|
| `ready` | | sends `chat.history` |
| `send` | `text` | writes a user message (starting the process first if needed) |
| `stop` | | writes an interrupt |
| `perm` | `id`, `allow`, `always` | writes the permission answer |
| `copy` | `d` | puts `d` on the clipboard, when the page could not |
| `link` | `d` | opens the URL |
| `paste` | | answers with `chat.insert(<clipboard>)` (only with `hostClipboard`) |
