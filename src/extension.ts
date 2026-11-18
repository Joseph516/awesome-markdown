import * as vscode from 'vscode';
import { AwesomeMarkdownEditorProvider } from './markdownEditorProvider';
import { OutlineTreeProvider, activeVisualUri } from './outline';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new AwesomeMarkdownEditorProvider(context);

	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			AwesomeMarkdownEditorProvider.viewType,
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		),
	);

	/*
	 * VS Code 原生 Outline 绑定在文本编辑器上，自定义编辑器打开时它拿不到 symbol，
	 * 所以这里自带一个大纲视图：解析标题树，点击后让 webview 内部滚动定位。
	 */
	const outline = new OutlineTreeProvider(context);
	const treeView = vscode.window.createTreeView('awesomeMarkdown.outline', {
		treeDataProvider: outline,
		showCollapseAll: true,
	});
	context.subscriptions.push(treeView);
	void outline.refresh();

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'awesomeMarkdown.revealHeading',
			(index: number, level: number, text: string) => {
				const uri = activeVisualUri();
				if (!uri) {
					return;
				}
				const webview = provider.getWebview(uri);
				void webview?.postMessage({ type: 'reveal', index, level, text });
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('awesomeMarkdown.openVisual', async (uri?: vscode.Uri) => {
			const target = resolveTarget(uri);
			if (!target) {
				void vscode.window.showInformationMessage('请先打开一个 Markdown 文件。');
				return;
			}
			await vscode.commands.executeCommand(
				'vscode.openWith',
				target,
				AwesomeMarkdownEditorProvider.viewType,
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('awesomeMarkdown.openSource', async (uri?: vscode.Uri) => {
			const target = resolveTarget(uri);
			if (!target) {
				void vscode.window.showInformationMessage('请先打开一个 Markdown 文件。');
				return;
			}
			// 直接走文本编辑器，绕开 editorAssociations：
			// openWith(..., 'default') 会遵循关联设置，可能又打开 Markdown 预览而不是纯文本
			const document = await vscode.workspace.openTextDocument(target);
			await vscode.window.showTextDocument(document, { preview: false });
		}),
	);
}

export function deactivate(): void {
	// noop
}

function resolveTarget(uri?: vscode.Uri): vscode.Uri | undefined {
	if (uri instanceof vscode.Uri) {
		return uri;
	}
	const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
	const input = activeTab?.input;
	if (input instanceof vscode.TabInputCustom) {
		return input.uri;
	}
	if (input instanceof vscode.TabInputText) {
		return input.uri;
	}
	if (input instanceof vscode.TabInputTextDiff) {
		return input.modified;
	}
	return vscode.window.activeTextEditor?.document.uri;
}
