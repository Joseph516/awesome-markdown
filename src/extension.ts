import * as vscode from 'vscode';
import { AwesomeMarkdownEditorProvider } from './markdownEditorProvider';

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
