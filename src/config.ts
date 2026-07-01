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
}

const SECTION = 'lmstudioCopilot';

export function getServers(): LMServerConfig[] {
    const raw = vscode.workspace.getConfiguration(SECTION).get<LMServerConfig[]>('servers') ?? [];
    // Defensive: ensure required fields.
    return raw.map(s => ({
        id: s.id ?? cryptoRandomId(),
        name: s.name ?? s.baseUrl ?? 'LM Studio',
        baseUrl: (s.baseUrl ?? '').replace(/\/+$/, ''),
        apiKey: s.apiKey ?? '',
        enabled: s.enabled !== false,
        timeoutMs: s.timeoutMs ?? 60000,
        headers: s.headers ?? {},
        refreshIntervalSec: s.refreshIntervalSec ?? 0,
        hiddenModels: s.hiddenModels ?? []
    }));
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

export function onConfigChanged(cb: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(SECTION)) {
            cb();
        }
    });
}
