// The page's only link to its host. The chat script (chat.js) calls
// `ChatBridge.post(message)`; the host answers by calling `window.chat.*`
// (see PROTOCOL.md). The transport is picked from what the page finds:
//
//   WKWebView (Swift)    window.webkit.messageHandlers.chat.postMessage
//   WebView2 (C#)        window.chrome.webview.postMessage
//   wry / Tauri (Rust)   window.ipc.postMessage
//   a plain browser      HTTP: POST /post, Server-Sent Events from /events
//                        (the Node host's `serve` command)
(function () {
  'use strict';

  function nativeSender() {
    const webkit = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.chat;
    if (webkit) return text => webkit.postMessage(text);
    const webview2 = window.chrome && window.chrome.webview;
    if (webview2) return text => webview2.postMessage(text);
    if (window.ipc && typeof window.ipc.postMessage === 'function') return text => window.ipc.postMessage(text);
    return null;
  }

  let send = nativeSender();

  if (!send) {
    // A plain browser: the host is an HTTP server.
    send = text => fetch('post', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
    const stream = new EventSource('events');
    stream.onmessage = event => {
      const { kind, payload } = JSON.parse(event.data);
      if (kind === 'events') window.chat.events(payload);
      else if (kind === 'history') window.chat.history(payload);
      else if (kind === 'insert') window.chat.insert(payload);
      else if (kind === 'focus') window.chat.focus();
    };
  }

  window.ChatBridge = { post: message => send(JSON.stringify(message)) };
})();
