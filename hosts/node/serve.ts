// The chat in a plain browser: an HTTP server that serves the page (web/)
// and relays it to one Claude Code session over Server-Sent Events and POST.
// For trying the page, and for hosts whose web view loads a URL (Electron,
// a WebView pointed at localhost). Listens on 127.0.0.1 only.
//
//   node hosts/node/serve.ts --cwd ~/my-project [--session <uuid>] [--port 4318]
//        [-- <more claude arguments, such as --model haiku>]

import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeChatSession, newSessionId, type CliEvent, type PageMessage } from './claude-chat.ts';

const args = process.argv.slice(2);
const split = args.indexOf('--');
const own = split >= 0 ? args.slice(0, split) : args;
const extraArgs = split >= 0 ? args.slice(split + 1) : [];
const option = (name: string) => { const i = own.indexOf(name); return i >= 0 ? own[i + 1] : undefined; };

const cwd = (option('--cwd') ?? process.cwd()).replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
const sessionId = option('--session') ?? newSessionId();
const port = Number(option('--port') ?? 4318);
const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

const clients = new Set<ServerResponse>();
const push = (kind: string, payload: unknown) => {
  const data = `data: ${JSON.stringify({ kind, payload })}\n\n`;
  for (const client of clients) client.write(data);
};
const session = new ClaudeChatSession({ sessionId, cwd, extraArgs }, (event: CliEvent) => push('events', [event]));

const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(response);
    request.on('close', () => clients.delete(response));
    response.write(`data: ${JSON.stringify({ kind: 'history', payload: session.history() })}\n\n`);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/post') {
    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      const message = JSON.parse(body) as PageMessage;
      if (!session.handlePageMessage(message) && message.t === 'link') console.log('link:', message.d);
    } catch { /* not a message */ }
    response.writeHead(204).end();
    return;
  }
  const path = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  if (path.includes('..')) { response.writeHead(400).end(); return; }
  try {
    const file = await readFile(join(web, path));
    response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(file);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`chat on http://127.0.0.1:${port}/  (session ${sessionId}, folder ${cwd})`);
});

process.on('SIGINT', () => { session.close(); process.exit(0); });
