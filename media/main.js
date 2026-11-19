(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const cfg = window.__AWESOME__ || {};

	/** webview 内部的异常/状态回写到扩展日志通道，便于排障 */
	function report(level, message) {
		try {
			vscode.postMessage({ type: 'log', level: level, message: String(message) });
		} catch (error) {
			/* 忽略 */
		}
	}

	window.addEventListener('error', function (event) {
		report(
			'error',
			(event.message || 'unknown error') + ' @ ' + (event.filename || '') + ':' + (event.lineno || 0),
		);
	});

	window.addEventListener('unhandledrejection', function (event) {
		report('error', 'unhandled rejection: ' + String(event.reason));
	});

	const state = {
		vditor: null,
		/** 抑制回环：程序化 setValue 时不要把内容再发回扩展宿主 */
		suppress: false,
		/** 上一次已经同步给扩展宿主的内容，用于去重 */
		lastSent: null,
		timer: 0,
		/** 任务列表重排的防抖定时器 */
		taskTimer: 0,
		menu: null,
	};

	const EDITOR_ROOTS = '.vditor-wysiwyg, .vditor-ir, .vditor-sv';

	/* ------------------------------------------------------------------ */
	/* 同步                                                               */
	/* ------------------------------------------------------------------ */

	function syncNow() {
		const vditor = state.vditor;
		if (!vditor || state.suppress) {
			return;
		}
		const value = vditor.getValue();
		if (value === state.lastSent) {
			return;
		}
		state.lastSent = value;
		vscode.postMessage({ type: 'change', value });
	}

	function scheduleSync() {
		if (state.suppress) {
			return;
		}
		window.clearTimeout(state.timer);
		state.timer = window.setTimeout(syncNow, 200);
	}

	/* ------------------------------------------------------------------ */
	/* 任务列表排序：勾选后已完成项沉底（类似 macOS 备忘录）              */
	/* ------------------------------------------------------------------ */

	/** 该列表项是否已经勾选完成 */
	function isCheckedItem(item) {
		const box = item.querySelector('input[type=checkbox]');
		return !!(box && box.checked);
	}

	/**
	 * 只重排「当前所在的那一个列表」：把已完成的 li 挪到列表末尾。
	 * 不调用 setValue，所以不会重建编辑器，光标和滚动位置都保持；
	 * 挪完 DOM 之后 Vditor 的 getValue() 会按新顺序生成 markdown。
	 */
	function reorderCurrentList(list) {
		const items = Array.prototype.slice.call(list.querySelectorAll(':scope > li'));
		if (items.length < 2) {
			return false;
		}
		// 顺序已经正确时不做任何移动：出现已完成项之后又出现未完成项才需要重排
		let seenDone = false;
		let needMove = false;
		items.forEach(function (item) {
			if (isCheckedItem(item)) {
				seenDone = true;
			} else if (seenDone) {
				needMove = true;
			}
		});
		if (!needMove) {
			return false;
		}
		items.forEach(function (item) {
			if (isCheckedItem(item)) {
				list.appendChild(item);
			}
		});
		return true;
	}

	/**
	 * 任务列表回车时 Vditor 会把新行插到上面，并把勾选状态一起带过去，
	 * 原来那一项反而被重置成未勾选。这里回车后把状态摆回原位：
	 * 空的新项一律未勾选，原来的项按文本找回自己的勾选状态。
	 */
	function normalizeNewTaskItems(list, snapshot) {
		Array.prototype.slice.call(list.children).forEach(function (item) {
			let box = item.querySelector('input[type=checkbox]');
			const text = String(item.textContent || '')
				.replace(/\u200b/g, '')
				.trim();
			if (!box && !text) {
				box = document.createElement('input');
				box.type = 'checkbox';
				item.insertBefore(box, item.firstChild);
				item.insertBefore(document.createTextNode(' '), box.nextSibling);
			}
			if (!box) {
				return;
			}
			if (!text) {
				box.checked = false;
				box.removeAttribute('checked');
				return;
			}
			for (let i = 0; i < snapshot.length; i += 1) {
				if (snapshot[i].text === text && snapshot[i].checked && !box.checked) {
					box.checked = true;
					box.setAttribute('checked', '');
					break;
				}
			}
		});
	}

	/** 从节点往上找任务列表项（li 内必须带复选框） */
	function taskItemFromNode(node) {
		if (!node) {
			return null;
		}
		const el = node.nodeType === 3 ? node.parentElement : node;
		if (!el || !el.closest) {
			return null;
		}
		const item = el.closest('li');
		if (!item || !item.querySelector('input[type=checkbox]')) {
			return null;
		}
		return item;
	}

	let currentTaskItem = null;

	/** 回车前记下每一项的文本与勾选状态，回车后 60ms 把新项和原项的状态摆正 */
	function guardTaskListEnter() {
		// 光标在编辑器里时 focus 始终落在整个编辑区，只能靠选区判断处于哪个任务项
		document.addEventListener('selectionchange', function () {
			const sel = window.getSelection();
			currentTaskItem = sel && sel.rangeCount ? taskItemFromNode(sel.getRangeAt(0).startContainer) : null;
		});

		document.addEventListener(
			'keydown',
			function (event) {
				if (
					event.key !== 'Enter' ||
					event.shiftKey ||
					event.ctrlKey ||
					event.metaKey ||
					event.isComposing
				) {
					return;
				}
				const sel = window.getSelection();
				const live = sel && sel.rangeCount ? taskItemFromNode(sel.getRangeAt(0).startContainer) : null;
				const item = live || (currentTaskItem && currentTaskItem.isConnected ? currentTaskItem : null);
				if (!item) {
					return;
				}
				const list = item.parentElement;
				if (!list || list.tagName !== 'UL') {
					return;
				}
				// 项首回车自己处理：交给 Vditor 会把复选框和文字拆成两块
				const selection = window.getSelection();
				if (selection && selection.rangeCount) {
					const range = selection.getRangeAt(0);
					const pre = document.createRange();
					pre.setStart(item, 0);
					pre.setEnd(range.startContainer, range.startOffset);
					if (!pre.toString().replace(/\u200b/g, '').trim()) {
						event.preventDefault();
						event.stopPropagation();
						const blank = document.createElement('li');
						// 任务项在 Vditor 里靠 class 和 data-marker 变成复选框样式，缺了会多出一个圆点
						blank.className = 'vditor-task';
						blank.setAttribute('data-marker', item.getAttribute('data-marker') || '-');
						const box = document.createElement('input');
						box.type = 'checkbox';
						blank.appendChild(box);
						blank.appendChild(document.createTextNode(' '));
						list.insertBefore(blank, item);
						const caret = document.createRange();
						caret.setStart(blank.lastChild, 0);
						caret.collapse(true);
						selection.removeAllRanges();
						selection.addRange(caret);
						syncNow();
						return;
					}
				}
				const snapshot = Array.prototype.slice.call(list.children).map(function (li) {
					const box = li.querySelector('input[type=checkbox]');
					return {
						text: String(li.textContent || '')
							.replace(/\u200b/g, '')
							.trim(),
						checked: box ? box.checked : false,
					};
				});
				window.setTimeout(function () {
					normalizeNewTaskItems(list, snapshot);
					syncNow();
				}, 60);
			},
			true,
		);
	}

	document.addEventListener('change', function (event) {
		if (cfg.taskListSort === false) {
			return;
		}
		const target = event.target;
		if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') {
			return;
		}
		if (!target.closest(EDITOR_ROOTS)) {
			return;
		}
		window.clearTimeout(state.taskTimer);
		state.taskTimer = window.setTimeout(function () {
			const item = target.closest('li');
			const list = item && item.parentElement;
			if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) {
				return;
			}
			if (reorderCurrentList(list)) {
				syncNow();
			}
		}, 250);
	});

	/* ------------------------------------------------------------------ */
	/* Vditor                                                             */
	/* ------------------------------------------------------------------ */

	const toolbar = [
		'headings', 'bold', 'italic', 'strike', '|',
		'list', 'ordered-list', 'check', 'quote', '|',
		'table', 'code', 'inline-code', '|',
		'link', '|', 'undo', 'redo',
	];

	/* 工具栏按钮的悬浮说明用中文，Vditor 默认给的是英文 */
	const TOOLBAR_LABELS = {
		headings: '标题',
		bold: '粗体',
		italic: '斜体',
		strike: '删除线',
		list: '无序列表',
		'ordered-list': '有序列表',
		check: '任务列表',
		quote: '引用',
		line: '分割线',
		code: '代码块',
		'inline-code': '行内代码',
		table: '插入表格',
		link: '插入链接',
		upload: '上传图片或附件',
		undo: '撤销',
		redo: '重做',
		outdent: '减少缩进',
		indent: '增加缩进',
		'insert-before': '在前面插入',
		'insert-after': '在后面插入',
		outline: '大纲',
		both: '分屏预览',
		'edit-mode': '编辑模式',
		preview: '预览',
		fullscreen: '全屏',
		export: '导出',
		info: '关于',
		help: '帮助',
	};

	/* 工具栏按钮的图标名：优先取 data-type，取不到就从 <use xlink:href="#vditor-icon-xxx"> 里解析 */
	function toolbarType(button) {
		const type = button.getAttribute('data-type');
		if (type) {
			return type;
		}
		const use = button.querySelector('use');
		const href = use && (use.getAttribute('xlink:href') || use.getAttribute('href'));
		return href ? href.replace(/^#vditor-icon-/, '') : '';
	}

	function localizeToolbar() {
		document.querySelectorAll('.vditor-toolbar__item').forEach(function (button) {
			const label = TOOLBAR_LABELS[toolbarType(button)];
			if (label) {
				button.setAttribute('aria-label', label);
				button.setAttribute('title', label);
			}
			// Vditor 的 tooltip 是 CSS 伪元素读 aria-label，必须补上 vditor-tooltipped 类才会显示
			button.classList.add('vditor-tooltipped', 'vditor-tooltipped__s');
		});
	}

	const vditor = new Vditor('app', {
		cdn: cfg.cdn,
		mode: cfg.mode || 'wysiwyg',
		theme: cfg.theme === 'dark' ? 'dark' : 'classic',
		icon: 'ant',
		lang: 'zh_CN',
		height: '100%',
		width: '100%',
		cache: { enable: false },
		toolbar: cfg.showToolbar === false ? [] : toolbar,
		// 字数统计交给 VS Code 状态栏，webview 内不再显示（其 tooltip 会被标签栏裁切）
		counter: { enable: false },
		resize: { enable: false },
		placeholder: '开始输入 Markdown…',
		tab: '    ',
		preview: {
			delay: 0,
			hljs: { lineNumber: true, style: cfg.theme === 'dark' ? 'github-dark' : 'github' },
			theme: { current: cfg.theme === 'dark' ? 'dark' : 'light' },
			math: { engine: 'KaTeX' },
		},
		input: () => scheduleSync(),
		after: () => {
			state.vditor = vditor;
			localizeToolbar();
			setupHeadingFold();
			guardTaskListEnter();
			window.__awNormalizeNewTaskItems = normalizeNewTaskItems;
			report('info', 'webview ready (mode=' + (cfg.mode || 'wysiwyg') + ')');
			vscode.postMessage({ type: 'ready' });
		},
	});

	window.addEventListener('message', (event) => {
		const msg = event.data || {};
		if (!state.vditor) {
			return;
		}
		switch (msg.type) {
			case 'init':
				state.suppress = true;
				state.vditor.setValue(msg.value || '', true);
				state.lastSent = msg.value || '';
				state.suppress = false;
				window.setTimeout(restoreFolds, 30);
				if (msg.theme) {
					applyTheme(msg.theme);
				}
				break;
			case 'remoteSet':
				if (msg.value === state.vditor.getValue()) {
					break;
				}
				state.suppress = true;
				state.vditor.setValue(msg.value || '', true);
				state.lastSent = msg.value || '';
				state.suppress = false;
				break;
			case 'theme':
				applyTheme(msg.theme);
				break;
			case 'reveal':
				revealHeading(msg);
				break;
			default:
				break;
		}
	});

	function applyTheme(theme) {
		const dark = theme === 'dark';
		document.body.dataset.theme = dark ? 'dark' : 'light';
		if (state.vditor) {
			state.vditor.setTheme(dark ? 'dark' : 'classic');
		}
		if (state.vditor && state.vditor.vditor && state.vditor.vditor.preview) {
			try {
				state.vditor.vditor.preview.theme = dark ? 'dark' : 'light';
			} catch (error) {
				/* 忽略 */
			}
		}
	}

	/* 保存：webview 里的 Cmd/Ctrl+S 不会触发 VS Code 的保存，需要自己转发 */
	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape' && state.menu) {
			event.preventDefault();
			event.stopPropagation();
			closeMenu();
			return;
		}
		if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 's') {
			event.preventDefault();
			event.stopPropagation();
			window.clearTimeout(state.timer);
			syncNow();
			vscode.postMessage({
				type: 'save',
				value: state.vditor ? state.vditor.getValue() : undefined,
			});
		}
	}, true);

	/* ------------------------------------------------------------------ */
	/* 标题折叠：点标题左侧三角，收起该标题管辖的后续块                   */
	/* ------------------------------------------------------------------ */

	const FOLD_HEAD = /^H[1-6]$/;
	/** 折叠状态按「级别 + 标题文本」记录，DOM 重建后据此恢复 */
	const foldState = new Map();
	let foldTimer = 0;

	function foldKey(head) {
		return head.tagName + ':' + String(head.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
	}

	function foldRoots() {
		return Array.prototype.slice.call(document.querySelectorAll(EDITOR_ROOTS));
	}

	/** 标题管辖范围：从标题往下，直到同级或更高级标题为止 */
	function headingScope(head) {
		const level = Number(String(head.tagName).slice(1));
		const parent = head.parentElement;
		if (!parent) {
			return [];
		}
		const children = Array.prototype.slice.call(parent.children);
		const start = children.indexOf(head);
		const blocks = [];
		for (let i = start + 1; i < children.length; i += 1) {
			const el = children[i];
			const match = /^H([1-6])$/.exec(String(el.tagName).toUpperCase());
			if (match && parseInt(match[1], 10) <= level) {
				break;
			}
			blocks.push(el);
		}
		return blocks;
	}

	function applyFold(head, folded) {
		headingScope(head).forEach(function (block) {
			block.classList.toggle('aw-fold-hidden', folded);
		});
		head.classList.toggle('aw-folded', folded);
		head.setAttribute('aria-expanded', folded ? 'false' : 'true');
	}

	/** setValue 重建 DOM 之后，把之前的折叠状态重新贴回标题 */
	function restoreFolds() {
		foldRoots().forEach(function (root) {
			Array.prototype.forEach.call(root.querySelectorAll('h1, h2, h3, h4, h5, h6'), function (head) {
				if (foldState.get(foldKey(head))) {
					applyFold(head, true);
				}
			});
		});
	}

	function toggleFold(head) {
		const folded = !head.classList.contains('aw-folded');
		if (folded) {
			foldState.set(foldKey(head), true);
		} else {
			foldState.delete(foldKey(head));
		}
		applyFold(head, folded);
	}

	/** 命中标题左侧 20px 的竖条热区（折叠三角正好覆盖这段） */
	function headingAtHotspot(x, y) {
		const heads = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
		for (let i = 0; i < heads.length; i += 1) {
			const head = heads[i];
			if (!head.closest(EDITOR_ROOTS)) {
				continue;
			}
			const rect = head.getBoundingClientRect();
			// 热区就是三角本身（标题左边界外 18px ~ 2px，三角占 13px 中心）
			if (y >= rect.top && y <= rect.bottom && x >= rect.left - 18 && x <= rect.left - 2) {
				return head;
			}
		}
		return null;
	}

	function setupHeadingFold() {
		if (cfg.headingFold === false) {
			return;
		}
		document.addEventListener(
			'click',
			function (event) {
				const head = headingAtHotspot(event.clientX, event.clientY);
				if (!head) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				toggleFold(head);
			},
			true,
		);
		// 折叠区上方继续输入时，新增的块也要跟着收起，避免"半折叠"
		document.addEventListener('input', function () {
			window.clearTimeout(foldTimer);
			foldTimer = window.setTimeout(function () {
				foldRoots().forEach(function (root) {
					Array.prototype.forEach.call(root.querySelectorAll('h1, h2, h3, h4, h5, h6'), function (head) {
						if (head.classList.contains('aw-folded')) {
							applyFold(head, true);
						}
					});
				});
			}, 150);
		});
	}

	/** 大纲点某条标题时，在编辑器里定位到它 */
	function revealHeading(msg) {
		const root =
			document.querySelector('.vditor-wysiwyg .vditor-reset') ||
			document.querySelector('.vditor-ir .vditor-reset');
		if (!root) {
			return;
		}
		const heads = Array.prototype.slice.call(root.querySelectorAll('h1, h2, h3, h4, h5, h6'));
		const target = pickHeading(heads, msg);
		if (!target) {
			return;
		}
		unfoldHeadingChain(heads, target);
		target.scrollIntoView({ block: 'center', behavior: 'smooth' });
		target.classList.add('aw-reveal-flash');
		window.setTimeout(function () {
			target.classList.remove('aw-reveal-flash');
		}, 1200);
	}

	function pickHeading(heads, msg) {
		function norm(value) {
			return String(value || '')
				.replace(/\s+/g, ' ')
				.replace(/[*_`~]/g, '')
				.trim();
		}
		const expectedTag = typeof msg.level === 'number' ? 'H' + msg.level : '';
		const byIndex = typeof msg.index === 'number' ? heads[msg.index] : undefined;
		// 序号是全文标题顺序，加上层级校验足够可靠；标题里带 ** 等标记时也照样能定位
		if (byIndex && (!expectedTag || byIndex.tagName === expectedTag)) {
			return byIndex;
		}
		if (msg.text) {
			const matched = heads.filter(function (head) {
				return norm(head.textContent) === norm(msg.text);
			})[0];
			if (matched) {
				return matched;
			}
		}
		return null;
	}

	/** 目标标题若被上层标题折叠了，先把那几层展开 */
	function unfoldHeadingChain(heads, target) {
		const level = Number(target.tagName.slice(1));
		heads.forEach(function (head) {
			if (head === target || !head.classList.contains('aw-folded')) {
				return;
			}
			if (!(head.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)) {
				return;
			}
			if (Number(head.tagName.slice(1)) >= level) {
				return;
			}
			foldState.delete(foldKey(head));
			applyFold(head, false);
		});
	}

	/* ------------------------------------------------------------------ */
	/* 右键菜单                                                           */
	/* ------------------------------------------------------------------ */

	function closeMenu() {
		if (state.menu) {
			state.menu.remove();
			state.menu = null;
		}
		state.menuAnchor = null;
	}

	function clamp(value, min, max) {
		if (!Number.isFinite(value)) {
			return min;
		}
		return Math.min(max, Math.max(min, value));
	}

	function groupLabel(text) {
		const div = document.createElement('div');
		div.className = 'aw-menu-group';
		div.textContent = text;
		return div;
	}

	function subItem(label, onClick) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'aw-sub-item';
		button.textContent = label;
		button.addEventListener('click', function (event) {
			event.stopPropagation();
			onClick();
		});
		return button;
	}

	function menuIcon(name) {
		if (!name) {
			return null;
		}
		// 没有对应图标时用符号兜底（例如数学公式的 Σ）
		if (!/^[a-z][a-z-]*$/.test(name)) {
			const span = document.createElement('span');
			span.className = 'aw-menu-icon aw-menu-icon--text';
			span.textContent = name;
			return span;
		}
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'aw-menu-icon');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('aria-hidden', 'true');
		const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
		use.setAttribute('href', '#vditor-icon-' + name);
		use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#vditor-icon-' + name);
		svg.appendChild(use);
		return svg;
	}

	function menuItem(label, handler, submenuFactory, iconName) {
		const row = document.createElement('div');
		row.className = 'aw-menu-item';
		row.setAttribute('role', 'menuitem');
		row.tabIndex = 0;

		const labelWrap = document.createElement('span');
		labelWrap.className = 'aw-menu-label';
		const glyph = menuIcon(iconName);
		if (glyph) {
			labelWrap.appendChild(glyph);
		}
		const text = document.createElement('span');
		text.textContent = label;
		labelWrap.appendChild(text);
		row.appendChild(labelWrap);

		if (!submenuFactory) {
			row.addEventListener('click', function (event) {
				event.stopPropagation();
				closeMenu();
				handler();
			});
			return row;
		}

		const arrow = document.createElement('span');
		arrow.className = 'aw-menu-arrow';
		arrow.textContent = '▸';
		row.appendChild(arrow);

		let sub = null;
		row.addEventListener('click', function (event) {
			event.stopPropagation();
			if (sub) {
				sub.remove();
				sub = null;
				arrow.textContent = '▸';
				requestAnimationFrame(repositionMenu);
				return;
			}
			sub = submenuFactory();
			sub.className = 'aw-submenu';
			row.after(sub);
			arrow.textContent = '▾';
			// 展开后菜单变高，需要立刻重新贴边，否则底部会落到视口外；
			// 再把当前项滚到可视区内，避免点靠下的项展开后看不到子菜单
			requestAnimationFrame(function () {
				repositionMenu();
				if (sub) {
					sub.scrollIntoView({ block: 'nearest' });
				}
			});
		});
		return row;
	}

	function headingSubmenu() {
		const box = document.createElement('div');
		[1, 2, 3, 4].forEach(function (level) {
			box.appendChild(subItem('H' + level + ' 标题', function () {
				closeMenu();
				insertMarkdown('\n\n' + repeat('#', level) + ' 标题 ' + level + '\n\n');
			}));
		});
		return box;
	}

	function repeat(char, times) {
		let result = '';
		for (let i = 0; i < times; i += 1) {
			result += char;
		}
		return result;
	}

	function tableSubmenu() {
		const box = document.createElement('div');
		[[2, 2], [3, 3], [4, 3], [5, 4]].forEach(function (pair) {
			const rows = pair[0];
			const cols = pair[1];
			box.appendChild(subItem(rows + ' 行 × ' + cols + ' 列', function () {
				closeMenu();
				insertTable(rows, cols);
			}));
		});

		const custom = document.createElement('div');
		custom.className = 'aw-sub-custom';
		custom.innerHTML =
			'<label>行 <input class="aw-input aw-rows" type="number" min="1" max="50" value="3" /></label>' +
			'<label>列 <input class="aw-input aw-cols" type="number" min="1" max="12" value="3" /></label>';

		const ok = document.createElement('button');
		ok.type = 'button';
		ok.className = 'aw-sub-item aw-sub-primary';
		ok.textContent = '插入表格';
		ok.addEventListener('click', function (event) {
			event.stopPropagation();
			const rows = clamp(Number(custom.querySelector('.aw-rows').value), 1, 50);
			const cols = clamp(Number(custom.querySelector('.aw-cols').value), 1, 12);
			closeMenu();
			insertTable(rows, cols);
		});
		custom.appendChild(ok);
		box.appendChild(custom);
		return box;
	}

	const CODE_LANGS = [
		['JavaScript', 'js'],
		['TypeScript', 'ts'],
		['Python', 'python'],
		['Go', 'go'],
		['Java', 'java'],
		['SQL', 'sql'],
		['Bash', 'bash'],
		['JSON', 'json'],
		['纯文本', 'text'],
	];

	function codeSubmenu() {
		const box = document.createElement('div');
		CODE_LANGS.forEach(function (pair) {
			const label = pair[0];
			const lang = pair[1];
			box.appendChild(subItem(label, function () {
				closeMenu();
				insertMarkdown('\n\n```' + lang + '\n// 在此输入代码\n```\n\n');
			}));
		});
		return box;
	}

	function repositionMenu() {
		const menu = state.menu;
		const anchor = state.menuAnchor;
		if (!menu || !anchor) {
			return;
		}
		const rect = menu.getBoundingClientRect();
		menu.style.left = Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8)) + 'px';
		menu.style.top = Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8)) + 'px';
	}

	function openMenu(x, y) {
		closeMenu();
		const menu = document.createElement('div');
		menu.className = 'aw-menu';
		menu.setAttribute('role', 'menu');

		menu.appendChild(groupLabel('插入块'));
		menu.appendChild(menuItem('段落', function () {
			insertMarkdown('\n\n在这里输入段落内容\n\n');
		}, null, 'edit'));
		menu.appendChild(menuItem('标题', null, headingSubmenu, 'headings'));
		menu.appendChild(menuItem('引用', function () {
			insertMarkdown('\n\n> 引用内容\n\n');
		}, null, 'quote'));
		menu.appendChild(menuItem('无序列表', function () {
			insertMarkdown('\n\n- 列表项一\n- 列表项二\n\n');
		}, null, 'list'));
		menu.appendChild(menuItem('有序列表', function () {
			insertMarkdown('\n\n1. 列表项一\n2. 列表项二\n\n');
		}, null, 'ordered-list'));
		menu.appendChild(menuItem('任务列表', function () {
			insertMarkdown('\n\n- [ ] 待办事项一\n- [ ] 待办事项二\n\n');
		}, null, 'check'));
		menu.appendChild(menuItem('表格', null, tableSubmenu, 'table'));
		menu.appendChild(menuItem('代码块', null, codeSubmenu, 'code'));
		menu.appendChild(menuItem('分割线', function () {
			insertMarkdown('\n\n---\n\n');
		}, null, 'line'));
		menu.appendChild(menuItem('数学公式', function () {
			insertMarkdown('\n\n$$\nE = mc^2\n$$\n\n');
		}, null, 'Σ'));

		document.body.appendChild(menu);
		state.menu = menu;
		state.menuAnchor = { x: x, y: y };
		repositionMenu();
	}

	/* ------------------------------------------------------------------ */
	/* 插入                                                               */
	/* ------------------------------------------------------------------ */

	function insertMarkdown(markdown) {
		const vditorInstance = state.vditor;
		if (!vditorInstance) {
			return;
		}
		vditorInstance.focus();
		vditorInstance.insertMD(markdown);
		window.clearTimeout(state.timer);
		syncNow();
	}

	function insertTable(rows, cols) {
		const header = [];
		const divider = [];
		const emptyRow = [];
		for (let i = 1; i <= cols; i += 1) {
			header.push('列 ' + i);
			divider.push('---');
			emptyRow.push('   ');
		}
		const lines = ['| ' + header.join(' | ') + ' |', '| ' + divider.join(' | ') + ' |'];
		for (let r = 1; r < rows; r += 1) {
			lines.push('| ' + emptyRow.join(' | ') + ' |');
		}
		insertMarkdown('\n\n' + lines.join('\n') + '\n\n');
	}

	/* 把光标落到右键位置，让插入位置符合直觉 */
	function setCaretFromPoint(x, y) {
		let range = null;
		if (typeof document.caretRangeFromPoint === 'function') {
			range = document.caretRangeFromPoint(x, y);
		}
		if (range) {
			const container = range.startContainer;
			const element = container.nodeType === Node.ELEMENT_NODE
				? container
				: container.parentElement;
			if (element && element.closest(EDITOR_ROOTS)) {
				const selection = window.getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
				return;
			}
		}
		if (state.vditor) {
			state.vditor.focus();
		}
	}

	document.addEventListener('contextmenu', function (event) {
		if (cfg.contextMenu === false) {
			return;
		}
		if (!state.vditor) {
			return;
		}
		const target = event.target;
		if (!(target instanceof Element)) {
			return;
		}
		if (target.closest('.vditor-toolbar, .aw-menu')) {
			return;
		}
		if (!target.closest(EDITOR_ROOTS)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		setCaretFromPoint(event.clientX, event.clientY);
		openMenu(event.clientX, event.clientY);
	}, true);

	document.addEventListener('mousedown', function (event) {
		if (!state.menu) {
			return;
		}
		if (state.menu.contains(event.target)) {
			return;
		}
		closeMenu();
	}, true);

	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape') {
			closeMenu();
		}
	}, true);

	window.addEventListener('resize', closeMenu);
	window.addEventListener('blur', closeMenu);
})();
