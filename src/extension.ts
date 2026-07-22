import * as vscode from 'vscode';
import { getServers, setServers, getShowStatusBar, cryptoRandomId } from './config';
import { ModelRegistry } from './modelProvider';
import { ServersTreeProvider, toggleModelHidden, toggleShowDuplicates } from './serversTree';
import { SettingsPanel } from './settingsPanel';

let registry: ModelRegistry;
let statusBar: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const log = vscode.window.createOutputChannel('LM-CODE');
    context.subscriptions.push(log);

    registry = new ModelRegistry(log);
    context.subscriptions.push(registry);

    const tree = new ServersTreeProvider(registry);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('lmstudioCopilot.servers', tree)
    );

    // Status bar.
    if (getShowStatusBar()) {
        statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
        statusBar.command = 'lmstudioCopilot.openSettings';
        statusBar.tooltip = 'Open LM-CODE settings';
        context.subscriptions.push(statusBar);
        context.subscriptions.push(
            registry.onModelsChanged(models => {
                if (!statusBar) return;
                statusBar.text = `$(server) LM-Code: ${models.length}`;
                statusBar.show();
            })
        );
    }

    // Commands.
    context.subscriptions.push(
        vscode.commands.registerCommand('lmstudioCopilot.openSettings', () => {
            SettingsPanel.show(context, registry);
        }),
        vscode.commands.registerCommand('lmstudioCopilot.refreshNow', async () => {
            await registry.refreshAll();
            vscode.window.setStatusBarMessage('LM-Code: refreshed', 2000);
        }),
        vscode.commands.registerCommand('lmstudioCopilot.addServer', async () => {
            const servers = getServers();
            servers.push({
                id: cryptoRandomId(),
                name: 'New LM Studio',
                baseUrl: 'http://localhost:1234',
                apiKey: '',
                enabled: true,
                timeoutMs: 300000,
                headers: {},
                refreshIntervalSec: 0,
                hiddenModels: []
            });
            await setServers(servers);
            SettingsPanel.show(context, registry);
        }),
        vscode.commands.registerCommand('lmstudioCopilot.toggleModelHidden',
            (serverId: string, modelId: string) => toggleModelHidden(serverId, modelId)
        ),
        vscode.commands.registerCommand('lmstudioCopilot.toggleShowDuplicates',
            (serverId: string) => toggleShowDuplicates(serverId)
        ),
        vscode.commands.registerCommand('lmstudioCopilot.exportConfig', () =>
            vscode.commands.executeCommand('lmstudioCopilot.openSettings')
        ),
        vscode.commands.registerCommand('lmstudioCopilot.importConfig', () =>
            vscode.commands.executeCommand('lmstudioCopilot.openSettings')
        )
    );

    registry.start();
}

export function deactivate(): void {
    registry?.dispose();
    statusBar?.dispose();
}
