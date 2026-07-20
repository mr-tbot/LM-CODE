import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { LMServerConfig } from './config';

export interface LMStudioModel {
    id: string;
    object?: string;
    owned_by?: string;
    /** Server this model belongs to. */
    serverId: string;
    /** 'llm' | 'vlm' | 'embeddings' (from /api/v0/models; undefined when only /v1/models is available). */
    type?: string;
    /** 'loaded' | 'not-loaded' */
    state?: string;
    /** Model's maximum supported context length. */
    maxContextLength?: number;
    /** Context length the model is currently loaded with (if reported). */
    loadedContextLength?: number;
    /** LM Studio capability flags, e.g. ['tool_use']. */
    capabilities?: string[];
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** Plain text, or multi-part content (text + images) for vision models. */
    content: string | ContentPart[];
    /** Set on assistant messages that invoked tools. */
    tool_calls?: ToolCall[];
    /** Required on role:'tool' messages — id of the assistant tool_call this responds to. */
    tool_call_id?: string;
    /** Optional name for role:'tool' messages. */
    name?: string;
}

export interface ToolDef {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: any;
    };
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stop?: string | string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    tools?: ToolDef[];
    tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

export interface StreamCallbacks {
    onText: (text: string) => void;
    onToolCall: (call: ToolCall) => void;
    /** Reasoning/thinking deltas (Qwen3, DeepSeek R1, ...). Optional — dropped when absent. */
    onReasoning?: (text: string) => void;
}

/** Turn an HTTP error body (JSON or HTML) into a short readable message. */
export function formatHttpError(status: number | undefined, body: string): string {
    const text = (body ?? '').trim();
    // JSON error payloads: {"error":{"message":...}} or {"error":"..."} or {"message":"..."}
    try {
        const j = JSON.parse(text);
        const msg = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : undefined) ?? j?.message;
        if (typeof msg === 'string' && msg.length > 0) {
            return `LM Studio error (HTTP ${status}): ${msg}`;
        }
    } catch { /* not JSON */ }
    // HTML error pages (Express 500s) — extract <pre> or strip tags.
    if (/<!DOCTYPE|<html/i.test(text)) {
        const pre = text.match(/<pre>([\s\S]*?)<\/pre>/i);
        const inner = (pre ? pre[1] : text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        return `LM Studio error (HTTP ${status}): ${inner || 'Internal Server Error'} — check the LM Studio server logs.`;
    }
    return `LM Studio error (HTTP ${status}): ${text.slice(0, 300) || 'no response body'}`;
}

export class LMStudioClient {
    constructor(private readonly server: LMServerConfig) {}

    private timeoutMs(): number {
        // Generous default: JIT model loads can take minutes before the first token.
        const t = this.server.timeoutMs ?? 0;
        return t > 0 ? t : 300000;
    }

    async listModels(): Promise<LMStudioModel[]> {
        // Prefer LM Studio's richer REST API (context lengths, capabilities, model type).
        try {
            const res = await this.request('GET', '/api/v0/models');
            const data = JSON.parse(res);
            const items: any[] = data.data ?? [];
            if (Array.isArray(items) && items.length > 0 && items.some(m => m.type !== undefined)) {
                return items
                    .filter(m => m.type !== 'embeddings')
                    .map(m => ({
                        id: m.id ?? m.name,
                        object: m.object,
                        owned_by: m.owned_by ?? m.publisher,
                        serverId: this.server.id,
                        type: m.type,
                        state: m.state,
                        maxContextLength: typeof m.max_context_length === 'number' ? m.max_context_length : undefined,
                        loadedContextLength: typeof m.loaded_context_length === 'number' ? m.loaded_context_length : undefined,
                        capabilities: Array.isArray(m.capabilities) ? m.capabilities : undefined
                    }));
            }
        } catch { /* fall back to the OpenAI-compatible endpoint */ }

        const res = await this.request('GET', '/v1/models');
        const data = JSON.parse(res);
        const items: any[] = data.data ?? data.models ?? [];
        return items
            .map(m => ({
                id: m.id ?? m.name,
                object: m.object,
                owned_by: m.owned_by,
                serverId: this.server.id
            }))
            .filter(m => !/embed/i.test(m.id ?? ''));
    }

    async testConnection(): Promise<{ ok: boolean; message: string; modelCount?: number }> {
        try {
            const models = await this.listModels();
            return { ok: true, message: `Connected. ${models.length} model(s) available.`, modelCount: models.length };
        } catch (err: any) {
            return { ok: false, message: err?.message ?? String(err) };
        }
    }

    /** Streaming chat completion. Emits text chunks and finalized tool calls.
     *  Transient model-load failures (JIT load races, LM Link drops) are retried once,
     *  but only when no output has been emitted yet. Pass noTransientRetry when the
     *  caller does its own failover and wants single attempts. */
    async chat(req: ChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal, opts?: { noTransientRetry?: boolean }): Promise<void> {
        let anyOutput = false;
        const tracking: StreamCallbacks = {
            onText: t => { anyOutput = true; callbacks.onText(t); },
            onToolCall: c => { anyOutput = true; callbacks.onToolCall(c); },
            onReasoning: callbacks.onReasoning
                ? t => { anyOutput = true; callbacks.onReasoning!(t); }
                : undefined
        };
        try {
            await this.chatOnce(req, tracking, signal);
        } catch (err: any) {
            const msg = String(err?.message ?? err);
            // "Internal Server Error" HTML 500s are what flaky LM Link hops surface as.
            const transient = /failed to load model|lm link|no models loaded|model unloaded|internal server error|ended mid-tool-call/i.test(msg);
            if (!transient || anyOutput || signal?.aborted || opts?.noTransientRetry) throw err;
            await new Promise(r => setTimeout(r, 2500));
            // The user may have cancelled during the backoff — don't fire a zombie retry.
            if (signal?.aborted) throw err;
            await this.chatOnce(req, tracking, signal);
        }
    }

    private async chatOnce(req: ChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
        const body = JSON.stringify({ ...req, stream: true });
        // Accumulate streaming OpenAI-format tool_calls by index.
        const pending = new Map<number, { id: string; name: string; args: string; emitted: boolean }>();
        // Parse native model markup (`<tool_call>...`, '```tool_code', etc.) from delta.content.
        let emittedToolCall = false;
        let emittedText = false;
        const wrapped: StreamCallbacks = {
            onText: t => { emittedText = true; callbacks.onText(t); },
            onToolCall: c => { emittedToolCall = true; callbacks.onToolCall(c); },
            onReasoning: callbacks.onReasoning
        };
        const textParser = new NativeToolCallParser(wrapped, {
            // Some local model builds emit the tool call as bare JSON text with no
            // markup — only worth looking for when the request actually offered tools.
            bareJson: Array.isArray(req.tools) && req.tools.length > 0
        });
        let streamError: string | undefined;
        let currentEvent = '';
        let reasoningChars = 0;
        let lastFinishReason: string | undefined;

        let truncatedCall = false;
        const flushPending = (endOfStream = false) => {
            for (const slot of pending.values()) {
                if (slot.emitted || !slot.name) continue;
                if (endOfStream && slot.args && !jsonParses(slot.args)) {
                    // Stream died mid-arguments (no finish_reason, args cut off) —
                    // a broken tool call is worse than an error.
                    truncatedCall = true;
                    continue;
                }
                slot.emitted = true;
                wrapped.onToolCall({
                    id: slot.id || randomCallId(),
                    type: 'function',
                    function: { name: slot.name, arguments: slot.args || '{}' }
                });
            }
        };

        await this.streamingRequest('POST', '/v1/chat/completions', body, line => {
            // SSE event type lines ("event: error") change how the next data line is read.
            const evt = line.match(/^event:\s*(\S+)/);
            if (evt) { currentEvent = evt[1]; return; }
            if (!line.startsWith('data:')) return;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') { currentEvent = ''; return; }
            try {
                const json = JSON.parse(payload);
                // Error events (and inline error payloads) — LM Studio emits these mid-stream
                // e.g. {"error":{"message":"Model unloaded."}}
                if (currentEvent === 'error' || json.error) {
                    const msg = json?.error?.message ?? json?.message ??
                        (typeof json?.error === 'string' ? json.error : JSON.stringify(json.error ?? json));
                    streamError = String(msg);
                    currentEvent = '';
                    return;
                }
                currentEvent = '';
                const choice = json.choices?.[0];
                if (!choice) return;
                const delta = choice.delta ?? {};
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                    textParser.push(delta.content);
                }
                // Reasoning/thinking channel (Qwen3, DeepSeek R1, GLM, ...) — never user-facing text.
                const reasoning = delta.reasoning_content ?? delta.reasoning;
                if (typeof reasoning === 'string' && reasoning.length > 0) {
                    reasoningChars += reasoning.length;
                    wrapped.onReasoning?.(reasoning);
                }
                const tcs: any[] | undefined = delta.tool_calls;
                if (Array.isArray(tcs)) {
                    for (const tc of tcs) {
                        const idx = typeof tc.index === 'number' ? tc.index : 0;
                        let slot = pending.get(idx);
                        if (!slot) {
                            slot = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '', emitted: false };
                            pending.set(idx, slot);
                        }
                        if (tc.id) slot.id = tc.id;
                        if (tc.function?.name) slot.name = tc.function.name;
                        if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
                    }
                }
                // finish_reason can arrive in a chunk without a delta — check it independently.
                if (choice.finish_reason) {
                    lastFinishReason = choice.finish_reason;
                    flushPending();
                }
            } catch {
                // Malformed chunk. If it was flagged as an error event, keep the raw
                // payload as the error; either way clear the sticky event state so the
                // next well-formed chunk isn't misread.
                if (currentEvent === 'error' && !streamError) streamError = payload.slice(0, 300);
                currentEvent = '';
            }
        }, signal);

        // Flush any trailing buffered native markup as text or tool calls — unless the
        // stream died and nothing was emitted yet: then the buffer is a truncated
        // fragment, and emitting it would both show garbage and mark the request as
        // partially-answered (blocking clean retry/failover upstream).
        if (streamError && !emittedText && !emittedToolCall) {
            textParser.discardPending();
        } else {
            textParser.flush();
        }
        // Safety net: emit any OpenAI-format tool calls that never got a finish_reason.
        flushPending(true);

        if (streamError && !emittedToolCall) {
            // Surface stream errors unless a tool call already went out (breaking the
            // agent turn at that point would lose the successful call).
            throw new Error(`LM Studio stream error: ${streamError}`);
        }
        if (truncatedCall && !emittedToolCall) {
            throw new Error(`LM Studio stream error: ${streamError ?? 'response ended mid-tool-call (connection dropped)'}`);
        }
        if (!emittedText && !emittedToolCall && (reasoningChars > 0 || textParser.discardedChars > 0)) {
            // The model produced only hidden reasoning (reasoning_content or <think> text)
            // and no answer — tell the user instead of showing silence.
            const why = lastFinishReason === 'length'
                ? 'used its entire output budget on hidden reasoning'
                : 'produced only hidden reasoning';
            callbacks.onText(`[LM-CODE] The model ${why} and no answer. Try again, increase max output tokens, or use a lower-reasoning model.`);
        }
    }

    // ---- internals ----

    private request(method: string, path: string, body?: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = new URL(this.server.baseUrl + path);
            const lib = url.protocol === 'https:' ? https : http;
            const opts: http.RequestOptions = {
                method,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                headers: this.buildHeaders(body),
                timeout: this.timeoutMs()
            };
            const req = lib.request(opts, res => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if ((res.statusCode ?? 0) >= 400) {
                        reject(new Error(formatHttpError(res.statusCode, text)));
                    } else {
                        resolve(text);
                    }
                });
                res.on('error', reject);
                res.on('aborted', () => reject(new Error('Connection closed prematurely')));
            });
            req.on('timeout', () => req.destroy(new Error(`Request timed out after ${this.timeoutMs()}ms`)));
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }

    private streamingRequest(method: string, path: string, body: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            // A listener added to an already-aborted signal never fires — check up front.
            if (signal?.aborted) { reject(new Error('Aborted')); return; }
            const url = new URL(this.server.baseUrl + path);
            const lib = url.protocol === 'https:' ? https : http;
            const opts: http.RequestOptions = {
                method,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                headers: this.buildHeaders(body),
                // Socket-idle timeout. Generous: JIT model loads produce no bytes for a
                // long time before the first token (observed >100s for large models).
                timeout: this.timeoutMs()
            };
            const req = lib.request(opts, res => {
                if ((res.statusCode ?? 0) >= 400) {
                    const chunks: Buffer[] = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => reject(new Error(formatHttpError(res.statusCode, Buffer.concat(chunks).toString('utf8')))));
                    res.on('error', reject);
                    res.on('aborted', () => reject(new Error('Connection closed prematurely')));
                    return;
                }
                let buf = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    buf += chunk;
                    let idx;
                    while ((idx = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, idx).trim();
                        buf = buf.slice(idx + 1);
                        if (line) onLine(line);
                    }
                });
                res.on('end', () => {
                    if (buf.trim()) onLine(buf.trim());
                    resolve();
                });
                res.on('error', reject);
                res.on('aborted', () => reject(new Error('Connection closed prematurely')));
            });
            signal?.addEventListener('abort', () => req.destroy(new Error('Aborted')));
            req.on('timeout', () => req.destroy(new Error(`Request timed out after ${this.timeoutMs()}ms (no data received — the model may still be loading; raise the server timeout in LM-CODE settings)`)));
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    private buildHeaders(body?: string): Record<string, string> {
        const h: Record<string, string> = {
            'Accept': 'application/json',
            ...(this.server.headers ?? {})
        };
        if (body) {
            h['Content-Type'] = 'application/json';
            h['Content-Length'] = Buffer.byteLength(body).toString();
        }
        if (this.server.apiKey) {
            h['Authorization'] = `Bearer ${this.server.apiKey}`;
        }
        return h;
    }
}

function randomCallId(): string {
    return `call_${Math.random().toString(36).slice(2, 10)}`;
}

function jsonParses(s: string): boolean {
    try { JSON.parse(s); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Native tool-call markup parser.
// Many local models emit tool calls inside plain text rather than via OpenAI's
// `tool_calls` field. LM Studio parses most well-known templates server-side,
// but models with custom/broken templates leak their native dialect into
// `delta.content`. This parser inspects the streaming text, extracts tool-call
// payloads in any of the known dialects, and emits them via the same
// `onToolCall` callback so the rest of the bridge doesn't care about dialects.
//
// Supported dialects:
//   Hermes/Qwen         <tool_call>{"name":...,"arguments":{...}}</tool_call>
//   Qwen XML            <function=name><parameter=key>value</parameter></function>
//   Gemma               ```tool_code\nget_weather(city="Paris")\n```
//   Generic fenced      ```tool_call\n{...}\n```
//   Llama 3.x           <|python_tag|>module.func(arg=1)  (until newline/end)
//   Mistral             [TOOL_CALLS] [{"name":...,"arguments":{...}}]
//   DeepSeek V3/R1      <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>name\n```json\n{...}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>
//   Thinking blocks     <think>...</think> / <|thinking|>... — discarded
// ---------------------------------------------------------------------------

interface TagPair {
    open: string;
    /** Closing marker. `endOfStream`: block ends at the next newline or end of stream.
     *  `balancedJson`: block ends when a complete JSON value has been accumulated. */
    close: string | 'endOfStream' | 'balancedJson';
    /** If true, the block content is discarded instead of being parsed as a tool call. */
    discard?: boolean;
}

// DeepSeek special tokens use fullwidth bar U+FF5C and lower-block U+2581.
const DS = { bar: '｜', sep: '▁' };
const DS_CALLS_BEGIN = `<${DS.bar}tool${DS.sep}calls${DS.sep}begin${DS.bar}>`;
const DS_CALLS_END = `<${DS.bar}tool${DS.sep}calls${DS.sep}end${DS.bar}>`;
const DS_CALL_BEGIN = `<${DS.bar}tool${DS.sep}call${DS.sep}begin${DS.bar}>`;
const DS_CALL_END = `<${DS.bar}tool${DS.sep}call${DS.sep}end${DS.bar}>`;
const DS_SEP = `<${DS.bar}tool${DS.sep}sep${DS.bar}>`;

const NATIVE_TOOL_TAGS: TagPair[] = [
    // Thinking/reasoning blocks — discard, never user-facing.
    { open: '<think>', close: '</think>', discard: true },
    { open: '<|thinking|>', close: '<|/thinking|>', discard: true },
    { open: '<tool_call>', close: '</tool_call>' },
    { open: '<tool_code>', close: '</tool_code>' },
    { open: '<function_call>', close: '</function_call>' },
    // Qwen3-Coder XML leaked without a <tool_call> wrapper — reconstructed in emitToolCall.
    { open: '<function=', close: '</function>' },
    // MiniMax M2 wrapper around Claude-style <invoke> XML.
    { open: '<minimax:tool_call>', close: '</minimax:tool_call>' },
    // Kimi K2 section tokens; inner per-call tokens are parsed from the payload.
    { open: '<|tool_calls_section_begin|>', close: '<|tool_calls_section_end|>' },
    // Granite: <|tool_call|> prefix followed by a JSON array of calls.
    { open: '<|tool_call|>', close: 'balancedJson' },
    // Fenced blocks (Gemma tool_code, generic tool_call/tool_use fences).
    { open: '```tool_code', close: '```' },
    { open: '```tool_call', close: '```' },
    { open: '```tool_use', close: '```' },
    // DeepSeek V3/R1 special-token dialect. The outer "calls" wrapper and the
    // per-call wrapper both appear; capture whole calls block then parse inside.
    { open: DS_CALLS_BEGIN, close: DS_CALLS_END },
    { open: DS_CALL_BEGIN, close: DS_CALL_END },
    // Older ASCII variants seen in some builds.
    { open: '<|tool_call_begin|>', close: '<|tool_call_end|>' },
    { open: '<|tool_calls_begin|>', close: '<|tool_calls_end|>' },
    // LM Studio's prompt-injected fallback for models without a tool-capable template.
    { open: '[TOOL_REQUEST]', close: '[END_TOOL_REQUEST]' },
    // Mistral: [TOOL_CALLS] followed by a JSON array (may span lines).
    { open: '[TOOL_CALLS]', close: 'balancedJson' },
    // Llama 3.1: open-only, payload is python/JSON until a newline / eom.
    { open: '<|python_tag|>', close: 'endOfStream' }
];

const MAX_OPEN_LEN = NATIVE_TOOL_TAGS.reduce((m, t) => Math.max(m, t.open.length), 0);

export class NativeToolCallParser {
    private buf = '';
    private inTool = false;
    private currentClose = '';
    private currentOpen = '';
    private currentDiscard = false;
    private toolBuf = '';
    /** Characters thrown away inside discard blocks (<think> etc.) — for diagnostics. */
    discardedChars = 0;
    /** While true, a leading bare JSON object/array is checked for tool-call shape.
     *  Some local model builds emit `{"name":...,"arguments":{...}}` as plain text with
     *  no wrapper tags at all. Enabled only when the request offered tools, and only
     *  until ordinary text has been emitted. */
    private bareJsonMode: boolean;

    constructor(private readonly cb: StreamCallbacks, opts?: { bareJson?: boolean }) {
        this.bareJsonMode = !!opts?.bareJson;
    }

    push(text: string): void {
        this.buf += text;
        this.process(false);
    }

    /** Drop everything still buffered (used when the stream errored mid-markup). */
    discardPending(): void {
        if (this.inTool && this.currentDiscard) this.discardedChars += this.toolBuf.length;
        this.buf = '';
        this.toolBuf = '';
        this.inTool = false;
        this.currentDiscard = false;
    }

    flush(): void {
        this.process(true);
        if (this.inTool) {
            // Unterminated block — attempt to parse what we have (unless it was a discard block like <think>).
            if (!this.currentDiscard) this.emitToolCall(this.toolBuf);
            else this.discardedChars += this.toolBuf.length;
            this.inTool = false;
            this.toolBuf = '';
            this.currentDiscard = false;
        }
        if (this.buf.length > 0) {
            this.cb.onText(this.buf);
            this.buf = '';
        }
    }

    private process(isFinal: boolean): void {
        while (this.buf.length > 0) {
            if (this.inTool) {
                if (this.currentClose === 'balancedJson') {
                    // Accumulate until a complete JSON value has arrived.
                    this.toolBuf += this.buf;
                    this.buf = '';
                    const start = this.toolBuf.search(/[[{]/);
                    if (start >= 0) {
                        const end = findJsonEnd(this.toolBuf, start);
                        if (end >= 0) {
                            const payload = this.toolBuf.slice(start, end + 1);
                            const rest = this.toolBuf.slice(end + 1);
                            if (!this.currentDiscard) this.emitToolCall(payload);
                            this.toolBuf = '';
                            this.inTool = false;
                            this.currentDiscard = false;
                            this.buf = rest;
                            continue;
                        }
                    }
                    // Incomplete — wait for more (flush() handles a truncated tail).
                    return;
                }
                if (this.currentClose === 'endOfStream') {
                    // Payload runs until end-of-line or end-of-stream.
                    const nl = this.buf.indexOf('\n');
                    if (nl < 0) {
                        this.toolBuf += this.buf;
                        this.buf = '';
                        if (!isFinal) return;
                        if (!this.currentDiscard) this.emitToolCall(this.toolBuf);
                        else this.discardedChars += this.toolBuf.length;
                        this.toolBuf = '';
                        this.inTool = false;
                        this.currentDiscard = false;
                        return;
                    }
                    this.toolBuf += this.buf.slice(0, nl);
                    this.buf = this.buf.slice(nl + 1);
                    if (!this.currentDiscard) this.emitToolCall(this.toolBuf);
                    else this.discardedChars += this.toolBuf.length;
                    this.toolBuf = '';
                    this.inTool = false;
                    this.currentDiscard = false;
                    continue;
                }
                const idx = this.buf.indexOf(this.currentClose);
                if (idx < 0) {
                    // Retain a small tail so we don't accidentally split the close marker.
                    const keep = Math.min(this.currentClose.length - 1, this.buf.length);
                    this.toolBuf += this.buf.slice(0, this.buf.length - keep);
                    this.buf = this.buf.slice(this.buf.length - keep);
                    if (isFinal && this.buf.length > 0) {
                        // Final flush: no close marker is coming — keep the tail too.
                        this.toolBuf += this.buf;
                        this.buf = '';
                    }
                    return;
                }
                this.toolBuf += this.buf.slice(0, idx);
                this.buf = this.buf.slice(idx + this.currentClose.length);
                if (!this.currentDiscard) this.emitToolCall(this.toolBuf);
                else this.discardedChars += this.toolBuf.length;
                this.toolBuf = '';
                this.inTool = false;
                this.currentDiscard = false;
                continue;
            }

            // Leading bare-JSON tool call (no wrapper tags at all).
            if (this.bareJsonMode) {
                const lead = this.buf.length - this.buf.replace(/^\s+/, '').length;
                const trimmed = this.buf.slice(lead);
                if (trimmed.length === 0) {
                    // Only whitespace so far — hold until something arrives.
                    if (isFinal) { this.cb.onText(this.buf); this.buf = ''; }
                    return;
                }
                if (trimmed[0] === '{' || trimmed[0] === '[') {
                    const end = findJsonEnd(this.buf, lead);
                    if (end < 0) {
                        if (!isFinal) return; // hold for the rest of the JSON
                        // Truncated JSON at end of stream — emitToolCall parses it or
                        // surfaces it as text.
                        this.emitToolCall(trimmed);
                        this.buf = '';
                        return;
                    }
                    const slice = this.buf.slice(lead, end + 1);
                    const parsed = tryParseJson(slice);
                    const arr = parsed === undefined ? [] : (Array.isArray(parsed) ? parsed : [parsed]);
                    if (arr.length > 0 && arr.every(isToolCallShaped)) {
                        this.emitToolCall(slice);
                        this.buf = this.buf.slice(end + 1);
                        continue; // stay in bare-JSON mode for back-to-back calls
                    }
                    // Complete JSON but not a tool call — ordinary text from here on.
                    this.bareJsonMode = false;
                } else {
                    // Ordinary text begins — stop looking for a bare JSON call.
                    this.bareJsonMode = false;
                }
            }

            // Find earliest opening tag.
            let nextIdx = -1;
            let nextTag: TagPair | undefined;
            for (const t of NATIVE_TOOL_TAGS) {
                const i = this.buf.indexOf(t.open);
                if (i >= 0 && (nextIdx < 0 || i < nextIdx || (i === nextIdx && t.open.length > (nextTag?.open.length ?? 0)))) {
                    nextIdx = i;
                    nextTag = t;
                }
            }

            if (nextIdx < 0) {
                // No complete open marker — flush everything except a possible partial-tag tail.
                const tailLen = Math.min(MAX_OPEN_LEN - 1, this.buf.length);
                if (!isFinal && this.couldStartTag(this.buf.slice(this.buf.length - tailLen))) {
                    const safeLen = this.buf.length - tailLen;
                    if (safeLen > 0) this.cb.onText(this.buf.slice(0, safeLen));
                    this.buf = this.buf.slice(safeLen);
                } else {
                    this.cb.onText(this.buf);
                    this.buf = '';
                }
                return;
            }

            if (nextIdx > 0) {
                this.cb.onText(this.buf.slice(0, nextIdx));
            }
            this.buf = this.buf.slice(nextIdx + nextTag!.open.length);
            this.inTool = true;
            this.currentOpen = nextTag!.open;
            this.currentClose = nextTag!.close;
            this.currentDiscard = !!nextTag!.discard;
            this.toolBuf = '';
        }
    }

    /** Returns true if `s` could be the start of any open tag (so we should buffer it). */
    private couldStartTag(s: string): boolean {
        if (!s) return false;
        for (const { open } of NATIVE_TOOL_TAGS) {
            // s could be a prefix of `open` if some suffix of s matches a prefix of open
            for (let cut = 0; cut < s.length; cut++) {
                const tail = s.slice(cut);
                if (tail.length > 0 && open.startsWith(tail)) return true;
            }
        }
        return false;
    }

    private emitToolCall(raw: string): void {
        // The '<function=' open tag consumed part of the markup — rebuild the
        // element so the Qwen XML parser sees the complete form.
        if (this.inTool && this.currentOpen === '<function=') {
            raw = `<function=${raw}</function>`;
        }
        const cleaned = stripCodeFences(raw.trim());
        if (!cleaned) return;
        const calls = extractToolCallObjects(cleaned);
        if (calls.length === 0) {
            // Couldn't parse — fall back to surfacing it as text so the user sees what went wrong.
            this.cb.onText(cleaned);
            return;
        }
        for (const c of calls) {
            const name = c.name ?? c.function?.name ?? c.tool ?? c.tool_name;
            if (!name || typeof name !== 'string') continue;
            const argsRaw = c.arguments ?? c.parameters ?? c.args ?? c.input ?? c.function?.arguments ?? {};
            const argsStr = typeof argsRaw === 'string' ? argsRaw : safeStringify(argsRaw);
            this.cb.onToolCall({
                id: typeof c.id === 'string' ? c.id : randomCallId(),
                type: 'function',
                function: { name, arguments: argsStr }
            });
        }
    }
}

function stripCodeFences(s: string): string {
    // ```json\n...\n``` or ```\n...\n```
    const m = s.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/);
    return m ? m[1].trim() : s;
}

function safeStringify(v: unknown): string {
    try { return JSON.stringify(v); } catch { return '{}'; }
}

/** Try several heuristics to pull tool-call objects out of a raw payload. */
export function extractToolCallObjects(raw: string): any[] {
    // 0. DeepSeek special-token dialect: function<｜tool▁sep｜>name\n```json\n{...}\n```
    const ds = parseDeepSeekCalls(raw);
    if (ds.length > 0) return ds;

    // 1. Kimi K2: functions.name:0<|tool_call_argument_begin|>{...}
    const kimi = parseKimiCalls(raw);
    if (kimi.length > 0) return kimi;

    // 2. GLM-4.x: name\n<arg_key>k</arg_key>\n<arg_value>v</arg_value>...
    const glm = parseGlmArgKeyCalls(raw);
    if (glm.length > 0) return glm;

    // 3. Claude/MiniMax-style XML: <invoke name="x"><parameter name="k">v</parameter></invoke>
    const invoke = parseInvokeXml(raw);
    if (invoke.length > 0) return invoke;

    // 4. Qwen XML-ish format: <function=name><parameter=key>value</parameter>...</function>
    //    (possibly multiple <function> blocks in one payload).
    const qwen = parseQwenXmlFunctions(raw);
    if (qwen.length > 0) return qwen;

    // 5. Direct JSON: { ... } or [ ... ]
    const direct = tryParseJson(raw);
    if (direct !== undefined) {
        const arr = Array.isArray(direct) ? direct : [direct];
        if (arr.every(isToolCallShaped)) return arr;
        return [];
    }

    // 6. Python dict literal in JSON position: {'name': 'x', 'arguments': {...}}
    const pyDict = tryParseJson(pythonLiteralToJson(raw));
    if (pyDict !== undefined) {
        const arr = Array.isArray(pyDict) ? pyDict : [pyDict];
        if (arr.length > 0 && arr.every(isToolCallShaped)) return arr;
    }

    // 7. Multiple back-to-back JSON objects.
    const multi = parseConcatenatedJson(raw);
    if (multi.length > 0 && multi.every(isToolCallShaped)) return multi;

    // 8. Bare name on the first line, JSON args below (older GLM and friends):
    //    get_weather\n{"city":"Paris"}
    const nameJson = parseNameThenJson(raw);
    if (nameJson.length > 0) return nameJson;

    // 9. Python-style calls: get_weather(city="Paris"), print(func(a=1)), module.func(...)
    const py = parsePythonCalls(raw);
    if (py.length > 0) return py;

    return [];
}

/**
 * Kimi K2 dialect:
 *   <|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city":"Paris"}<|tool_call_end|>
 * (section wrappers and/or per-call wrappers may already be stripped).
 */
function parseKimiCalls(raw: string): any[] {
    const ARG_SEP = '<|tool_call_argument_begin|>';
    if (!raw.includes(ARG_SEP)) return [];
    const results: any[] = [];
    const segments = raw.split('<|tool_call_begin|>').map(s => {
        const end = s.indexOf('<|tool_call_end|>');
        return end >= 0 ? s.slice(0, end) : s;
    }).filter(s => s.includes(ARG_SEP));
    for (const seg of segments) {
        const sep = seg.indexOf(ARG_SEP);
        let name = seg.slice(0, sep).trim();
        // Strip the functions. namespace and the :index suffix.
        name = name.replace(/^functions\./, '').replace(/:\d+$/, '');
        if (!name) continue;
        const argsRaw = stripCodeFences(seg.slice(sep + ARG_SEP.length).trim());
        const parsed = tryParseJson(argsRaw);
        results.push({ name, arguments: parsed !== undefined ? parsed : (argsRaw || {}) });
    }
    return results;
}

/**
 * GLM-4.x dialect (inside <tool_call>):
 *   get_weather
 *   <arg_key>city</arg_key>
 *   <arg_value>Paris</arg_value>
 */
function parseGlmArgKeyCalls(raw: string): any[] {
    if (!raw.includes('<arg_key>')) return [];
    const firstTag = raw.indexOf('<arg_key>');
    const name = raw.slice(0, firstTag).trim();
    // Name must be a plain identifier-ish token on its own.
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) return [];
    const args: Record<string, any> = {};
    const re = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        args[m[1].trim()] = coerceXmlParamValue(m[2]);
    }
    return [{ name, arguments: args }];
}

/**
 * Claude/MiniMax-style XML:
 *   <invoke name="get_weather"><parameter name="city">Paris</parameter></invoke>
 */
function parseInvokeXml(raw: string): any[] {
    const results: any[] = [];
    const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
    let m: RegExpExecArray | null;
    while ((m = invokeRe.exec(raw)) !== null) {
        const name = m[1].trim();
        if (!name) continue;
        const args: Record<string, any> = {};
        const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
        let pm: RegExpExecArray | null;
        while ((pm = paramRe.exec(m[2])) !== null) {
            args[pm[1].trim()] = coerceXmlParamValue(pm[2].trim());
        }
        results.push({ name, arguments: args });
    }
    return results;
}

/** Bare tool name on the first line, JSON args on the following lines. */
function parseNameThenJson(raw: string): any[] {
    const nl = raw.indexOf('\n');
    if (nl < 0) return [];
    const name = raw.slice(0, nl).trim();
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) return [];
    const rest = stripCodeFences(raw.slice(nl + 1).trim());
    if (!rest.startsWith('{')) return [];
    const parsed = tryParseJson(rest) ?? tryParseJson(pythonLiteralToJson(rest));
    if (parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return [{ name, arguments: parsed }];
}

/** A parsed object counts as a tool call only if it names a function. */
function isToolCallShaped(o: any): boolean {
    if (o === null || typeof o !== 'object') return false;
    const name = o.name ?? o.function?.name ?? o.tool ?? o.tool_name;
    return typeof name === 'string' && name.length > 0;
}

/**
 * Parse DeepSeek's special-token dialect. Two layouts exist:
 *   R1/V3:  function<｜tool▁sep｜>NAME \n ```json {args} ```
 *   V3.1:   NAME<｜tool▁sep｜>{args}          (single line, no type prefix)
 * possibly wrapped in <｜tool▁call▁begin｜>/<｜tool▁call▁end｜> markers
 * (outer wrappers may already be stripped by the tag scanner).
 */
function parseDeepSeekCalls(raw: string): any[] {
    if (!raw.includes(DS_SEP)) return [];
    const results: any[] = [];
    // Split on per-call begin markers if present; otherwise treat as one call.
    const segments = raw.split(DS_CALL_BEGIN).map(s => {
        const end = s.indexOf(DS_CALL_END);
        return end >= 0 ? s.slice(0, end) : s;
    }).filter(s => s.includes(DS_SEP));
    for (const seg of segments) {
        const sepIdx = seg.indexOf(DS_SEP);
        const before = seg.slice(0, sepIdx).trim();
        const after = seg.slice(sepIdx + DS_SEP.length);
        let name: string;
        let argsPart: string;
        if (before && before !== 'function' && before !== 'tool') {
            // V3.1: NAME<sep>ARGS
            name = before;
            argsPart = after.trim();
        } else {
            // R1/V3: type<sep>NAME \n ARGS
            const nl = after.indexOf('\n');
            name = (nl >= 0 ? after.slice(0, nl) : after).trim();
            argsPart = nl >= 0 ? after.slice(nl + 1).trim() : '';
        }
        if (!name) continue;
        const argsRaw = stripCodeFences(argsPart);
        const parsed = tryParseJson(argsRaw);
        results.push({ name, arguments: parsed !== undefined ? parsed : (argsRaw || {}) });
    }
    return results;
}

/**
 * Parse the Qwen / LM Studio XML-style tool call format:
 *
 *     <function=function_name>
 *     <parameter=param_a>
 *     value_a
 *     </parameter>
 *     </function>
 */
function parseQwenXmlFunctions(raw: string): any[] {
    const results: any[] = [];
    const fnRe = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/g;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(raw)) !== null) {
        const name = m[1].trim();
        if (!name) continue;
        const body = m[2];
        const args: Record<string, any> = {};
        const paramRe = /<parameter=([^>\s]+)\s*>\s*([\s\S]*?)\s*<\/parameter>/g;
        let pm: RegExpExecArray | null;
        while ((pm = paramRe.exec(body)) !== null) {
            const key = pm[1].trim();
            const rawVal = pm[2];
            args[key] = coerceXmlParamValue(rawVal);
        }
        results.push({ name, arguments: args });
    }
    return results;
}

/** Coerce a Qwen-style parameter value into a JS value when it looks like JSON / number / bool. */
function coerceXmlParamValue(raw: string): any {
    const t = raw.trim();
    if (t === '') return '';
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+$/.test(t)) {
        const n = Number(t);
        if (Number.isFinite(n) && Number.isSafeInteger(n)) return n;
    }
    if (/^-?\d+\.\d+$/.test(t)) {
        const n = Number(t);
        if (Number.isFinite(n)) return n;
    }
    if ((t.startsWith('{') && t.endsWith('}')) ||
        (t.startsWith('[') && t.endsWith(']')) ||
        (t.startsWith('"') && t.endsWith('"'))) {
        try { return JSON.parse(t); } catch { /* fall through */ }
    }
    return raw;
}

function tryParseJson(s: string): any {
    try { return JSON.parse(s); } catch { return undefined; }
}

/** Parse a sequence of JSON values that may appear back-to-back or separated by whitespace/commas. */
function parseConcatenatedJson(s: string): any[] {
    const results: any[] = [];
    let i = 0;
    while (i < s.length) {
        // Skip whitespace and commas
        while (i < s.length && /[\s,]/.test(s[i])) i++;
        if (i >= s.length) break;
        if (s[i] !== '{' && s[i] !== '[') return [];
        const end = findJsonEnd(s, i);
        if (end < 0) return [];
        const slice = s.slice(i, end + 1);
        const parsed = tryParseJson(slice);
        if (parsed === undefined) return [];
        if (Array.isArray(parsed)) results.push(...parsed);
        else results.push(parsed);
        i = end + 1;
    }
    return results;
}

/** Return the index of the matching close brace/bracket starting at `start`, accounting for strings. */
function findJsonEnd(s: string, start: number): number {
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === open) depth++;
        else if (c === close) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Python-style call parsing (Gemma tool_code, Llama python_tag).
//   get_weather(city="Paris", unit='celsius')
//   print(get_weather(city="Paris"))          <- unwrapped
//   module.func(a=1, b=[1,2], c={'k': True})
// ---------------------------------------------------------------------------

function parsePythonCalls(raw: string): any[] {
    const results: any[] = [];
    // Parse each line independently; a block may contain several calls.
    for (const line of raw.split('\n')) {
        const call = parsePythonCallLine(line.trim());
        if (call) results.push(call);
    }
    if (results.length > 0) return results;
    // No per-line match — the block may be a single call with arguments spanning lines.
    const whole = parsePythonCallLine(raw.trim());
    return whole ? [whole] : [];
}

function parsePythonCallLine(line: string): any | undefined {
    if (!line) return undefined;
    // Unwrap print(...)
    const printM = line.match(/^print\s*\(\s*([\s\S]*)\s*\)\s*;?\s*$/);
    if (printM) line = printM[1].trim();
    const m = line.match(/^([A-Za-z_][\w.]*)\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (!m) return undefined;
    // Reject obvious non-calls (e.g. keywords)
    const name = m[1].replace(/^functions\./, '');
    if (['if', 'for', 'while', 'return', 'print'].includes(name)) return undefined;
    const argsSrc = m[2].trim();
    const args: Record<string, any> = {};
    if (argsSrc.length > 0) {
        const parts = splitTopLevel(argsSrc);
        const positional: any[] = [];
        for (const part of parts) {
            const eq = findTopLevelEquals(part);
            if (eq < 0) {
                positional.push(coercePythonValue(part.trim()));
            } else {
                const key = part.slice(0, eq).trim();
                if (!/^[A-Za-z_]\w*$/.test(key)) { positional.push(coercePythonValue(part.trim())); continue; }
                args[key] = coercePythonValue(part.slice(eq + 1).trim());
            }
        }
        if (positional.length > 0) args['_args'] = positional;
    }
    return { name, arguments: args };
}

/** Split on top-level commas, respecting (), [], {}, and quotes. */
function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    let quote: string | null = null;
    let esc = false;
    for (const c of s) {
        if (quote) {
            cur += c;
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; cur += c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim().length > 0) parts.push(cur);
    return parts;
}

/** Index of the first top-level '=' that isn't part of ==, !=, <=, >=. */
function findTopLevelEquals(s: string): number {
    let depth = 0;
    let quote: string | null = null;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; continue; }
        if (c === '=' && depth === 0) {
            if (s[i + 1] === '=' || (i > 0 && /[!<>]/.test(s[i - 1]))) { continue; }
            return i;
        }
    }
    return -1;
}

/** Convert a python literal source string to a JS value (best effort). */
function coercePythonValue(src: string): any {
    if (src === 'True') return true;
    if (src === 'False') return false;
    if (src === 'None') return null;
    if (/^-?\d+$/.test(src)) return Number(src);
    if (/^-?\d*\.\d+$/.test(src)) return Number(src);
    if ((src.startsWith('"') && src.endsWith('"')) || (src.startsWith("'") && src.endsWith("'"))) {
        const inner = src.slice(1, -1);
        // Unescape the matching quote and backslashes.
        return inner.replace(/\\(['"\\nrt])/g, (_, ch) =>
            ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch);
    }
    // dict/list literals: convert pythonic syntax to JSON and parse.
    if (src.startsWith('{') || src.startsWith('[')) {
        const jsonish = pythonLiteralToJson(src);
        const parsed = tryParseJson(jsonish);
        if (parsed !== undefined) return parsed;
    }
    return src;
}

/** Best-effort conversion of a python dict/list literal to JSON. */
function pythonLiteralToJson(src: string): string {
    let out = '';
    let quote: string | null = null;
    let esc = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (esc) {
                // Python \' inside a single-quoted string is not a legal JSON escape.
                if (c === "'") out += "'";
                else out += '\\' + c;
                esc = false;
                continue;
            }
            if (c === '\\') { esc = true; continue; }
            if (c === quote) {
                out += '"';
                quote = null;
            } else if (c === '"' && quote === "'") {
                out += '\\"';
            } else {
                out += c;
            }
            continue;
        }
        if (c === '"' || c === "'") { quote = c; out += '"'; continue; }
        // Bare python literals outside strings
        if (src.startsWith('True', i) && !/\w/.test(src[i - 1] ?? '') && !/\w/.test(src[i + 4] ?? '')) { out += 'true'; i += 3; continue; }
        if (src.startsWith('False', i) && !/\w/.test(src[i - 1] ?? '') && !/\w/.test(src[i + 5] ?? '')) { out += 'false'; i += 4; continue; }
        if (src.startsWith('None', i) && !/\w/.test(src[i - 1] ?? '') && !/\w/.test(src[i + 4] ?? '')) { out += 'null'; i += 3; continue; }
        out += c;
    }
    return out;
}
