import * as vscode from 'vscode';
import { LMServerConfig, getServers, getGlobalRefreshSec, onConfigChanged } from './config';
import { LMStudioClient, LMStudioModel, ChatMessage, ContentPart, ToolCall, ToolDef } from './lmStudioClient';

export interface DiscoveredModel {
    server: LMServerConfig;
    model: LMStudioModel;
}

type Listener = (models: DiscoveredModel[]) => void;

function encodeId(serverId: string, modelId: string): string {
    return `${serverId}::${modelId}`;
}
function decodeId(id: string): { serverId: string; modelId: string } {
    const idx = id.indexOf('::');
    return idx < 0
        ? { serverId: '', modelId: id }
        : { serverId: id.slice(0, idx), modelId: id.slice(idx + 2) };
}

/** Rough model family from the id — helps Copilot pick prompt idioms. */
function familyOf(modelId: string): string {
    const id = modelId.toLowerCase();
    for (const f of ['qwen', 'gemma', 'deepseek', 'llama', 'mistral', 'magistral', 'devstral', 'codestral',
        'phi', 'glm', 'granite', 'smol', 'kimi', 'minimax', 'grok', 'command', 'hermes', 'hunyuan',
        'ernie', 'seed', 'nemotron', 'olmo', 'exaone', 'falcon', 'starcoder', 'codegemma', 'yi']) {
        if (id.includes(f)) return f;
    }
    return 'lmstudio';
}

const DEFAULT_CTX = 32768;
const MAX_OUTPUT_CAP = 16384;

export class LmStudioChatProvider implements vscode.LanguageModelChatProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

    constructor(
        private getDiscovered: () => DiscoveredModel[],
        private ensureFresh: () => Promise<void>,
        private log: vscode.OutputChannel
    ) {}

    notifyChanged(): void {
        this._onDidChange.fire();
    }

    async provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        // If we have nothing cached yet, do a synchronous refresh so the
        // first call after activation returns real models instead of an empty list.
        if (this.getDiscovered().length === 0) {
            try { await this.ensureFresh(); } catch { /* logged elsewhere */ }
        }
        const items = this.getDiscovered()
            // Embedding models can't be used for chat — exclude them.
            .filter(({ model }) => model.type !== 'embeddings' && !/embed/i.test(model.id))
            .map(({ server, model }) => {
                // Prefer the loaded context size; fall back to the model's max.
                const ctx = model.loadedContextLength ?? model.maxContextLength ?? DEFAULT_CTX;
                const maxOutput = Math.min(MAX_OUTPUT_CAP, Math.max(1024, Math.floor(ctx / 4)));
                // Always advertise tool calling: LM Studio prompt-bridges tools for models
                // whose template lacks native support ([TOOL_REQUEST] format), and its
                // capability report is unreliable for unloaded models. The tooltip still
                // distinguishes native vs bridged support.
                const nativeTools = model.capabilities?.includes('tool_use');
                return {
                    id: encodeId(server.id, model.id),
                    name: `${model.id} (${server.name})`,
                    family: familyOf(model.id),
                    version: '1',
                    maxInputTokens: Math.max(1024, ctx - maxOutput),
                    maxOutputTokens: maxOutput,
                    detail: server.name,
                    tooltip: `${model.id} @ ${server.baseUrl}` +
                        (model.state ? ` — ${model.state}` : '') +
                        ` — ctx ${ctx}` +
                        (model.capabilities ? (nativeTools ? ' — native tools' : ' — bridged tools') : ''),
                    // Undocumented fields the chat picker checks at runtime:
                    isUserSelectable: true,
                    capabilities: {
                        toolCalling: true,
                        imageInput: model.type === 'vlm',
                        agentMode: true
                    }
                } as vscode.LanguageModelChatInformation;
            });
        this.log.appendLine(`provideLanguageModelChatInformation -> ${items.length} model(s)`);
        return items;
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const { serverId, modelId } = decodeId(model.id);
        const server = getServers().find(s => s.id === serverId);
        if (!server) throw new Error(`LM Studio server not found for model ${model.id}`);

        const supportsImages = model.capabilities?.imageInput === true;
        const chatMessages = this.convertMessages(messages, supportsImages);
        const tools = this.convertTools(options.tools);
        const toolChoice = this.convertToolMode((options as any)?.toolMode);
        const sampling = this.convertModelOptions(options.modelOptions);

        const client = new LMStudioClient(server);
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());

        this.log.appendLine(
            `[chat] ${server.name}/${modelId}: ${chatMessages.length} msg(s)` +
            (tools ? `, ${tools.length} tool(s)` : '') +
            (toolChoice ? `, tool_choice=${toolChoice}` : '')
        );

        let reasoningChars = 0;
        try {
            await client.chat(
                {
                    model: modelId,
                    messages: chatMessages,
                    ...sampling,
                    ...(tools && tools.length > 0 ? { tools } : {}),
                    ...(toolChoice && tools && tools.length > 0 ? { tool_choice: toolChoice } : {})
                },
                {
                    onText: text => progress.report(new vscode.LanguageModelTextPart(text)),
                    onToolCall: (call: ToolCall) => {
                        let input: any = {};
                        try { input = call.function.arguments ? JSON.parse(call.function.arguments) : {}; }
                        catch { input = { _raw: call.function.arguments }; }
                        progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, input));
                    },
                    // Thinking output is not part of the stable VS Code API — swallow it,
                    // but track volume for diagnostics.
                    onReasoning: text => { reasoningChars += text.length; }
                },
                ac.signal
            );
            if (reasoningChars > 0) {
                this.log.appendLine(`[chat] ${server.name}/${modelId}: dropped ${reasoningChars} reasoning char(s)`);
            }
        } catch (err: any) {
            this.log.appendLine(`[chat] ${server.name}/${modelId}: ${err?.message ?? err}`);
            throw err;
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        const s = typeof text === 'string' ? text : this.flattenMessage(text);
        return Math.max(1, Math.ceil(s.length / 4));
    }

    private convertMessages(
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        supportsImages: boolean
    ): ChatMessage[] {
        const out: ChatMessage[] = [];
        // VS Code stable enum: User = 1, Assistant = 2. Newer builds add System = 3
        // (and Copilot sends it) — recognize it defensively.
        const SYSTEM_ROLE = 3;
        for (const m of messages) {
            const isAssistant = m.role === vscode.LanguageModelChatMessageRole.Assistant;
            const isSystem = (m.role as number) === SYSTEM_ROLE;
            const textParts: string[] = [];
            const imageParts: ContentPart[] = [];
            const toolCalls: ToolCall[] = [];
            // role:'tool' messages — one per tool result part
            const toolResults: { id: string; text: string }[] = [];

            for (const p of m.content) {
                if (p instanceof vscode.LanguageModelTextPart) {
                    textParts.push(p.value);
                } else if (p instanceof vscode.LanguageModelToolCallPart) {
                    // Assistant invoking a tool
                    let argStr: string;
                    try { argStr = JSON.stringify(p.input ?? {}); }
                    catch { argStr = '{}'; }
                    toolCalls.push({
                        id: p.callId,
                        type: 'function',
                        function: { name: p.name, arguments: argStr }
                    });
                } else if (p instanceof vscode.LanguageModelToolResultPart) {
                    // Tool result coming back to the model
                    const parts: string[] = [];
                    for (const cp of (p as any).content ?? []) {
                        if (cp instanceof vscode.LanguageModelTextPart) parts.push(cp.value);
                        else if (this.isDataPart(cp)) {
                            const dp = cp as vscode.LanguageModelDataPart;
                            if (dp.mimeType?.startsWith('text/') || dp.mimeType === 'application/json') {
                                try { parts.push(Buffer.from(dp.data).toString('utf8')); } catch { /* ignore */ }
                            } else {
                                parts.push(`[binary ${dp.mimeType ?? 'data'}, ${dp.data?.length ?? 0} bytes]`);
                            }
                        }
                        else if (typeof cp?.value === 'string') parts.push(cp.value);
                        else if (cp !== undefined) {
                            try { parts.push(JSON.stringify(cp)); } catch { /* ignore */ }
                        }
                    }
                    toolResults.push({ id: (p as any).callId, text: parts.join('') });
                } else if (this.isDataPart(p)) {
                    const dp = p as vscode.LanguageModelDataPart;
                    if (supportsImages && dp.mimeType?.startsWith('image/')) {
                        imageParts.push({
                            type: 'image_url',
                            image_url: { url: `data:${dp.mimeType};base64,${Buffer.from(dp.data).toString('base64')}` }
                        });
                    } else if (dp.mimeType?.startsWith('text/') || dp.mimeType === 'application/json') {
                        try { textParts.push(Buffer.from(dp.data).toString('utf8')); } catch { /* ignore */ }
                    }
                    // Other binary payloads are silently dropped — nothing sensible to send.
                } else if (typeof (p as any)?.value === 'string') {
                    textParts.push((p as any).value);
                }
            }

            const text = textParts.join('');
            if (isSystem) {
                if (text.length > 0) out.push({ role: 'system', content: text });
            } else if (isAssistant) {
                if (text.length > 0 || toolCalls.length > 0) {
                    out.push({
                        role: 'assistant',
                        content: text,
                        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                    });
                }
            } else {
                // User-role message: tool results come back from VS Code on the user side.
                // Emit each tool result as its own role:'tool' message first, then any user text.
                for (const r of toolResults) {
                    out.push({ role: 'tool', tool_call_id: r.id, content: r.text });
                }
                if (imageParts.length > 0) {
                    const content: ContentPart[] = [];
                    if (text.length > 0) content.push({ type: 'text', text });
                    content.push(...imageParts);
                    out.push({ role: 'user', content });
                } else if (text.length > 0) {
                    out.push({ role: 'user', content: text });
                }
            }
        }
        return out;
    }

    private isDataPart(p: unknown): boolean {
        const DataPart = (vscode as any).LanguageModelDataPart;
        if (typeof DataPart === 'function' && p instanceof DataPart) return true;
        // Duck-type fallback for API variations.
        const q = p as any;
        return q && q.data instanceof Uint8Array && typeof q.mimeType === 'string';
    }

    private convertTools(tools: ReadonlyArray<any> | undefined): ToolDef[] | undefined {
        if (!tools || tools.length === 0) return undefined;
        return tools.map(t => {
            const params = t.inputSchema ?? t.parameters;
            return {
                type: 'function' as const,
                function: {
                    name: t.name,
                    description: t.description,
                    // Chat templates expect a JSON-schema object; guarantee one.
                    parameters: params && typeof params === 'object' ? params : { type: 'object', properties: {} }
                }
            };
        });
    }

    private convertToolMode(mode: any): 'auto' | 'required' | undefined {
        if (mode === undefined || mode === null) return undefined;
        // VS Code's LanguageModelChatToolMode enum: Auto = 1, Required = 2
        if (mode === 2 || mode === 'required') return 'required';
        if (mode === 1 || mode === 'auto') return 'auto';
        return undefined;
    }

    /** Map VS Code modelOptions onto OpenAI-compatible sampling params. */
    private convertModelOptions(opts: { readonly [name: string]: any } | undefined): Partial<{
        temperature: number; top_p: number; max_tokens: number; stop: string | string[];
        presence_penalty: number; frequency_penalty: number;
    }> {
        if (!opts) return {};
        const out: any = {};
        if (typeof opts.temperature === 'number') out.temperature = opts.temperature;
        if (typeof opts.top_p === 'number') out.top_p = opts.top_p;
        else if (typeof opts.topP === 'number') out.top_p = opts.topP;
        const maxTokens = opts.max_tokens ?? opts.maxTokens ?? opts.maxOutputTokens;
        if (typeof maxTokens === 'number' && maxTokens > 0) out.max_tokens = maxTokens;
        if (typeof opts.stop === 'string' || Array.isArray(opts.stop)) out.stop = opts.stop;
        if (typeof opts.presence_penalty === 'number') out.presence_penalty = opts.presence_penalty;
        if (typeof opts.frequency_penalty === 'number') out.frequency_penalty = opts.frequency_penalty;
        return out;
    }

    private flattenMessage(m: vscode.LanguageModelChatRequestMessage): string {
        // Include tool calls and tool results — ignoring them makes Copilot's prompt
        // budgeting undercount agent-mode conversations badly.
        const parts: string[] = [];
        for (const p of m.content) {
            if (p instanceof vscode.LanguageModelTextPart) {
                parts.push(p.value);
            } else if (p instanceof vscode.LanguageModelToolCallPart) {
                parts.push(p.name);
                try { parts.push(JSON.stringify(p.input ?? {})); } catch { /* ignore */ }
            } else if (p instanceof vscode.LanguageModelToolResultPart) {
                for (const cp of (p as any).content ?? []) {
                    if (cp instanceof vscode.LanguageModelTextPart) parts.push(cp.value);
                    else if (typeof cp?.value === 'string') parts.push(cp.value);
                }
            } else if (typeof (p as any)?.value === 'string') {
                parts.push((p as any).value);
            }
        }
        return parts.join('');
    }
}

export class ModelRegistry implements vscode.Disposable {
    private timers = new Map<string, NodeJS.Timeout>();
    private latest: DiscoveredModel[] = [];
    private listeners = new Set<Listener>();
    private disposables: vscode.Disposable[] = [];
    private provider?: LmStudioChatProvider;
    private providerRegistration?: vscode.Disposable;

    constructor(private readonly log: vscode.OutputChannel) {
        this.disposables.push(onConfigChanged(() => this.restart()));
    }

    start(): void {
        this.registerProvider();
        this.restart();
    }

    onModelsChanged(listener: Listener): vscode.Disposable {
        this.listeners.add(listener);
        listener(this.latest);
        return new vscode.Disposable(() => this.listeners.delete(listener));
    }

    getModels(): DiscoveredModel[] {
        return this.latest;
    }

    async refreshAll(): Promise<void> {
        const servers = getServers().filter(s => s.enabled && s.baseUrl);
        const results = await Promise.all(servers.map(s => this.fetchServer(s)));
        this.latest = results.flat();
        this.notify();
    }

    private async fetchServer(server: LMServerConfig): Promise<DiscoveredModel[]> {
        try {
            const client = new LMStudioClient(server);
            const models = await client.listModels();
            const hidden = new Set(server.hiddenModels ?? []);
            const visible = models.filter(m => !hidden.has(m.id));
            this.log.appendLine(`[refresh] ${server.name}: ${models.length} model(s), ${visible.length} visible`);
            return visible.map(model => ({ server, model }));
        } catch (err: any) {
            this.log.appendLine(`[refresh] ${server.name}: ERROR ${err?.message ?? err}`);
            return [];
        }
    }

    private restart(): void {
        for (const t of this.timers.values()) clearInterval(t);
        this.timers.clear();

        const servers = getServers().filter(s => s.enabled);
        const globalSec = getGlobalRefreshSec();

        void this.refreshAll();

        for (const server of servers) {
            const sec = server.refreshIntervalSec && server.refreshIntervalSec > 0
                ? server.refreshIntervalSec
                : globalSec;
            if (sec > 0) {
                const t = setInterval(() => void this.refreshSingle(server.id), sec * 1000);
                this.timers.set(server.id, t);
            }
        }
    }

    private async refreshSingle(serverId: string): Promise<void> {
        const server = getServers().find(s => s.id === serverId);
        if (!server || !server.enabled) return;
        const fresh = await this.fetchServer(server);
        this.latest = this.latest.filter(m => m.server.id !== serverId).concat(fresh);
        this.notify();
    }

    private registerProvider(): void {
        const lmAny = (vscode as any).lm;
        const fn = lmAny?.registerLanguageModelChatProvider;
        if (typeof fn !== 'function') {
            this.log.appendLine('vscode.lm.registerLanguageModelChatProvider is not available in this VS Code version.');
            return;
        }
        this.provider = new LmStudioChatProvider(
            () => this.latest,
            () => this.refreshAll(),
            this.log
        );
        try {
            this.providerRegistration = fn.call(lmAny, 'lmstudio', this.provider);
            this.log.appendLine('Registered LanguageModelChatProvider with vendor "lmstudio".');
        } catch (err: any) {
            this.log.appendLine(`Failed to register provider: ${err?.message ?? err}`);
        }
    }

    private notify(): void {
        this.provider?.notifyChanged();
        for (const l of this.listeners) l(this.latest);
    }

    dispose(): void {
        for (const t of this.timers.values()) clearInterval(t);
        this.providerRegistration?.dispose();
        for (const d of this.disposables) d.dispose();
    }
}
