// A Claude Code session behind the chat page: the `claude` CLI in its
// structured mode, one process per session, its events relayed to the page
// and the page's messages turned into the CLI's input. See ../../PROTOCOL.md.
//
// No dependencies. Node 22.6+ runs this file as is (type stripping); older
// versions can compile it with `tsc`.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** The CLI's arguments for the structured mode, before the session's own. */
export const CLI_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-prompt-tool', 'stdio',
];

/** A line the CLI wrote, or an event of the host's own (`exited`, `error`). */
export type CliEvent = { type: string; [key: string]: unknown };

/** What the page sends (PROTOCOL.md, "Page to host"). */
export type PageMessage =
  | { t: 'ready' }
  | { t: 'send'; text: string }
  | { t: 'stop' }
  | { t: 'perm'; id: string; allow: boolean; always: boolean }
  | { t: 'copy'; d: string }
  | { t: 'link'; d: string }
  | { t: 'paste' };

export interface SessionOptions {
  /** The session's id, a UUID the host keeps for this conversation. */
  sessionId: string;
  /** The folder the CLI runs in (its project). */
  cwd: string;
  /** The `claude` executable; `claude` on the PATH by default. */
  command?: string;
  /** More CLI arguments, such as `--model` or `--append-system-prompt`. */
  extraArgs?: string[];
  env?: Record<string, string>;
  /** The home folder whose `.claude` holds the transcripts. */
  home?: string;
  /** The words sent back when the user denies a permission. */
  denyMessage?: string;
}

/** A new session id. */
export function newSessionId(): string {
  return randomUUID();
}

/** The session's transcript, `~/.claude/projects/<project>/<id>.jsonl`. */
export function transcriptPath(sessionId: string, home: string = homedir()): string | undefined {
  const projects = join(home, '.claude', 'projects');
  if (!existsSync(projects)) return undefined;
  for (const project of readdirSync(projects)) {
    const path = join(projects, project, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** The session's past, for `chat.history`: the user's messages and the
 *  answers, with the tools and their results, without sub-agents' turns. */
export function readHistory(sessionId: string, home?: string): CliEvent[] {
  const path = transcriptPath(sessionId, home);
  if (!path) return [];
  const records: CliEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    if ((record.type === 'user' || record.type === 'assistant') && !record.isSidechain && !record.isMeta) {
      records.push({ type: record.type, message: { content: record.message?.content } });
    }
  }
  return records;
}

/** Whether a CLI line goes to the page: what it shows, not bookkeeping. */
export function shown(event: CliEvent): boolean {
  switch (event.type) {
    case 'system': return event.subtype === 'init';
    case 'stream_event': case 'assistant': case 'user': case 'result': case 'control_request': return true;
    default: return false;
  }
}

/** A message the user typed. */
export function userMessage(text: string): object {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** Stops what the CLI is doing. */
export function interrupt(requestId: string = randomUUID()): object {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

/** The answer to a `can_use_tool` request: allowed as asked (and from now on,
 *  with the CLI's own suggested rules, when `always`), or denied. */
export function permissionResponse(
  requestId: string, request: any, allow: boolean, always: boolean, denyMessage = 'The user denied this.',
): object {
  let response: any;
  if (allow) {
    response = { behavior: 'allow', updatedInput: request?.input ?? {} };
    if (always && request?.permission_suggestions) response.updatedPermissions = request.permission_suggestions;
  } else {
    response = { behavior: 'deny', message: denyMessage };
  }
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

/** One conversation's session. `onEvent` gets what goes to the page's
 *  `chat.events`; the process starts on the first message. */
export class ClaudeChatSession {
  private child: ChildProcess | undefined;
  private readonly permissions = new Map<string, any>();
  private readonly options: SessionOptions;
  private readonly onEvent: (event: CliEvent) => void;

  constructor(options: SessionOptions, onEvent: (event: CliEvent) => void) {
    this.options = options;
    this.onEvent = onEvent;
  }

  /** The past to hand `chat.history` when the page is ready. */
  history(): CliEvent[] {
    return readHistory(this.options.sessionId, this.options.home);
  }

  /** Handles a message from the page. `copy`, `link` and `paste` are the
   *  host's to handle; this returns false for them. */
  handlePageMessage(message: PageMessage): boolean {
    switch (message.t) {
      case 'send': this.send(message.text); return true;
      case 'stop': this.stop(); return true;
      case 'perm': this.answerPermission(message.id, message.allow, message.always); return true;
      case 'ready': return true;
      default: return false;
    }
  }

  send(text: string): void {
    this.write(userMessage(text));
  }

  stop(): void {
    if (this.child) this.write(interrupt());
  }

  answerPermission(requestId: string, allow: boolean, always: boolean): void {
    const request = this.permissions.get(requestId);
    this.permissions.delete(requestId);
    this.write(permissionResponse(requestId, request, allow, always, this.options.denyMessage));
  }

  /** Ends the CLI and what it started. Nothing is lost: the next message
   *  resumes the session from its transcript. */
  close(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin?.end();
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch { /* already gone */ }
  }

  private write(message: object): void {
    const child = this.child ?? this.start();
    child.stdin?.write(JSON.stringify(message) + '\n');
  }

  private start(): ChildProcess {
    const { sessionId, cwd, command = 'claude', extraArgs = [], env, home } = this.options;
    // A session with a transcript resumes; a new one takes its id.
    const own = transcriptPath(sessionId, home) ? ['--resume', sessionId] : ['--session-id', sessionId];
    const child = spawn(command, [...CLI_ARGS, ...own, ...extraArgs], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
      // A group of its own, so closing ends what it started.
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32',
    });
    this.child = child;
    createInterface({ input: child.stdout! }).on('line', line => {
      let event: CliEvent;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'control_request' && (event as any).request?.subtype === 'can_use_tool') {
        this.permissions.set((event as any).request_id, (event as any).request);
      }
      if (shown(event)) this.onEvent(event);
    });
    child.on('error', error => this.onEvent({ type: 'error', text: String(error.message || error) }));
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
      this.onEvent({ type: 'exited' });
    });
    return child;
  }
}
