//! The session without the page: sends one message and prints the answer as
//! it streams.
//!
//!   cargo run --example stream -- "your question" [folder] [claude arguments…]

use std::sync::mpsc;

use claude_chat_panel::{Options, Session};

fn main() {
    let mut args = std::env::args().skip(1);
    let question = args.next().unwrap_or_else(|| "Say hello in one short sentence.".to_owned());
    let folder = args.next().unwrap_or_else(|| ".".to_owned());
    let session_id = format!("00000000-0000-4000-8000-{:012x}", std::process::id());
    let mut options = Options::new(session_id, folder);
    options.extra_args = args.collect();

    let (events, received) = mpsc::channel();
    let mut session = Session::new(options, move |event| {
        let _ = events.send(event);
    });
    session.send(&question);
    for event in received {
        match event["type"].as_str() {
            Some("stream_event") => {
                if let Some(text) = event["event"]["delta"]["text"].as_str() {
                    print!("{text}");
                }
            }
            Some("result") => {
                println!("\n[done, US$ {}]", event["total_cost_usd"]);
                break;
            }
            Some("error" | "exited") => {
                println!("\n[{}]", event["text"].as_str().unwrap_or("the session ended"));
                break;
            }
            _ => {}
        }
    }
    session.close();
}
