//! A Claude Code session behind the chat page: the `claude` CLI in its
//! structured mode, one process per session, its events relayed to the page
//! and the page's messages turned into the CLI's input. See `PROTOCOL.md`.
//!
//! The crate only runs the session; any web view shows the page. The
//! `wry_window` example puts it in a window with wry, whose IPC the page's
//! `bridge.js` already speaks.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

/// The CLI's arguments for the structured mode, before the session's own.
pub const CLI_ARGS: [&str; 9] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
];

/// Where and how a session runs.
#[derive(Clone, Debug)]
pub struct Options {
    /// The session's id, a UUID the host keeps for this conversation.
    pub session_id: String,
    /// The folder the CLI runs in (its project).
    pub cwd: PathBuf,
    /// The `claude` executable; `claude` on the PATH by default.
    pub command: PathBuf,
    /// More CLI arguments, such as `--model` or `--append-system-prompt`.
    pub extra_args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// The home folder whose `.claude` holds the transcripts.
    pub home: Option<PathBuf>,
    /// The words sent back when the user denies a permission.
    pub deny_message: String,
}

impl Options {
    pub fn new(session_id: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            session_id: session_id.into(),
            cwd: cwd.into(),
            command: PathBuf::from("claude"),
            extra_args: Vec::new(),
            env: Vec::new(),
            home: None,
            deny_message: "The user denied this.".to_owned(),
        }
    }
}

fn home(given: Option<&Path>) -> Option<PathBuf> {
    given.map(Path::to_path_buf).or_else(|| {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
    })
}

/// The session's transcript, `~/.claude/projects/<project>/<id>.jsonl`.
pub fn transcript_path(session_id: &str, home_dir: Option<&Path>) -> Option<PathBuf> {
    let projects = home(home_dir)?.join(".claude").join("projects");
    std::fs::read_dir(projects)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join(format!("{session_id}.jsonl")))
        .find(|path| path.is_file())
}

/// The session's past, for `chat.history`: the user's messages and the
/// answers, with the tools and their results, without sub-agents' turns.
pub fn history(session_id: &str, home_dir: Option<&Path>) -> Vec<Value> {
    let Some(path) = transcript_path(session_id, home_dir) else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|record| {
            matches!(record["type"].as_str(), Some("user" | "assistant"))
                && record["isSidechain"] != Value::Bool(true)
                && record["isMeta"] != Value::Bool(true)
        })
        .map(|record| json!({ "type": record["type"], "message": { "content": record["message"]["content"] } }))
        .collect()
}

/// Whether a CLI line goes to the page: what it shows, not bookkeeping.
pub fn shown(event: &Value) -> bool {
    match event["type"].as_str() {
        Some("system") => event["subtype"] == "init",
        Some("stream_event" | "assistant" | "user" | "result" | "control_request") => true,
        _ => false,
    }
}

/// A message the user typed.
pub fn user_message(text: &str) -> Value {
    json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } })
}

/// Stops what the CLI is doing.
pub fn interrupt(request_id: &str) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": { "subtype": "interrupt" } })
}

/// The answer to a `can_use_tool` request: allowed as asked (and from now on,
/// with the CLI's own suggested rules, when `always`), or denied.
pub fn permission_response(request_id: &str, request: &Value, allow: bool, always: bool, deny_message: &str) -> Value {
    let response = if allow {
        let mut response = json!({
            "behavior": "allow",
            "updatedInput": request.get("input").cloned().unwrap_or_else(|| json!({})),
        });
        if always && let Some(suggestions) = request.get("permission_suggestions") {
            response["updatedPermissions"] = suggestions.clone();
        }
        response
    } else {
        json!({ "behavior": "deny", "message": deny_message })
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

/// What the page sends that the host handles itself (see
/// [`Session::handle_page_message`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostAction {
    /// Put this text on the clipboard.
    Copy(String),
    /// Open this URL.
    Link(String),
    /// Answer with `chat.insert(<clipboard>)`.
    Paste,
    /// The page is ready: answer with `chat.history`.
    Ready,
}

type Listener = Arc<dyn Fn(Value) + Send + Sync>;

/// One conversation's session. The listener gets, on a thread of the
/// session's, what goes to the page's `chat.events`; the process starts on
/// the first message.
pub struct Session {
    options: Options,
    listener: Listener,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    permissions: Arc<Mutex<HashMap<String, Value>>>,
    next_id: u64,
}

impl Session {
    pub fn new(options: Options, listener: impl Fn(Value) + Send + Sync + 'static) -> Self {
        Self {
            options,
            listener: Arc::new(listener),
            child: None,
            stdin: None,
            permissions: Arc::default(),
            next_id: 0,
        }
    }

    /// The past to hand `chat.history` when the page is ready.
    pub fn history(&self) -> Vec<Value> {
        history(&self.options.session_id, self.options.home.as_deref())
    }

    /// Handles a JSON message from the page: `send`, `stop` and `perm` go to
    /// the CLI; what the host does itself comes back as a [`HostAction`].
    pub fn handle_page_message(&mut self, text: &str) -> Option<HostAction> {
        let message: Value = serde_json::from_str(text).ok()?;
        let field = |name: &str| message[name].as_str().unwrap_or_default().to_owned();
        match message["t"].as_str()? {
            "send" => self.send(&field("text")),
            "stop" => self.stop(),
            "perm" => self.answer_permission(
                &field("id"),
                message["allow"].as_bool().unwrap_or(false),
                message["always"].as_bool().unwrap_or(false),
            ),
            "ready" => return Some(HostAction::Ready),
            "copy" => return Some(HostAction::Copy(field("d"))),
            "link" => return Some(HostAction::Link(field("d"))),
            "paste" => return Some(HostAction::Paste),
            _ => {}
        }
        None
    }

    pub fn send(&mut self, text: &str) {
        self.write(&user_message(text));
    }

    pub fn stop(&mut self) {
        if self.child.is_some() {
            self.next_id += 1;
            let id = format!("interrupt-{}", self.next_id);
            self.write(&interrupt(&id));
        }
    }

    pub fn answer_permission(&mut self, request_id: &str, allow: bool, always: bool) {
        let request = self
            .permissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(request_id)
            .unwrap_or(Value::Null);
        let answer = permission_response(request_id, &request, allow, always, &self.options.deny_message);
        self.write(&answer);
    }

    /// Ends the CLI. Nothing is lost: the next message resumes the session.
    pub fn close(&mut self) {
        drop(self.stdin.take());
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            std::thread::spawn(move || child.wait());
        }
    }

    fn write(&mut self, message: &Value) {
        if self.stdin.is_none() && !self.start() {
            return;
        }
        let written = self
            .stdin
            .as_mut()
            .is_some_and(|stdin| writeln!(stdin, "{message}").is_ok() && stdin.flush().is_ok());
        if !written {
            // The process ended: the next message starts it again.
            self.close();
            (self.listener)(json!({ "type": "exited" }));
        }
    }

    fn start(&mut self) -> bool {
        let options = &self.options;
        let resume = transcript_path(&options.session_id, options.home.as_deref()).is_some();
        let mut command = Command::new(&options.command);
        command
            .args(CLI_ARGS)
            .args([if resume { "--resume" } else { "--session-id" }, &options.session_id])
            .args(&options.extra_args)
            .envs(options.env.iter().cloned())
            .current_dir(&options.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // A group of its own, so ending it ends what it started.
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                (self.listener)(json!({ "type": "error", "text": error.to_string() }));
                return false;
            }
        };
        let stdout = child.stdout.take();
        self.stdin = child.stdin.take();
        self.child = Some(child);
        let listener = self.listener.clone();
        let permissions = self.permissions.clone();
        std::thread::spawn(move || {
            if let Some(stdout) = stdout {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let Ok(event) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if event["type"] == "control_request"
                        && event["request"]["subtype"] == "can_use_tool"
                        && let Some(id) = event["request_id"].as_str()
                    {
                        permissions
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .insert(id.to_owned(), event["request"].clone());
                    }
                    if shown(&event) {
                        listener(event);
                    }
                }
            }
            listener(json!({ "type": "exited" }));
        });
        true
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

/// A call into the page, `window.chat.<function>('<base64>')`: base64 of the
/// JSON, so nothing in it needs escaping in the script.
pub fn page_call(function: &str, events: &[Value]) -> String {
    let json = serde_json::to_string(events).unwrap_or_else(|_| "[]".to_owned());
    format!("window.chat.{function}('{}')", base64(json.as_bytes()))
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, byte)| n | (u32::from(*byte) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(TABLE[(n >> (18 - 6 * i) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_permission_is_answered_as_the_cli_asks() {
        let request = json!({ "subtype": "can_use_tool", "input": { "command": "ls" }, "permission_suggestions": [{ "type": "addRules" }] });
        let allowed = permission_response("r1", &request, true, false, "no");
        assert_eq!(allowed["response"]["request_id"], "r1");
        assert_eq!(allowed["response"]["response"]["updatedInput"]["command"], "ls");
        assert!(allowed["response"]["response"].get("updatedPermissions").is_none());
        let always = permission_response("r1", &request, true, true, "no");
        assert_eq!(always["response"]["response"]["updatedPermissions"][0]["type"], "addRules");
        let denied = permission_response("r1", &request, false, false, "no");
        assert_eq!(denied["response"]["response"], json!({ "behavior": "deny", "message": "no" }));
    }

    #[test]
    fn only_what_the_page_shows_goes_to_it() {
        assert!(shown(&json!({ "type": "system", "subtype": "init" })));
        assert!(!shown(&json!({ "type": "system", "subtype": "thinking_tokens" })));
        assert!(shown(&json!({ "type": "control_request" })));
        assert!(!shown(&json!({ "type": "rate_limit_event" })));
    }

    #[test]
    fn the_past_comes_from_the_transcript() {
        let home = std::env::temp_dir().join(format!("claude-chat-{}", std::process::id()));
        let project = home.join(".claude").join("projects").join("-x");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join("abc.jsonl"),
            [
                r#"{"type":"queue-operation"}"#,
                r#"{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}"#,
                r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"sub"}]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let past = history("abc", Some(&home));
        assert_eq!(past.len(), 2);
        assert_eq!(past[1]["message"]["content"][0]["text"], "hello");
        assert!(history("none", Some(&home)).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn page_calls_carry_base64_json() {
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64("ação".as_bytes()), "YcOnw6Nv");
        assert_eq!(page_call("events", &[]), "window.chat.events('W10=')");
    }

    #[test]
    fn host_actions_come_back_to_the_host() {
        let mut session = Session::new(Options::new("x", "."), |_| {});
        assert_eq!(session.handle_page_message(r#"{"t":"ready"}"#), Some(HostAction::Ready));
        assert_eq!(session.handle_page_message(r#"{"t":"link","d":"https://a"}"#), Some(HostAction::Link("https://a".into())));
        assert_eq!(session.handle_page_message("not json"), None);
    }
}
