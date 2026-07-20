import * as vscode from 'vscode';
import { DiscoveredModel, ModelRegistry } from './modelProvider';
import { getServers, setServers, getDedupeAcrossServers, LMServerConfig } from './config';

type Node = ServerNode | ModelNode | DupToggleNode;

class ServerNode {
    readonly kind = 'server' as const;
    constructor(public readonly server: LMServerConfig, public readonly modelCount: number) {}
}
class ModelNode {
    readonly kind = 'model' as const;
    constructor(
        public readonly server: LMServerConfig,
        public readonly modelId: string,
        public readonly hidden: boolean,
        public readonly duplicateOf?: string,
        public readonly alsoOn?: string[],
        /** Set when this server's copy is deduped away — the named server provides it. */
        public readonly providedBy?: string
    ) {}
}
/** "N duplicate model(s) hidden/shown" row — toggles showDuplicateModels per server. */
class DupToggleNode {
    readonly kind = 'dupToggle' as const;
    constructor(public readonly server: LMServerConfig, public readonly hiddenCount: number, public readonly showing: boolean) {}
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
        if (node.kind === 'dupToggle') {
            const item = new vscode.TreeItem(
                node.showing
                    ? `Showing ${node.hiddenCount} duplicate model(s)`
                    : `${node.hiddenCount} duplicate model(s) hidden`,
                vscode.TreeItemCollapsibleState.None
            );
            item.iconPath = new vscode.ThemeIcon(node.showing ? 'eye' : 'eye-closed');
            item.description = node.showing ? 'click to hide' : 'click to show';
            item.tooltip = 'Models also provided by another configured server (LM Link mirrors). Click to toggle their visibility for this server.';
            item.command = {
                command: 'lmstudioCopilot.toggleShowDuplicates',
                title: 'Toggle duplicate models',
                arguments: [node.server.id]
            };
            return item;
        }
        const item = new vscode.TreeItem(node.modelId, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(
            node.hidden ? 'eye-closed' : (node.duplicateOf || node.providedBy) ? 'copy' : 'symbol-method'
        );
        item.contextValue = node.hidden ? 'modelHidden' : 'modelVisible';
        item.command = {
            command: 'lmstudioCopilot.toggleModelHidden',
            title: 'Toggle model visibility',
            arguments: [node.server.id, node.modelId]
        };
        if (node.hidden) {
            item.description = 'hidden';
        } else if (node.duplicateOf) {
            item.description = `duplicate of ${node.duplicateOf}`;
        } else if (node.providedBy) {
            item.description = `provided by ${node.providedBy}`;
        } else if (node.alsoOn && node.alsoOn.length > 0) {
            item.description = `also on ${node.alsoOn.join(', ')}`;
        }
        return item;
    }

    getChildren(node?: Node): Node[] {
        if (!node) {
            // Count each server's OWN listing, not the deduped view — a mirrored
            // server showing "0 models" would look broken.
            const raw = this.registry.getRawModels();
            return getServers().map(s =>
                new ServerNode(s, raw.filter(m => m.server.id === s.id).length));
        }
        if (node.kind === 'server') {
            const visibleHere = new Map(
                this.models
                    .filter(m => m.server.id === node.server.id)
                    .map(m => [m.model.id, m])
            );
            const primaryFor = (modelId: string) =>
                this.models.find(m => m.model.id === modelId && !m.isDuplicate)?.server.name;
            const out: Node[] = [];
            let dedupedAway = 0;
            for (const rm of this.registry.getRawModels().filter(m => m.server.id === node.server.id)) {
                const vis = visibleHere.get(rm.model.id);
                if (vis) {
                    out.push(new ModelNode(
                        node.server, rm.model.id, false,
                        vis.isDuplicate ? vis.alsoOn?.[0] : undefined,
                        vis.isDuplicate ? undefined : vis.alsoOn
                    ));
                } else {
                    // This server's copy is not in the picker — deduped away (or the
                    // model identity is hidden). Show it dimmed with its provider.
                    const provider = primaryFor(rm.model.id);
                    out.push(new ModelNode(node.server, rm.model.id, false, undefined, undefined,
                        provider ?? 'dedupe'));
                    if (provider) dedupedAway++;
                }
            }
            out.push(...(node.server.hiddenModels ?? []).map(
                id => new ModelNode(node.server, id, true)
            ));
            if (getDedupeAcrossServers() && (dedupedAway > 0 || node.server.showDuplicateModels)) {
                const showing = node.server.showDuplicateModels === true;
                const count = showing
                    ? this.models.filter(m => m.server.id === node.server.id && m.isDuplicate).length
                    : dedupedAway;
                if (count > 0) out.push(new DupToggleNode(node.server, count, showing));
            }
            return out;
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

export async function toggleShowDuplicates(serverId: string): Promise<void> {
    const servers = getServers();
    const s = servers.find(x => x.id === serverId);
    if (!s) return;
    s.showDuplicateModels = !s.showDuplicateModels;
    await setServers(servers);
}
