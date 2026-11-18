import * as vscode from 'vscode';

/** 大纲里的一个标题节点 */
export interface HeadingNode {
	level: number;
	text: string;
	line: number;
	/** 在全文标题序列中的序号，webview 侧按它优先定位 */
	index: number;
	children: HeadingNode[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * 从 Markdown 文本里抽出标题树。
 * 跳过代码围栏内的内容，否则 ``` 里的 # 注释会被误认成标题。
 */
export function parseHeadings(markdown: string): HeadingNode[] {
	const lines = markdown.split(/\r?\n/);
	const flat: HeadingNode[] = [];
	let inFence = false;
	let index = 0;

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}
		const match = HEADING_RE.exec(line);
		if (!match) {
			continue;
		}
		flat.push({
			level: match[1].length,
			text: match[2].trim(),
			line: i,
			index: index,
			children: [],
		});
		index += 1;
	}

	const roots: HeadingNode[] = [];
	const stack: HeadingNode[] = [];
	flat.forEach((node) => {
		while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
			stack.pop();
		}
		if (stack.length > 0) {
			stack[stack.length - 1].children.push(node);
		} else {
			roots.push(node);
		}
		stack.push(node);
	});
	return roots;
}

/** 当前标签页是不是本插件的可视化编辑器，是则返回其文档 URI */
export function activeVisualUri(): vscode.Uri | undefined {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputCustom && input.viewType === 'awesomeMarkdown.editor') {
		return input.uri;
	}
	return undefined;
}

const LEVEL_ICONS = [
	'symbol-file',
	'symbol-constant',
	'symbol-method',
	'symbol-field',
	'symbol-variable',
	'symbol-class',
	'symbol-property',
];

export class OutlineTreeProvider implements vscode.TreeDataProvider<HeadingNode> {
	private readonly emitter = new vscode.EventEmitter<void>();

	public readonly onDidChangeTreeData = this.emitter.event;

	private roots: HeadingNode[] = [];

	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		// 切换标签页、文档内容变化（含 webview 回写）都会影响大纲
		vscode.window.tabGroups.onDidChangeTabs(() => this.schedule(), null, context.subscriptions);
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.languageId === 'markdown') {
				this.schedule();
			}
		}, null, context.subscriptions);
		context.subscriptions.push(this.emitter);
	}

	private schedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			void this.refresh();
		}, 150);
	}

	public async refresh(): Promise<void> {
		const uri = activeVisualUri();
		if (!uri) {
			this.roots = [];
			this.emitter.fire();
			return;
		}
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			this.roots = parseHeadings(document.getText());
		} catch {
			this.roots = [];
		}
		this.emitter.fire();
	}

	public getTreeItem(node: HeadingNode): vscode.TreeItem {
		const collapsible =
			node.children.length > 0
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(node.text || '(空标题)', collapsible);
		item.id = `aw-h-${node.index}`;
		item.description = `H${node.level}`;
		item.tooltip = node.text;
		item.iconPath = new vscode.ThemeIcon(LEVEL_ICONS[node.level] ?? 'symbol-method');
		item.command = {
			command: 'awesomeMarkdown.revealHeading',
			title: '跳转到标题',
			arguments: [node.index, node.level, node.text],
		};
		return item;
	}

	public getChildren(node?: HeadingNode): HeadingNode[] {
		return node ? node.children : this.roots;
	}
}
