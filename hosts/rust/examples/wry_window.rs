//! The chat in a window: tao for the window, wry for the web view, the page
//! from this repository's `web/` through a custom protocol.
//!
//!   cargo run --example wry_window -- /path/to/project [--model haiku]

use std::path::PathBuf;

use claude_chat_panel::{HostAction, Options, Session, page_call};
use serde_json::Value;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;
use wry::http::{Response, header::CONTENT_TYPE};

/// What reaches the window's thread: a session event, or a page message.
enum Message {
    Cli(Value),
    Page(String),
}

fn main() -> wry::Result<()> {
    let mut args = std::env::args().skip(1);
    let cwd = args.next().unwrap_or_else(|| ".".to_owned());
    let mut options = Options::new(new_id(), cwd);
    options.extra_args = args.collect();
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web");

    let event_loop = EventLoopBuilder::<Message>::with_user_event().build();
    let to_window = event_loop.create_proxy();
    let mut session = Session::new(options, move |event| {
        let _ = to_window.send_event(Message::Cli(event));
    });
    let window = WindowBuilder::new()
        .with_title("Claude")
        .with_inner_size(tao::dpi::LogicalSize::new(820.0, 900.0))
        .build(&event_loop)
        .expect("a window");
    let to_window = event_loop.create_proxy();
    let builder = WebViewBuilder::new()
        .with_custom_protocol("chat".into(), move |_, request| {
            let path = request.uri().path().trim_start_matches('/');
            let path = if path.is_empty() { "index.html" } else { path };
            let file = web.join(path);
            let kind = match file.extension().and_then(|ext| ext.to_str()) {
                Some("html") => "text/html",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                _ => "application/octet-stream",
            };
            let body = if path.contains("..") { Vec::new() } else { std::fs::read(file).unwrap_or_default() };
            Response::builder().header(CONTENT_TYPE, kind).body(body.into()).expect("a response")
        })
        .with_url(if cfg!(windows) { "http://chat.localhost/" } else { "chat://localhost/" })
        .with_ipc_handler(move |request| {
            let _ = to_window.send_event(Message::Page(request.body().clone()));
        });
    #[cfg(not(target_os = "linux"))]
    let webview = builder.build(&window)?;
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().expect("a box"))?
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Message::Cli(event)) => {
                let _ = webview.evaluate_script(&page_call("events", &[event]));
            }
            Event::UserEvent(Message::Page(text)) => match session.handle_page_message(&text) {
                Some(HostAction::Ready) => {
                    let _ = webview.evaluate_script(&page_call("history", &session.history()));
                }
                Some(HostAction::Link(url)) => println!("link: {url}"),
                Some(HostAction::Copy(_) | HostAction::Paste) | None => {}
            },
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                session.close();
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

/// A random version-4 UUID, without a dependency.
fn new_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_mut(8) {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        chunk.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}
