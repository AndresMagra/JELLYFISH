import type { FetchLike, Logger } from '../src/services/http-util';

export interface Call {
  url: string;
  init: RequestInit;
}
export type Reply = Response | Error | ((call: Call) => Promise<Response> | Response);

/** `fetch` falso: responde en orden lo que se le programe (repite el último) y recuerda cada llamada. */
export function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(call);
    return reply.clone();
  }) as unknown as FetchLike;
  return { fetch, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Se cuelga hasta que quien llama aborte la petición, como un servidor que no contesta. */
export const hang: Reply = (call) =>
  new Promise((_, reject) => {
    call.init.signal!.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted', 'AbortError')),
    );
  });

export function recordingLogger() {
  const entries: { level: 'warn' | 'error'; obj: Record<string, unknown>; msg: string }[] = [];
  const logger: Logger = {
    warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
  };
  return { logger, entries, dump: () => JSON.stringify(entries) };
}
