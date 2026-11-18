import * as vscode from 'vscode';

interface WebviewMessage {
	type?: string;
	value?: string;
	theme?: string;
	level?: string;
	message?: string;
}

/**
 * 用 CustomTextEditor（webview + Vditor）实现 Markdown 所见即所得编辑。
 *
 * 同步策略：
 * - webview 是编辑主体，输入后 debounce 200ms 把全文 postMessage 给扩展宿主；
 * - 扩展宿主用 WorkspaceEdit 全量替换文档，因此 VS Code 的脏标记、保存、diff 都正常工作；
 * - 反向（外部修改文档，例如另一个源码视图、格式化插件）时再回灌 webview，
 *   靠 applying 标志位防止「改文档 → 回灌 → 再改文档」的环路。
 */
export class AwesomeMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'awesomeMarkdown.editor';

	private readonly channel: vscode.LogOutputChannel;

	private statusBar: vscode.StatusBarItem | undefined;

	private statusBarUsers = 0;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.channel = vscode.window.createOutputChannel('Awesome Markdown', { log: true });
	}

	private acquireStatusBar(): vscode.StatusBarItem {
		if (!this.statusBar) {
			this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 120);
			this.statusBar.name = 'Awesome Markdown';
		}
		this.statusBarUsers += 1;
		this.statusBar.show();
		return this.statusBar;
	}

	private releaseStatusBar(): void {
		this.statusBarUsers = Math.max(0, this.statusBarUsers - 1);
		if (this.statusBarUsers === 0 && this.statusBar) {
			this.statusBar.hide();
		}
	}

	private updateStatusBar(text: string): void {
		if (!this.statusBar) {
			return;
		}
		// 去掉空白后统计，和 Markdown 预览的字数口径接近
		const chars = text.replace(/\s+/g, '').length;
		this.statusBar.text = `$(edit) ${chars} 字`;
		this.statusBar.tooltip = `Awesome Markdown：本文 ${chars} 个非空白字符`;
	}

	public resolveCustomTextEditor(
		document: vscode.TextDocument,
		panel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): void {
		const extensionUri = this.context.extensionUri;
		const webview = panel.webview;
		this.channel.info(`open visual editor: ${document.uri.fsPath}`);
		const statusBar = this.acquireStatusBar();
		statusBar.show();
		this.updateStatusBar(document.getText());

		webview.options = {
			enableScripts: true,
			// Vditor 通过 cdn 加载 lute / highlight.js / katex 等资源，必须把包目录一并放行
			localResourceRoots: [
				vscode.Uri.joinPath(extensionUri, 'media'),
				vscode.Uri.joinPath(extensionUri, 'node_modules', 'vditor'),
			],
		};

		webview.html = this.buildHtml(webview, document);

		let pendingValue: string | undefined;
		let applying = false;
		let queue: Promise<void> = Promise.resolve();

		const applyPending = async (): Promise<void> => {
			const value = pendingValue;
			pendingValue = undefined;
			if (value === undefined || document.getText() === value) {
				return;
			}
			applying = true;
			try {
				const edit = new vscode.WorkspaceEdit();
				const end = document.positionAt(document.getText().length);
				edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), value);
				await vscode.workspace.applyEdit(edit);
			} finally {
				applying = false;
			}
		};

		const flush = (value?: string): Promise<void> => {
			if (typeof value === 'string') {
				pendingValue = value;
			}
			if (pendingValue === undefined) {
				return queue;
			}
			queue = queue.then(applyPending, applyPending);
			return queue;
		};

		const messageSub = webview.onDidReceiveMessage((raw: WebviewMessage) => {
			switch (raw?.type) {
				case 'ready': {
					this.channel.info(`webview ready: ${document.uri.fsPath}`);
					void webview.postMessage({
						type: 'init',
						value: document.getText(),
						theme: this.currentTheme(),
					});
					break;
				}
				case 'log': {
					if (raw.level === 'error') {
						this.channel.error(String(raw.message));
					} else {
						this.channel.info(String(raw.message));
					}
					break;
				}
				case 'change': {
					if (typeof raw.value === 'string') {
						this.updateStatusBar(raw.value);
					}
					void flush(typeof raw.value === 'string' ? raw.value : undefined);
					break;
				}
				case 'save': {
					// 先把手头未落盘的内容全部应用，再保存，避免存到旧内容
					void (async () => {
						await flush(typeof raw.value === 'string' ? raw.value : undefined);
						await queue;
						await applyPending();
						await document.save();
					})();
					break;
				}
			 default:
					break;
			}
		});

		const documentSub = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.uri.toString() !== document.uri.toString()) {
				return;
			}
			if (event.contentChanges.length === 0) {
				return;
			}
			if (applying) {
				return;
			}
			void webview.postMessage({ type: 'remoteSet', value: document.getText() });
		});

		const themeSub = vscode.window.onDidChangeActiveColorTheme(() => {
			void webview.postMessage({ type: 'theme', theme: this.currentTheme() });
		});

		// 保存后把「未保存」状态同步给 webview（可选，用于页脚提示）
		const saveSub = vscode.workspace.onDidSaveTextDocument((saved) => {
			if (saved.uri.toString() !== document.uri.toString()) {
				return;
			}
			void webview.postMessage({ type: 'saved' });
		});

		panel.onDidDispose(() => {
			messageSub.dispose();
			documentSub.dispose();
			themeSub.dispose();
			saveSub.dispose();
			this.releaseStatusBar();
		});
	}

	private currentTheme(): 'dark' | 'classic' {
		const config = vscode.workspace.getConfiguration('awesomeMarkdown');
		if (!config.get<boolean>('followTheme', true)) {
			return 'classic';
		}
		const kind = vscode.window.activeColorTheme.kind;
		const isDark =
			kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
		return isDark ? 'dark' : 'classic';
	}

	private buildHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
		const extensionUri = this.context.extensionUri;
		const mediaUri = vscode.Uri.joinPath(extensionUri, 'media');
		const vditorUri = vscode.Uri.joinPath(extensionUri, 'node_modules', 'vditor');

		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'style.css'));
		const vditorJsUri = webview.asWebviewUri(vscode.Uri.joinPath(vditorUri, 'dist', 'index.min.js'));
		const vditorCssUri = webview.asWebviewUri(vscode.Uri.joinPath(vditorUri, 'dist', 'index.css'));
		// Vditor 用同步 XHR 拉取图标脚本，跨源在 webview 里会被拦（NetworkError）。
		// 这里用 script 标签预加载并占用同一个 id，Vditor 检测到 id 已存在就会跳过 XHR。
		const vditorIconUri = webview.asWebviewUri(
			vscode.Uri.joinPath(vditorUri, 'dist', 'js', 'icons', 'ant.js'),
		);
		const cdn = webview.asWebviewUri(vditorUri).toString();

		const config = vscode.workspace.getConfiguration('awesomeMarkdown');
		const mode = config.get<string>('mode', 'wysiwyg');
		const showToolbar = config.get<boolean>('showToolbar', true);
		const contextMenu = config.get<boolean>('contextMenu', true);
		const taskListSort = config.get<boolean>('taskListSort', true);
		const theme = this.currentTheme();

		const nonce = getNonce();
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data: blob: https:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`font-src ${webview.cspSource} data:`,
			`script-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval'`,
			`worker-src ${webview.cspSource} blob:`,
			`connect-src ${webview.cspSource} https:`,
		].join('; ');

		const bootstrap = JSON.stringify({
			cdn,
			mode,
			showToolbar,
			contextMenu,
			taskListSort,
			theme,
			fileName: document.uri.path.split('/').pop() ?? '',
		}).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${vditorCssUri}" />
<link rel="stylesheet" href="${styleUri}" />
<title>Awesome Markdown</title>
</head>
<body data-theme="${theme === 'dark' ? 'dark' : 'light'}">
<div id="app"></div>
<script nonce="${nonce}">window.__AWESOME__ = ${bootstrap};</script>
<script id="vditorIconScript" src="${vditorIconUri}"></script>
<script src="${vditorJsUri}"></script>
<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i += 1) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
