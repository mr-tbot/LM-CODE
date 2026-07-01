import * as vscode from 'vscode';
import { getServers, setServers, getGlobalRefreshSec, setGlobalRefreshSec, LMServerConfig, cryptoRandomId } from './config';
import { LMStudioClient } from './lmStudioClient';
import { ModelRegistry, DiscoveredModel } from './modelProvider';

export class SettingsPanel {
    private static current: SettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    static show(context: vscode.ExtensionContext, registry: ModelRegistry): void {
        if (SettingsPanel.current) {
            SettingsPanel.current.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'lmstudioCopilot.settings',
            'LM-CODE Settings',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            }
        );
        SettingsPanel.current = new SettingsPanel(context, panel, registry);
    }

    private constructor(
        private readonly context: vscode.ExtensionContext,
        panel: vscode.WebviewPanel,
        private readonly registry: ModelRegistry
    ) {
        this.panel = panel;
        this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
        this.panel.webview.html = this.render();

        this.disposables.push(
            this.panel.onDidDispose(() => this.dispose()),
            this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg)),
            this.registry.onModelsChanged(models => this.postState(models))
        );

        this.postState(this.registry.getModels());
    }

    private async handleMessage(msg: any): Promise<void> {
        try {
            switch (msg?.type) {
                case 'ready':
                    this.postState(this.registry.getModels());
                    return;
                case 'saveServers':
                    await setServers(msg.servers as LMServerConfig[]);
                    return;
                case 'saveRefresh':
                    await setGlobalRefreshSec(Number(msg.value) || 0);
                    return;
                case 'addServer': {
                    const servers = getServers();
                    servers.push({
                        id: cryptoRandomId(),
                        name: 'New LM Studio',
                        baseUrl: 'http://localhost:1234',
                        apiKey: '',
                        enabled: true,
                        timeoutMs: 60000,
                        headers: {},
                        refreshIntervalSec: 0,
                        hiddenModels: []
                    });
                    await setServers(servers);
                    return;
                }
                case 'removeServer': {
                    const servers = getServers().filter(s => s.id !== msg.id);
                    await setServers(servers);
                    return;
                }
                case 'testConnection': {
                    const server = getServers().find(s => s.id === msg.id);
                    if (!server) return;
                    const client = new LMStudioClient(server);
                    const result = await client.testConnection();
                    this.panel.webview.postMessage({ type: 'testResult', id: msg.id, ...result });
                    return;
                }
                case 'refreshNow':
                    await this.registry.refreshAll();
                    return;
                case 'toggleHidden': {
                    const servers = getServers();
                    const s = servers.find(x => x.id === msg.serverId);
                    if (!s) return;
                    const hidden = new Set(s.hiddenModels ?? []);
                    if (hidden.has(msg.modelId)) hidden.delete(msg.modelId);
                    else hidden.add(msg.modelId);
                    s.hiddenModels = [...hidden];
                    await setServers(servers);
                    return;
                }
                case 'exportConfig': {
                    const data = {
                        servers: getServers(),
                        refreshIntervalSec: getGlobalRefreshSec()
                    };
                    const uri = await vscode.window.showSaveDialog({
                        filters: { JSON: ['json'] },
                        defaultUri: vscode.Uri.file('lm-code-config.json')
                    });
                    if (uri) {
                        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
                        vscode.window.showInformationMessage('Configuration exported.');
                    }
                    return;
                }
                case 'importConfig': {
                    const uris = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        filters: { JSON: ['json'] }
                    });
                    if (!uris?.length) return;
                    const buf = await vscode.workspace.fs.readFile(uris[0]);
                    const data = JSON.parse(Buffer.from(buf).toString('utf8'));
                    if (Array.isArray(data.servers)) await setServers(data.servers);
                    if (typeof data.refreshIntervalSec === 'number') await setGlobalRefreshSec(data.refreshIntervalSec);
                    vscode.window.showInformationMessage('Configuration imported.');
                    return;
                }
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`LM-CODE: ${err?.message ?? err}`);
        }
    }

    private postState(models: DiscoveredModel[]): void {
        this.panel.webview.postMessage({
            type: 'state',
            servers: getServers(),
            refreshIntervalSec: getGlobalRefreshSec(),
            models: models.map(m => ({ serverId: m.server.id, id: m.model.id }))
        });
    }

    private render(): string {
        const nonce = randomNonce();
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>LM-CODE Settings</title>
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    h1 { font-size: 1.3em; margin: 0 0 12px; }
    h2 { font-size: 1.05em; margin: 0; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
    .toolbar label { display: flex; align-items: center; gap: 6px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    input[type=text], input[type=number], input[type=password], textarea {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; border-radius: 2px;
        font-family: inherit; font-size: inherit; box-sizing: border-box;
    }
    .server { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 12px; margin-bottom: 12px; }
    .server.disabled { opacity: 0.6; }
    .server-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; }
    .grid { display: grid; grid-template-columns: 160px 1fr; gap: 6px 10px; align-items: center; }
    .grid input, .grid textarea { width: 100%; }
    .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .models { margin-top: 10px; }
    .model { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
    .model.hidden { opacity: 0.55; text-decoration: line-through; }
    .status { font-size: 0.9em; margin-left: 8px; }
    .status.ok { color: var(--vscode-testing-iconPassed, #6cc26c); }
    .status.err { color: var(--vscode-errorForeground); }
    details summary { cursor: pointer; user-select: none; }
</style>
</head>
<body>
<h1>LM-CODE</h1>
<div class="toolbar">
    <button id="addBtn">+ Add Server</button>
    <button id="refreshBtn" class="secondary">Refresh Now</button>
    <button id="exportBtn" class="secondary">Export…</button>
    <button id="importBtn" class="secondary">Import…</button>
    <label>Global refresh (sec):
        <input type="number" id="refreshSec" min="0" step="5" style="width: 80px" />
    </label>
</div>
<div id="servers"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = { servers: [], refreshIntervalSec: 60, models: [] };

window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'state') {
        state = m;
        render();
    } else if (m.type === 'testResult') {
        const el = document.querySelector('[data-test-status="' + m.id + '"]');
        if (el) {
            el.textContent = m.message;
            el.className = 'status ' + (m.ok ? 'ok' : 'err');
        }
    }
});

document.getElementById('addBtn').addEventListener('click', () => vscode.postMessage({ type: 'addServer' }));
document.getElementById('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refreshNow' }));
document.getElementById('exportBtn').addEventListener('click', () => vscode.postMessage({ type: 'exportConfig' }));
document.getElementById('importBtn').addEventListener('click', () => vscode.postMessage({ type: 'importConfig' }));
document.getElementById('refreshSec').addEventListener('change', e => {
    vscode.postMessage({ type: 'saveRefresh', value: Number(e.target.value) });
});

function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
const saveServers = debounce(() => vscode.postMessage({ type: 'saveServers', servers: state.servers }), 400);

function setField(id, field, value) {
    const s = state.servers.find(x => x.id === id);
    if (!s) return;
    s[field] = value;
    saveServers();
}

function render() {
    document.getElementById('refreshSec').value = state.refreshIntervalSec;
    const root = document.getElementById('servers');
    root.innerHTML = '';
    if (!state.servers.length) {
        root.innerHTML = '<p><em>No servers configured. Click "+ Add Server" to begin.</em></p>';
        return;
    }
    for (const s of state.servers) {
        const div = document.createElement('div');
        div.className = 'server' + (s.enabled ? '' : ' disabled');
        div.innerHTML = renderServer(s);
        root.appendChild(div);
    }
    wireServerHandlers();
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderServer(s) {
    const liveModels = state.models.filter(m => m.serverId === s.id).map(m => m.id);
    const hiddenSet = new Set(s.hiddenModels || []);
    const allKnown = Array.from(new Set([...liveModels, ...(s.hiddenModels || [])]));
    const modelRows = allKnown.length
        ? allKnown.map(id => {
            const hidden = hiddenSet.has(id);
            return '<div class="model' + (hidden ? ' hidden' : '') + '">'
                + '<input type="checkbox" data-hide="' + escapeHtml(s.id) + '|' + escapeHtml(id) + '" ' + (hidden ? '' : 'checked') + ' />'
                + '<span>' + escapeHtml(id) + '</span>'
                + '</div>';
          }).join('')
        : '<em>No models yet. Click "Test connection" or "Refresh now".</em>';

    return ''
        + '<div class="server-head">'
        + '  <h2>' + escapeHtml(s.name || s.baseUrl) + '</h2>'
        + '  <div class="row-actions">'
        + '    <button data-test="' + escapeHtml(s.id) + '" class="secondary">Test connection</button>'
        + '    <button data-remove="' + escapeHtml(s.id) + '" class="secondary">Remove</button>'
        + '  </div>'
        + '</div>'
        + '<div class="grid">'
        + '  <label>Enabled</label><div><input type="checkbox" data-f="enabled" data-id="' + s.id + '" ' + (s.enabled ? 'checked' : '') + ' /></div>'
        + '  <label>Display name</label><input type="text" data-f="name" data-id="' + s.id + '" value="' + escapeHtml(s.name) + '" />'
        + '  <label>Base URL</label><input type="text" data-f="baseUrl" data-id="' + s.id + '" value="' + escapeHtml(s.baseUrl) + '" placeholder="http://localhost:1234" />'
        + '  <label>API key</label><input type="password" data-f="apiKey" data-id="' + s.id + '" value="' + escapeHtml(s.apiKey || '') + '" />'
        + '  <label>Timeout (ms)</label><input type="number" data-f="timeoutMs" data-id="' + s.id + '" value="' + (s.timeoutMs ?? 60000) + '" min="1000" step="1000" />'
        + '  <label>Refresh override (s)</label><input type="number" data-f="refreshIntervalSec" data-id="' + s.id + '" value="' + (s.refreshIntervalSec ?? 0) + '" min="0" />'
        + '</div>'
        + '<details style="margin-top:8px"><summary>Custom headers (JSON)</summary>'
        + '  <textarea data-f="headers" data-id="' + s.id + '" rows="3" style="width:100%; margin-top:4px">' + escapeHtml(JSON.stringify(s.headers || {}, null, 2)) + '</textarea>'
        + '</details>'
        + '<div class="status" data-test-status="' + s.id + '"></div>'
        + '<div class="models">'
        + '  <h2 style="font-size:0.95em; margin:10px 0 4px">Models <small style="opacity:0.7">(uncheck to hide from Copilot)</small></h2>'
        + modelRows
        + '</div>';
}

function wireServerHandlers() {
    document.querySelectorAll('[data-f]').forEach(el => {
        const id = el.dataset.id;
        const field = el.dataset.f;
        const evt = (el.type === 'checkbox') ? 'change' : 'input';
        el.addEventListener(evt, () => {
            let value;
            if (el.type === 'checkbox') value = el.checked;
            else if (el.type === 'number') value = Number(el.value);
            else if (field === 'headers') {
                try { value = JSON.parse(el.value || '{}'); } catch { return; }
            } else value = el.value;
            setField(id, field, value);
        });
    });
    document.querySelectorAll('[data-test]').forEach(b => {
        b.addEventListener('click', () => vscode.postMessage({ type: 'testConnection', id: b.dataset.test }));
    });
    document.querySelectorAll('[data-remove]').forEach(b => {
        b.addEventListener('click', () => {
            if (confirm('Remove this server?')) vscode.postMessage({ type: 'removeServer', id: b.dataset.remove });
        });
    });
    document.querySelectorAll('[data-hide]').forEach(cb => {
        cb.addEventListener('change', () => {
            const [serverId, modelId] = cb.dataset.hide.split('|');
            vscode.postMessage({ type: 'toggleHidden', serverId, modelId });
        });
    });
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }

    dispose(): void {
        SettingsPanel.current = undefined;
        this.panel.dispose();
        for (const d of this.disposables) d.dispose();
    }
}

function randomNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
