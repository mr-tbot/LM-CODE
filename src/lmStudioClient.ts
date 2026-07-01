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
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** Plain text content; may be empty when an assistant message only has tool_calls. */
    content: string;
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
    tools?: ToolDef[];
    tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

export interface StreamCallbacks {
    onText: (text: string) => void;
    onToolCall: (call: ToolCall) => void;
}

export class LMStudioClient {
    constructor(private readonly server: LMServerConfig) {}

    async listModels(): Promise<LMStudioModel[]> {
        const res = await this.request('GET', '/v1/models');
        const data = JSON.parse(res);
        const items: any[] = data.data ?? data.models ?? [];
        return items.map(m => ({
            id: m.id ?? m.name,
            object: m.object,
            owned_by: m.owned_by,
            serverId: this.server.id
        }));
    }

    async testConnection(): Promise<{ ok: boolean; message: string; modelCount?: number }> {
        try {
            const models = await this.listModels();
            return { ok: true, message: `Connected. ${models.length} model(s) available.`, modelCount: models.length };
        } catch (err: any) {
            return { ok: false, message: err?.message ?? String(err) };
        }
    }

    /** Streaming chat completion. Emits text chunks and finalized tool calls. */
    async chat(req: ChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
        const body = JSON.stringify({ ...req, stream: true });
        // Accumulate streaming OpenAI-format tool_calls by index.
        const pending = new Map<number, { id: string; name: string; args: string; emitted: boolean }>();
        // Parse native model markup (`<tool_call>...`, `<tool_code>...`, etc.) from delta.content.
        const textParser = new NativeToolCallParser(callbacks);

        await this.streamingRequest('POST', '/v1/chat/completions', body, line => {
            if (!line.startsWith('data:')) return;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            try {
                const json = JSON.parse(payload);
                const choice = json.choices?.[0];
                const delta = choice?.delta;
                if (!delta) return;
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                    textParser.push(delta.content);
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
                if (choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'stop') {
                    for (const slot of pending.values()) {
                        if (slot.emitted || !slot.name) continue;
                        slot.emitted = true;
                        callbacks.onToolCall({
                            id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                            type: 'function',
                            function: { name: slot.name, arguments: slot.args || '{}' }
                        });
                    }
                }
            } catch {
                /* skip malformed chunk */
            }
        }, signal);

        // Flush any trailing buffered native markup as text or tool calls.
        textParser.flush();

        // Safety net: emit any OpenAI-format tool calls that never got a finish_reason.
        for (const slot of pending.values()) {
            if (slot.emitted || !slot.name) continue;
            callbacks.onToolCall({
                id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                type: 'function',
                function: { name: slot.name, arguments: slot.args || '{}' }
            });
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
                timeout: this.server.timeoutMs ?? 60000
            };
            const req = lib.request(opts, res => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if ((res.statusCode ?? 0) >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
                    } else {
                        resolve(text);
                    }
                });
            });
            req.on('timeout', () => req.destroy(new Error(`Request timed out after ${this.server.timeoutMs}ms`)));
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }

    private streamingRequest(method: string, path: string, body: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            const url = new URL(this.server.baseUrl + path);
            const lib = url.protocol === 'https:' ? https : http;
            const opts: http.RequestOptions = {
                method,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                headers: this.buildHeaders(body),
                timeout: this.server.timeoutMs ?? 60000
            };
            const req = lib.request(opts, res => {
                if ((res.statusCode ?? 0) >= 400) {
                    const chunks: Buffer[] = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`)));
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
            });
            signal?.addEventListener('abort', () => req.destroy(new Error('Aborted')));
            req.on('timeout', () => req.destroy(new Error(`Request timed out after ${this.server.timeoutMs}ms`)));
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

// ---------------------------------------------------------------------------
// Native tool-call markup parser.
// Many local models emit tool calls inside plain text rather than via OpenAI's
// `tool_calls` field (e.g. Hermes/Qwen `<tool_call>...</tool_call>`,
// Gemma `<tool_code>...</tool_code>`, Llama 3.1 `<|python_tag|>...`,
// DeepSeek `<|tool_call_begin|>...<|tool_call_end|>`). This parser inspects
// the streaming text, extracts tool-call payloads, parses them into OpenAI
// shape, and emits them via the same `onToolCall` callback so the rest of
// the bridge doesn't need to care about the model's native dialect.
// ---------------------------------------------------------------------------

interface TagPair {
    open: string;
    /** Closing marker; if `endOfStream`, the block ends at the next newline or end of stream. */
    close: string | 'endOfStream';
    /** If true, the block content is discarded instead of being parsed as a tool call. */
    discard?: boolean;
}

const NATIVE_TOOL_TAGS: TagPair[] = [
    // Discard Qwen "thinking" blocks — they're reasoning, not user-facing content.
    { open: '<think>', close: '</think>', discard: true },
    { open: '<tool_call>', close: '</tool_call>' },
    { open: '<tool_code>', close: '</tool_code>' },
    { open: '<function_call>', close: '</function_call>' },
    { open: '<|tool_call_begin|>', close: '<|tool_call_end|>' },
    // DeepSeek uses fullwidth bar characters
    { open: '<\uFF5Ctool_call_begin\uFF5C>', close: '<\uFF5Ctool_call_end\uFF5C>' },
    // Llama 3.1: open-only, payload is JSON until a newline / eom
    { open: '<|python_tag|>', close: 'endOfStream' }
];

const MAX_OPEN_LEN = NATIVE_TOOL_TAGS.reduce((m, t) => Math.max(m, t.open.length), 0);

class NativeToolCallParser {
    private buf = '';
    private inTool = false;
    private currentClose = '';
    private currentOpen = '';
    private currentDiscard = false;
    private toolBuf = '';

    constructor(private readonly cb: StreamCallbacks) {}

    push(text: string): void {
        this.buf += text;
        this.process(false);
    }

    flush(): void {
        this.process(true);
        if (this.inTool) {
            // Unterminated block — attempt to parse what we have (unless it was a discard block like <think>).
            if (!this.currentDiscard) this.emitToolCall(this.toolBuf);
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
                if (this.currentClose === 'endOfStream') {
                    // Llama-style: payload runs until end-of-line or end-of-stream.
                    const nl = this.buf.indexOf('\n');
                    if (nl < 0) {
                        this.toolBuf += this.buf;
                        this.buf = '';
                        if (!isFinal) return;
                        if (!this.currentDiscard) this.emitToolCall(this.toolBuf);
                        this.toolBuf = '';
                        this.inTool = false;
                        this.currentDiscard = false;
                        return;
                    }
                    this.toolBuf += this.buf.slice(0, nl);
                    this.buf = this.buf.slice(nl + 1);
                    if (!this.currentDiscard) this.emitToolCall(this.toolBuf);
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
                    return;
                }
                this.toolBuf += this.buf.slice(0, idx);
                this.buf = this.buf.slice(idx + this.currentClose.length);
                if (!this.currentDiscard) this.emitToolCall(this.toolBuf);
                this.toolBuf = '';
                this.inTool = false;
                this.currentDiscard = false;
                continue;
            }

            // Find earliest opening tag.
            let nextIdx = -1;
            let nextTag: TagPair | undefined;
            for (const t of NATIVE_TOOL_TAGS) {
                const i = this.buf.indexOf(t.open);
                if (i >= 0 && (nextIdx < 0 || i < nextIdx)) {
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
                id: typeof c.id === 'string' ? c.id : `call_${Math.random().toString(36).slice(2, 10)}`,
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
function extractToolCallObjects(raw: string): any[] {
    // 1. Qwen XML-ish format: <function=name><parameter=key>value</parameter>...</function>
    //    (possibly multiple <function> blocks in one payload).
    const qwen = parseQwenXmlFunctions(raw);
    if (qwen.length > 0) return qwen;

    // 2. Direct JSON: { ... } or [ ... ]
    const direct = tryParseJson(raw);
    if (direct !== undefined) return Array.isArray(direct) ? direct : [direct];

    // 3. Multiple back-to-back JSON objects.
    const multi = parseConcatenatedJson(raw);
    if (multi.length > 0) return multi;

    return [];
}

/**
 * Parse the Qwen / LM Studio XML-style tool call format:
 *
 *     <function=function_name>
 *     <parameter=param_a>
 *     value_a
 *     </parameter>
 *     <parameter=param_b>
 *     value_b
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
