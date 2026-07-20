import * as vscode from 'vscode';

export interface LMServerConfig {
    id: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    enabled: boolean;
    timeoutMs?: number;
    headers?: Record<string, string>;
    /** Per-server refresh override (0 = use global). */
    refreshIntervalSec?: number;
    /** Model IDs hidden from the Copilot picker. */
    hiddenModels?: string[];
    /** Keep this server's copies of models visible even when another server
     *  already provides them (see lmstudioCopilot.dedupeAcrossServers). */
    showDuplicateModels?: boolean;
}

const SECTION = 'lmstudioCopilot';

export function getServers(): LMServerConfig[] {
    const raw = vscode.workspace.getConfiguration(SECTION).get<LMServerConfig[]>('servers') ?? [];
    // Defensive: ensure required fields.
    return raw.map(s => ({
        // A random fallback id would change on every read, breaking anything keyed
        // by server id (dedupe maps, toggles) — derive it from the URL instead.
        id: s.id ?? 'srv_' + stableHash(`${s.baseUrl ?? ''}|${s.name ?? ''}`),
        name: s.name ?? s.baseUrl ?? 'LM Studio',
        baseUrl: (s.baseUrl ?? '').replace(/\/+$/, ''),
        apiKey: s.apiKey ?? '',
        enabled: s.enabled !== false,
        // 60000 was the old shipped default and starves JIT model loads (>100s observed);
        // treat it as "default" and migrate to the new 300s default.
        timeoutMs: !s.timeoutMs || s.timeoutMs === 60000 ? 300000 : s.timeoutMs,
        headers: s.headers ?? {},
        refreshIntervalSec: s.refreshIntervalSec ?? 0,
        hiddenModels: s.hiddenModels ?? [],
        showDuplicateModels: s.showDuplicateModels === true
    }));
}

/** When true (default), a model listed by several servers (common with LM Link,
 *  where every machine reports the whole network's models) appears only once —
 *  attributed to the first enabled server that lists it. */
export function getDedupeAcrossServers(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>('dedupeAcrossServers') ?? true;
}

export async function setDedupeAcrossServers(value: boolean): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update('dedupeAcrossServers', value, vscode.ConfigurationTarget.Global);
}

export async function setServers(servers: LMServerConfig[], target = vscode.ConfigurationTarget.Global): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update('servers', servers, target);
}

export function getGlobalRefreshSec(): number {
    return vscode.workspace.getConfiguration(SECTION).get<number>('refreshIntervalSec') ?? 60;
}

export async function setGlobalRefreshSec(value: number): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update('refreshIntervalSec', value, vscode.ConfigurationTarget.Global);
}

export function getShowStatusBar(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>('showStatusBar') ?? true;
}

export function cryptoRandomId(): string {
    return 'srv_' + Math.random().toString(36).slice(2, 10);
}

function stableHash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

export function onConfigChanged(cb: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(SECTION)) {
            cb();
        }
    });
}
