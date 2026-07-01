import * as vscode from 'vscode';
import { DiscoveredModel, ModelRegistry } from './modelProvider';
import { getServers, setServers, LMServerConfig } from './config';

type Node = ServerNode | ModelNode;

class ServerNode {
    readonly kind = 'server' as const;
    constructor(public readonly server: LMServerConfig, public readonly modelCount: number) {}
}
class ModelNode {
    readonly kind = 'model' as const;
    constructor(public readonly server: LMServerConfig, public readonly modelId: string, public readonly hidden: boolean) {}
}

export class ServersTreeProvider implements vscode.TreeDataProvider<Node> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    private models: DiscoveredModel[] = [];

    constructor(private readonly registry: ModelRegistry) {
        registry.onModelsChanged(m => {
            this.models = m;
            this._onDidChange.fire();
        });
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'server') {
            const item = new vscode.TreeItem(
                `${node.server.name}  ·  ${node.modelCount} model(s)`,
                vscode.TreeItemCollapsibleState.Expanded
            );
            item.description = node.server.baseUrl;
            item.contextValue = node.server.enabled ? 'serverEnabled' : 'serverDisabled';
            item.iconPath = new vscode.ThemeIcon(node.server.enabled ? 'server-environment' : 'circle-slash');
            item.tooltip = `${node.server.baseUrl}\nEnabled: ${node.server.enabled}`;
            return item;
        }
        const item = new vscode.TreeItem(node.modelId, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.hidden ? 'eye-closed' : 'symbol-method');
        item.contextValue = node.hidden ? 'modelHidden' : 'modelVisible';
        item.command = {
            command: 'lmstudioCopilot.toggleModelHidden',
            title: 'Toggle model visibility',
            arguments: [node.server.id, node.modelId]
        };
        item.description = node.hidden ? 'hidden' : undefined;
        return item;
    }

    getChildren(node?: Node): Node[] {
        if (!node) {
            const servers = getServers();
            return servers.map(s => {
                const count = this.models.filter(m => m.server.id === s.id).length;
                return new ServerNode(s, count);
            });
        }
        if (node.kind === 'server') {
            const visible = this.models
                .filter(m => m.server.id === node.server.id)
                .map(m => new ModelNode(node.server, m.model.id, false));
            const hidden = (node.server.hiddenModels ?? []).map(
                id => new ModelNode(node.server, id, true)
            );
            return [...visible, ...hidden];
        }
        return [];
    }
}

export async function toggleModelHidden(serverId: string, modelId: string): Promise<void> {
    const servers = getServers();
    const s = servers.find(x => x.id === serverId);
    if (!s) return;
    const hidden = new Set(s.hiddenModels ?? []);
    if (hidden.has(modelId)) hidden.delete(modelId);
    else hidden.add(modelId);
    s.hiddenModels = [...hidden];
    await setServers(servers);
}
