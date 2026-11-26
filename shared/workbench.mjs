import {
  basename,
  debounce,
  dirname,
  el,
  fileKind,
  formatBytes,
  icon,
  joinRel,
  relativeTime,
  toast,
} from "./ui.mjs";
import { renderMarkdown } from "./markdown.mjs";

const DEFAULT_SETTINGS = {
  drawerWidth: 400,
  autoFollow: true,
  showIgnored: false,
  editorFontSize: 12,
};

const TABS = [
  { id: "files", label: "文件", icon: "folder" },
  { id: "changes", label: "变更", icon: "git" },
  { id: "outline", label: "大纲", icon: "outline" },
  { id: "settings", label: "设置", icon: "settings" },
];

function isMarkdown(rel) {
  return /\.(md|markdown|mdx)$/iu.test(rel);
}

function shortText(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function splitLines(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").split("\n");
}

export class Workbench {
  constructor(root, api, options = {}) {
    this.root = root;
    this.api = api;
    this.variant = options.variant === "drawer" ? "drawer" : "page";
    this.onClose = options.onClose;
    this.onDrawerWidth = options.onDrawerWidth;
    this.settings = { ...DEFAULT_SETTINGS };
    this.state = {
      rootPath: "",
      entries: new Map(),
      expanded: new Set(),
      selected: null,
      file: null,
      diff: null,
      dirty: false,
      preview: false,
      tab: "files",
      search: "",
      searching: false,
      searchResults: [],
      searchTruncated: false,
      git: null,
      gitError: null,
      loadingRoot: false,
      rootError: null,
      backendError: null,
      busy: false,
      showingDetail: false,
      outline: [],
    };
    this.disposed = false;
    this.searchTimer = 0;
    this.refreshSearch = debounce(() => this.runSearch(), 220);
    this.gitRequest = null;
    this.gitQueued = false;
    this.rootRequest = 0;
    this.fileRequest = 0;
    this.els = {};
  }

  async init() {
    try {
      const stored = await this.api.storage.get();
      this.settings = { ...DEFAULT_SETTINGS, ...(stored && typeof stored === "object" ? stored : {}) };
    } catch {}
    this.settings.drawerWidth = Math.min(720, Math.max(320, Number(this.settings.drawerWidth) || 400));
    this.settings.editorFontSize = Math.min(18, Math.max(11, Number(this.settings.editorFontSize) || 12));
    this.buildShell();
    this.applySettingsToDom();
    this.api.signal?.addEventListener("abort", () => this.destroy(), { once: true });
    this.unsubscribeStorage = this.api.storage.onChange?.((next) => {
      if (!next || typeof next !== "object") return;
      this.settings = { ...this.settings, ...next };
      this.applySettingsToDom();
      if (this.state.tab === "settings") this.render();
    });
    await this.bootstrapWorkspace();
    this.render();
    return () => this.destroy();
  }

  buildShell() {
    this.root.classList.add("bs-root", `bs-root--${this.variant}`);
    this.root.replaceChildren();
    this.els.workspaceName = el("span", { class: "bs-ws-name", text: "未选择工作区" });
    this.els.workspacePath = el("span", { class: "bs-ws-path", text: "从设置中选择一个目录" });
    this.els.branch = el("span", { class: "bs-pill bs-pill--branch", hidden: true });
    this.els.tabs = el("div", { class: "bs-tabs", role: "tablist" });
    for (const tab of TABS) {
      this.els.tabs.append(
        el(
          "button",
          {
            class: "bs-tab",
            type: "button",
            role: "tab",
            "data-tab": tab.id,
            title: tab.label,
            onclick: () => this.setTab(tab.id),
          },
          icon(tab.icon, 14),
          el("span", { text: tab.label }),
        ),
      );
    }
    this.els.listHead = el("div", { class: "bs-list-head" });
    this.els.listBody = el("div", { class: "bs-list-body" });
    this.els.list = el("aside", { class: "bs-list", "aria-label": "工作台列表" }, this.els.listHead, this.els.listBody);
    this.els.main = el("main", { class: "bs-main" });
    this.els.status = el("div", { class: "bs-status" });
    this.els.shell = el(
      "div",
      { class: "bs-shell" },
      el(
        "header",
        { class: "bs-header" },
        el("div", { class: "bs-brand" }, icon("sidebar", 17), el("span", { text: "工作台" })),
        el(
          "button",
          {
            class: "bs-workspace",
            type: "button",
            title: "切换工作区",
            onclick: () => this.setTab("settings"),
          },
          this.els.workspaceName,
          this.els.workspacePath,
        ),
        el("div", { class: "bs-header-actions" }, this.els.branch, this.refreshButton()),
        this.variant === "drawer"
          ? el(
              "button",
              { class: "bs-iconbtn", type: "button", title: "关闭 (Esc)", "aria-label": "关闭工作台", onclick: () => this.onClose?.() },
              icon("close", 16),
            )
          : null,
      ),
      this.els.tabs,
      el("div", { class: "bs-body" }, this.els.list, this.els.main),
      this.els.status,
    );
    this.root.append(this.els.shell);
    this.els.shell.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (this.state.file && this.state.dirty) {
          event.preventDefault();
          this.saveFile();
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        this.els.searchInput?.focus();
      }
    });
  }

  refreshButton(label = "刷新") {
    return el(
      "button",
      {
        class: "bs-iconbtn",
        type: "button",
        title: label,
        "aria-label": label,
        onclick: () => this.refresh(),
      },
      icon("refresh", 15),
    );
  }

  applySettingsToDom() {
    this.root.style.setProperty("--bs-editor-font-size", `${this.settings.editorFontSize}px`);
    this.root.style.setProperty("--bs-drawer-width", `${this.settings.drawerWidth}px`);
  }

  async bootstrapWorkspace() {
    let recent = [];
    try {
      const state = await this.invoke("workspace.state");
      recent = Array.isArray(state.recentRoots) ? state.recentRoots : [];
    } catch (error) {
      this.state.backendError = error?.message || String(error);
    }
    let root = null;
    if (this.settings.autoFollow) {
      const resolved = await this.followActiveThread({ silent: true });
      root = resolved;
    }
    if (!root) root = recent[0]?.root ?? null;
    if (!root) {
      try {
        const threads = await this.invoke("workspace.recentThreads", { limit: 6 });
        root = threads.threads?.find((thread) => thread.root)?.root ?? null;
      } catch {}
    }
    if (root) await this.setRoot(root, { remember: false, silent: true });
  }

  async invoke(method, params = {}) {
    if (!this.api.backend?.invoke) throw new Error("该插件版本没有启用本地 backend");
    return this.api.backend.invoke(method, params);
  }

  findActiveThreadId() {
    const candidates = [...document.querySelectorAll('[role="treeitem"][aria-selected="true"], [data-thread-id][aria-selected="true"]')];
    for (const node of candidates) {
      const direct = node.getAttribute("data-thread-id");
      if (direct) return direct;
      const rowKey = node.getAttribute("data-row-key") ?? "";
      const match = rowKey.match(/^(?:recent|session|thread):([0-9a-f-]{36})$/iu);
      if (match) return match[1];
      const nested = node.querySelector("[data-thread-id]")?.getAttribute("data-thread-id");
      if (nested) return nested;
    }
    return null;
  }

  async followActiveThread({ silent = false } = {}) {
    const threadId = this.findActiveThreadId();
    if (!threadId) {
      if (!silent) toast("没有找到当前选中的会话", "warn");
      return null;
    }
    try {
      const result = await this.invoke("workspace.resolveThread", { threadId });
      if (!result?.root) {
        if (!silent) toast("这个会话没有可用的工作区路径", "warn");
        return null;
      }
      await this.setRoot(result.root, { remember: true, silent });
      return result.root;
    } catch (error) {
      if (!silent) toast(error.message || "解析会话失败", "error");
      return null;
    }
  }

  async setRoot(root, { remember = true, silent = false } = {}) {
    const value = String(root ?? "").trim();
    if (!value) return;
    if (this.state.dirty && !window.confirm("当前文件还有未保存的修改，切换工作区会丢失。继续？")) return;
    const requestId = ++this.rootRequest;
    this.fileRequest += 1;
    this.state.rootPath = value;
    this.state.entries.clear();
    this.state.expanded.clear();
    this.state.selected = null;
    this.state.file = null;
    this.state.diff = null;
    this.state.dirty = false;
    this.state.git = null;
    this.state.gitError = null;
    this.state.tab = "files";
    this.state.showingDetail = false;
    this.state.rootError = null;
    this.state.loadingRoot = true;
    this.render();
    try {
      await this.loadDirectory("");
      if (requestId !== this.rootRequest) return;
      if (remember) await this.invoke("workspace.remember", { root: value }).catch(() => {});
      this.state.loadingRoot = false;
      this.render();
      this.refreshGit();
    } catch (error) {
      if (requestId !== this.rootRequest) return;
      this.state.loadingRoot = false;
      this.state.rootError = error.message || String(error);
      this.render();
      if (!silent) toast(this.state.rootError, "error");
    }
  }

  async loadDirectory(rel) {
    const key = rel || "";
    const requestedRoot = this.state.rootPath;
    const previous = this.state.entries.get(key) ?? {};
    this.state.entries.set(key, { ...previous, loading: true, error: null });
    if (this.state.tab === "files") this.renderList();
    try {
      const result = await this.invoke("fs.list", {
        root: requestedRoot,
        dir: key,
        showIgnored: Boolean(this.settings.showIgnored),
      });
      if (this.state.rootPath !== requestedRoot) return;
      if (!key && typeof result.root === "string" && result.root) {
        this.state.rootPath = result.root;
      }
      this.state.entries.set(key, {
        entries: result.entries ?? [],
        truncated: Boolean(result.truncated),
        loading: false,
        error: null,
      });
      this.state.expanded.add(key);
      if (this.state.tab === "files") this.renderList();
    } catch (error) {
      if (this.state.rootPath !== requestedRoot) return;
      this.state.entries.set(key, { entries: [], loading: false, error: error.message || String(error) });
      if (this.state.tab === "files") this.renderList();
      throw error;
    }
  }

  async toggleDir(rel) {
    if (this.state.expanded.has(rel)) {
      this.state.expanded.delete(rel);
      this.renderList();
      return;
    }
    this.state.expanded.add(rel);
    if (!this.state.entries.has(rel) || this.state.entries.get(rel)?.error) {
      try {
        await this.loadDirectory(rel);
      } catch {}
    }
    this.renderList();
  }

  async openFile(rel) {
    if (this.state.dirty && !window.confirm(`“${basename(this.state.selected)}”还有未保存的修改，继续打开其他文件？`)) return;
    const requestedRoot = this.state.rootPath;
    const requestId = ++this.fileRequest;
    try {
      const file = await this.invoke("fs.read", { root: requestedRoot, path: rel });
      if (this.fileRequest !== requestId || this.state.rootPath !== requestedRoot) return;
      this.state.file = file;
      this.state.diff = null;
      this.state.selected = rel;
      this.state.dirty = false;
      this.state.preview = file.kind === "text" && isMarkdown(rel);
      if (file.kind === "text" && isMarkdown(rel)) {
        file.headings = renderMarkdown(file.content).headings;
      }
      this.state.showingDetail = true;
      this.state.tab = "files";
      this.render();
      requestAnimationFrame(() => {
        this.els.main.querySelector("textarea")?.focus();
      });
    } catch (error) {
      toast(error.message || "读取文件失败", "error");
    }
  }

  async refreshGit() {
    if (!this.state.rootPath) return;
    if (this.gitRequest) {
      this.gitQueued = true;
      return this.gitRequest;
    }
    const root = this.state.rootPath;
    const showIgnored = Boolean(this.settings.showIgnored);
    const request = (async () => {
      try {
        const git = await this.invoke("git.status", { root, showIgnored });
        if (this.state.rootPath !== root) return;
        this.state.git = git;
        this.state.gitMap = new Map((git.changes ?? []).map((change) => [change.path, change]));
        this.state.gitError = null;
      } catch (error) {
        if (this.state.rootPath !== root) return;
        this.state.git = null;
        this.state.gitError = error.message || String(error);
      }
      this.renderChrome();
      if (this.state.tab === "changes") this.renderList();
      if (this.state.tab === "files") this.renderList();
    })().finally(() => {
      if (this.gitRequest === request) this.gitRequest = null;
      if (this.gitQueued) {
        this.gitQueued = false;
        void this.refreshGit();
      }
    });
    this.gitRequest = request;
    return request;
  }

  async refresh() {
    if (!this.state.rootPath) {
      await this.followActiveThread();
      return;
    }
    this.state.entries.clear();
    this.state.expanded.clear();
    this.state.loadingRoot = true;
    this.render();
    try {
      await this.loadDirectory("");
    } catch {}
    this.state.loadingRoot = false;
    await this.refreshGit();
    this.render();
  }

  setTab(tab) {
    this.state.tab = tab;
    this.els.listBody.scrollTop = 0;
    this.state.showingDetail = tab === "settings" || (tab === "files" && Boolean(this.state.file || this.state.diff));
    if (tab === "changes") this.refreshGit();
    if (tab === "outline") this.collectOutline();
    this.render();
    if (tab === "outline" && this.variant === "drawer" && this.state.outline.length === 0) {
      this.state.outline = this.conversationOutline();
      this.renderList();
    }
  }

  render() {
    this.renderChrome();
    this.renderList();
    this.renderMain();
  }

  renderChrome() {
    const root = this.state.rootPath;
    this.els.workspaceName.textContent = root ? basename(root) : "未选择工作区";
    this.els.workspacePath.textContent = root || "从设置中选择一个目录";
    this.els.workspacePath.title = root;
    const branch = this.state.git?.repo ? this.state.git.branch : null;
    this.els.branch.hidden = !branch;
    if (branch) {
      this.els.branch.replaceChildren(icon("git", 12), document.createTextNode(branch));
      this.els.branch.title = `分支 ${branch}${this.state.git?.head ? ` · ${this.state.git.head}` : ""}`;
    }
    for (const button of this.els.tabs.querySelectorAll("[data-tab]")) {
      const active = button.getAttribute("data-tab") === this.state.tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    }
    this.els.shell.classList.toggle("bs-shell--detail", this.state.showingDetail);
    this.els.shell.classList.toggle("bs-shell--settings", this.state.tab === "settings");
    this.els.status.textContent = this.statusText();
  }

  statusText() {
    if (this.state.gitError) return this.state.gitError;
    if (!this.state.rootPath) return "未选择工作区";
    const git = this.state.git;
    if (git?.repo) {
      const count = git.counts?.total ?? 0;
      return `${git.branch ?? "detached"} · ${count} 个变更${this.settings.showIgnored ? " · 显示构建目录" : ""}`;
    }
    return `${this.state.entries.get("")?.entries?.length ?? 0} 个项目 · 非 Git 仓库`;
  }

  renderList() {
    const tab = this.state.tab;
    this.els.list.hidden = false;
    this.els.listHead.replaceChildren();
    this.els.listBody.replaceChildren();
    if (tab === "files") this.renderFilesList();
    else if (tab === "changes") this.renderChangesList();
    else if (tab === "outline") this.renderOutlineList();
    else if (tab === "settings") {
      this.els.list.hidden = true;
    }
  }

  renderFilesList() {
    const search = el("input", {
      class: "bs-search",
      type: "search",
      placeholder: "搜索文件名 (Ctrl/Cmd+P)",
      value: this.state.search,
      "aria-label": "搜索文件名",
      oninput: (event) => {
        this.state.search = event.target.value;
        clearTimeout(this.searchTimer);
        if (!this.state.search.trim()) {
          this.state.searchResults = [];
          this.state.searching = false;
          this.renderList();
          return;
        }
        this.state.searching = true;
        event.target.setAttribute("aria-busy", "true");
        this.searchTimer = setTimeout(() => this.runSearch(), 220);
      },
    });
    this.els.searchInput = search;
    this.els.listHead.append(
      el("div", { class: "bs-list-title" }, icon("folder", 14), el("span", { text: "文件" })),
      el(
        "div",
        { class: "bs-list-tools" },
        search,
        el(
          "button",
          { class: "bs-iconbtn", type: "button", title: "刷新文件树", onclick: () => this.refresh() },
          icon("refresh", 14),
        ),
      ),
    );
    if (this.state.search.trim()) {
      this.renderSearchResults();
      return;
    }
    if (!this.state.rootPath) {
      this.els.listBody.append(
        el(
          "div",
          { class: "bs-empty bs-empty--small" },
          el("p", { text: "还没有选择工作区。" }),
          el("button", { class: "bs-btn", type: "button", onclick: () => this.setTab("settings") }, "选择目录"),
        ),
      );
      return;
    }
    if (this.state.loadingRoot && !this.state.entries.has("")) {
      this.els.listBody.append(el("div", { class: "bs-loading", text: "正在读取目录…" }));
      return;
    }
    if (this.state.rootError) {
      this.els.listBody.append(
        el(
          "div",
          { class: "bs-empty bs-empty--small" },
          el("p", { class: "bs-error", text: this.state.rootError }),
          el("button", { class: "bs-btn", type: "button", onclick: () => this.refresh() }, "重试"),
        ),
      );
      return;
    }
    const tree = el("div", { class: "bs-tree", role: "tree" });
    this.appendTree(tree, "", 0);
    this.els.listBody.append(tree);
  }

  appendTree(container, rel, depth) {
    const node = this.state.entries.get(rel);
    if (!node) return;
    if (node.loading) {
      container.append(el("div", { class: "bs-tree-note", style: `--depth:${depth}` }, "加载中…"));
      return;
    }
    if (node.error) {
      container.append(
        el(
          "button",
          { class: "bs-tree-note bs-tree-note--error", style: `--depth:${depth}`, onclick: () => this.loadDirectory(rel) },
          `读取失败：${node.error}`,
        ),
      );
      return;
    }
    for (const entry of node.entries) {
      const expanded = this.state.expanded.has(entry.path);
      const selected = this.state.selected === entry.path;
      if (entry.type === "dir") {
        container.append(
          el(
            "button",
            {
              class: `bs-row bs-row--dir${expanded ? " is-open" : ""}`,
              type: "button",
              role: "treeitem",
              "aria-expanded": expanded ? "true" : "false",
              style: `--depth:${depth}`,
              "data-path": entry.path,
              "data-type": "dir",
              onclick: () => this.toggleDir(entry.path),
            },
            icon(expanded ? "chevronDown" : "chevron", 12),
            icon(expanded ? "folderOpen" : "folder", 14),
            el("span", { class: "bs-row-name", text: entry.name }),
            entry.ignored ? el("span", { class: "bs-badge bs-badge--muted", text: "忽略" }) : null,
          ),
        );
        if (expanded) this.appendTree(container, entry.path, depth + 1);
        continue;
      }
      const change = this.gitChangeFor(entry.path);
      const kind = fileKind(entry.name);
      container.append(
        el(
          "button",
          {
            class: `bs-row bs-row--file${selected ? " is-selected" : ""}`,
            type: "button",
            role: "treeitem",
            style: `--depth:${depth}`,
            "data-path": entry.path,
            "data-type": "file",
            title: entry.path,
            onclick: () => this.openFile(entry.path),
          },
          el("span", { class: "bs-row-spacer" }),
          icon(kind === "image" ? "image" : "file", 14),
          el("span", { class: "bs-row-name", text: entry.name }),
          change ? el("span", { class: `bs-badge bs-badge--${change.untracked ? "new" : "mod"}`, text: change.code }) : null,
        ),
      );
    }
    if (node.truncated) container.append(el("div", { class: "bs-tree-note", style: `--depth:${depth}` }, "目录过大，仅显示前 1500 项"));
  }

  gitChangeFor(rel) {
    return this.state.gitMap?.get(rel) ?? null;
  }

  renderSearchResults() {
    if (this.state.searching) {
      this.els.listBody.append(el("div", { class: "bs-loading", text: "搜索中…" }));
      return;
    }
    if (!this.state.searchResults.length) {
      this.els.listBody.append(el("div", { class: "bs-empty bs-empty--small" }, el("p", { text: "没有匹配的文件。" })));
      return;
    }
    const list = el("div", { class: "bs-results" });
    for (const result of this.state.searchResults) {
      list.append(
        el(
          "button",
          { class: "bs-result", type: "button", title: result.path, onclick: () => this.openFile(result.path) },
          icon("file", 14),
          el("span", { class: "bs-result-name", text: basename(result.path) }),
          el("span", { class: "bs-result-dir", text: dirname(result.path) }),
        ),
      );
    }
    this.els.listBody.append(list);
    if (this.state.searchTruncated) {
      this.els.listBody.append(el("div", { class: "bs-tree-note", text: "结果过多，仅显示前 80 个。" }));
    }
  }

  async runSearch() {
    if (!this.state.search.trim() || !this.state.rootPath) return;
    const query = this.state.search;
    const searchInput = this.els.searchInput;
    const wasFocused = searchInput && document.activeElement === searchInput;
    const caret = wasFocused ? searchInput.selectionStart : 0;
    try {
      const result = await this.invoke("fs.search", {
        root: this.state.rootPath,
        query,
        showIgnored: Boolean(this.settings.showIgnored),
      });
      if (query !== this.state.search) return;
      this.state.searchResults = result.results ?? [];
      this.state.searchTruncated = Boolean(result.truncated);
      this.state.searching = false;
      if (this.state.tab === "files") {
        this.renderList();
        if (wasFocused && this.els.searchInput) {
          this.els.searchInput.focus();
          this.els.searchInput.setSelectionRange(caret, caret);
        }
      }
    } catch (error) {
      this.state.searching = false;
      toast(error.message || "搜索失败", "error");
    }
  }

  renderChangesList() {
    this.els.listHead.append(
      el("div", { class: "bs-list-title" }, icon("git", 14), el("span", { text: "变更" })),
      el("div", { class: "bs-list-tools" }, this.refreshButton("刷新变更")),
    );
    const git = this.state.git;
    if (this.state.gitError) {
      this.els.listBody.append(
        el("div", { class: "bs-empty bs-empty--small" }, el("p", { class: "bs-error", text: this.state.gitError })),
      );
      return;
    }
    if (!git) {
      this.els.listBody.append(el("div", { class: "bs-loading", text: "读取 Git 状态…" }));
      return;
    }
    if (!git.repo) {
      this.els.listBody.append(
        el(
          "div",
          { class: "bs-empty bs-empty--small" },
          el("p", { text: "这个工作区不是 Git 仓库。" }),
          el("p", { class: "bs-muted", text: "文件树和编辑仍可正常使用。" }),
        ),
      );
      return;
    }
    if (!git.changes?.length) {
      this.els.listBody.append(
        el("div", { class: "bs-empty bs-empty--small" }, icon("check", 22), el("p", { text: "工作区没有未提交的变更。" })),
      );
      return;
    }
    const groups = [
      { key: "staged", title: "已暂存", filter: (change) => change.staged && !change.untracked },
      { key: "unstaged", title: "未暂存", filter: (change) => change.unstaged && !change.untracked },
      { key: "untracked", title: "未跟踪", filter: (change) => change.untracked },
    ];
    for (const group of groups) {
      const changes = git.changes.filter(group.filter);
      if (!changes.length) continue;
      this.els.listBody.append(el("div", { class: "bs-group-title", text: `${group.title} · ${changes.length}` }));
      const list = el("div", { class: "bs-changes" });
      for (const change of changes) {
        list.append(
          el(
            "button",
            {
              class: "bs-change",
              type: "button",
              title: change.path,
              "data-path": change.path,
              onclick: () => this.openDiff(change),
            },
            el("span", { class: `bs-badge bs-badge--${change.untracked ? "new" : "mod"}`, text: change.code.trim() || change.code }),
            el("span", { class: "bs-change-name", text: basename(change.path) }),
            el("span", { class: "bs-change-dir", text: dirname(change.path) }),
          ),
        );
      }
      this.els.listBody.append(list);
    }
  }

  async openDiff(change) {
    if (this.state.dirty && !window.confirm("当前文件还有未保存的修改，继续查看 diff？")) return;
    this.state.showingDetail = true;
    this.state.diff = { change, loading: true };
    this.state.file = null;
    this.state.selected = change.path;
    this.render();
    try {
      const diff = await this.invoke("git.diff", { root: this.state.rootPath, path: change.path });
      this.state.diff = { change, ...diff, loading: false };
    } catch (error) {
      this.state.diff = { change, loading: false, error: error.message || String(error) };
    }
    this.renderMain();
    this.renderList();
  }

  collectOutline() {
    this.state.outline = this.conversationOutline();
  }

  conversationOutline() {
    const conversation = document.querySelector('[data-cx-region="conversation"]');
    if (!conversation) return [];
    const nodes = [
      ...conversation.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]'),
    ];
    const seen = new Set();
    const output = [];
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      const kind = node.getAttribute("data-chat-flow-kind");
      if (kind === "user") {
        const text = shortText(node.innerText || node.textContent, 110);
        if (text) output.push({ kind: "user", label: text, target: node, level: 0 });
        continue;
      }
      const headings = [...node.querySelectorAll("h1, h2, h3, h4")].filter((heading) => !heading.closest(".bs-root"));
      const fallback = shortText(node.innerText || node.textContent, 110);
      if (!headings.length) {
        if (fallback) output.push({ kind: "assistant", label: fallback, target: node, level: 0 });
        continue;
      }
      for (const heading of headings) {
        output.push({
          kind: "assistant",
          label: shortText(heading.innerText || heading.textContent, 110),
          target: heading,
          level: Number(heading.tagName.slice(1)) - 1,
        });
      }
    }
    return output.slice(0, 200);
  }

  renderOutlineList() {
    this.els.listHead.append(
      el("div", { class: "bs-list-title" }, icon("outline", 14), el("span", { text: "大纲" })),
      el(
        "div",
        { class: "bs-list-tools" },
        el(
          "button",
          { class: "bs-iconbtn", type: "button", title: "重新扫描", onclick: () => this.refreshOutline() },
          icon("refresh", 14),
        ),
      ),
    );
    const conversation = this.state.outline;
    if (conversation.length) {
      this.els.listBody.append(el("div", { class: "bs-group-title", text: `对话 · ${conversation.length}` }));
      const list = el("div", { class: "bs-outline" });
      for (const item of conversation) {
        list.append(
          el(
            "button",
            {
              class: `bs-outline-row bs-outline-row--${item.kind}`,
              type: "button",
              style: `--depth:${Math.min(item.level, 3)}`,
              title: item.label,
              onclick: () => {
                item.target.scrollIntoView({ behavior: "smooth", block: "center" });
                this.onClose?.();
              },
            },
            icon(item.kind === "user" ? "dot" : "outline", 12),
            el("span", { text: item.label }),
          ),
        );
      }
      this.els.listBody.append(list);
    }
    const headings = this.state.file?.headings ?? [];
    if (headings.length) {
      this.els.listBody.append(el("div", { class: "bs-group-title", text: `当前文档 · ${headings.length}` }));
      const list = el("div", { class: "bs-outline" });
      for (const heading of headings) {
        list.append(
          el(
            "button",
            {
              class: "bs-outline-row bs-outline-row--heading",
              type: "button",
              style: `--depth:${Math.min(heading.level - 1, 3)}`,
              title: heading.text,
              onclick: () => this.scrollToHeading(heading.id),
            },
            icon("list", 12),
            el("span", { text: heading.text }),
          ),
        );
      }
      this.els.listBody.append(list);
    }
    if (!conversation.length && !headings.length) {
      this.els.listBody.append(
        el(
          "div",
          { class: "bs-empty bs-empty--small" },
          el("p", { text: "当前页面没有可提取的大纲。" }),
          el("p", { class: "bs-muted", text: "打开 Markdown 文件，或在 Web 会话中使用。" }),
        ),
      );
    }
  }

  async refreshOutline() {
    this.state.outline = this.conversationOutline();
    if (this.state.file && isMarkdown(this.state.file.path)) {
      const source = this.state.file.content ?? "";
      this.state.file.headings = renderMarkdown(source).headings;
    }
    this.renderList();
    if (this.state.tab === "outline") this.renderMain();
  }

  scrollToHeading(id) {
    this.state.preview = true;
    this.state.showingDetail = true;
    this.renderMain();
    requestAnimationFrame(() => {
      this.els.main.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  renderMain() {
    this.els.main.replaceChildren();
    this.els.main.scrollTop = 0;
    if (this.state.tab === "settings") {
      this.renderSettings();
      return;
    }
    if (this.state.diff) {
      this.renderDiff();
      return;
    }
    if (this.state.tab === "changes") {
      this.renderChangesSummary();
      return;
    }
    if (this.state.file) {
      this.renderFile();
      return;
    }
    this.renderWelcome();
  }

  renderChangesSummary() {
    const git = this.state.git;
    const wrap = el("div", { class: "bs-welcome" });
    wrap.append(
      el("div", { class: "bs-welcome-icon" }, icon("git", 28)),
      el("h2", { text: "Git 变更" }),
    );
    if (!this.state.rootPath) {
      wrap.append(el("p", { class: "bs-muted" }, "先选择一个工作区。"));
    } else if (!git) {
      wrap.append(el("p", { class: "bs-muted" }, "正在读取 Git 状态…"));
    } else if (!git.repo) {
      wrap.append(el("p", { class: "bs-muted" }, "这个工作区不是 Git 仓库。"));
    } else {
      wrap.append(
        el("p", { class: "bs-muted" }, `${git.branch ?? "detached"}${git.head ? ` · ${git.head}` : ""}`),
        el(
          "div",
          { class: "bs-features" },
          el("span", {}, `${git.counts?.total ?? 0} 个变更`),
          el("span", {}, `${git.counts?.staged ?? 0} 已暂存`),
          el("span", {}, `${git.counts?.untracked ?? 0} 未跟踪`),
        ),
        el("p", { class: "bs-muted" }, "从左侧选择文件，查看相对 HEAD 的逐行 diff。"),
      );
    }
    this.els.main.append(wrap);
  }

  renderWelcome() {
    const wrap = el("div", { class: "bs-welcome" });
    wrap.append(
      el("div", { class: "bs-welcome-icon" }, icon("sidebar", 30)),
      el("h2", { text: this.state.rootPath ? basename(this.state.rootPath) : "把工作台放进侧栏" }),
      el(
        "p",
        {
          class: "bs-muted",
          text: this.state.rootPath
            ? this.state.rootPath
            : "选择工作区后即可浏览文件、查看 Git 变更和逐行 diff。",
        },
      ),
    );
    if (this.state.backendError) {
      wrap.append(
        el(
          "p",
          { class: "bs-error" },
          "本地 backend 没有启动。请在插件中心关闭「增强侧栏」再重新启用；若仍失败，重新打开 Web 页面。",
        ),
      );
    }
    if (!this.state.rootPath) {
      wrap.append(
        el(
          "div",
          { class: "bs-welcome-actions" },
          el("button", { class: "bs-btn bs-btn--primary", type: "button", onclick: () => this.setTab("settings") }, "选择工作区"),
          this.variant === "drawer"
            ? el("button", { class: "bs-btn", type: "button", onclick: () => this.followActiveThread() }, "跟随当前会话")
            : null,
        ),
      );
    } else {
      wrap.append(
        el(
          "div",
          { class: "bs-welcome-actions" },
          el("button", { class: "bs-btn", type: "button", onclick: () => this.setTab("files") }, "浏览文件"),
          el("button", { class: "bs-btn", type: "button", onclick: () => this.setTab("changes") }, "查看变更"),
        ),
      );
      const recent = this.state.entries.get("")?.entries?.slice(0, 8) ?? [];
      if (recent.length) {
        const list = el("div", { class: "bs-welcome-recent" });
        for (const entry of recent) {
          list.append(
            el(
              "button",
              {
                class: "bs-result",
                type: "button",
                onclick: () => (entry.type === "dir" ? this.toggleDir(entry.path) : this.openFile(entry.path)),
              },
              icon(entry.type === "dir" ? "folder" : "file", 14),
              el("span", { class: "bs-result-name", text: entry.name }),
            ),
          );
        }
        wrap.append(el("div", { class: "bs-group-title", text: "工作区内容" }), list);
      }
    }
    wrap.append(
      el(
        "div",
        { class: "bs-features" },
        el("span", {}, icon("folder", 12), " 文件树与搜索"),
        el("span", {}, icon("edit", 12), " 编辑与 Markdown 预览"),
        el("span", {}, icon("git", 12), " Git 变更与 diff"),
        el("span", {}, icon("outline", 12), " 对话大纲"),
      ),
    );
    this.els.main.append(wrap);
  }

  renderFile() {
    const file = this.state.file;
    const toolbar = el("div", { class: "bs-filebar" });
    toolbar.append(
      el(
        "button",
        { class: "bs-iconbtn bs-backbtn", type: "button", title: "返回列表", onclick: () => this.backToList() },
        icon("back", 16),
      ),
    );
    toolbar.append(
      el("div", { class: "bs-filetitle", title: file.path }, icon(fileKind(file.path) === "image" ? "image" : "file", 14), el("span", { text: basename(file.path) })),
      el("span", { class: "bs-filedir", text: dirname(file.path) || "." }),
    );
    const actions = el("div", { class: "bs-file-actions" });
    if (file.kind === "text" && isMarkdown(file.path)) {
      actions.append(
        el(
          "button",
          {
            class: `bs-iconbtn${this.state.preview ? " is-active" : ""}`,
            type: "button",
            title: this.state.preview ? "编辑" : "预览",
            onclick: () => this.togglePreview(),
          },
          icon(this.state.preview ? "edit" : "eye", 15),
        ),
      );
    }
    if (file.kind === "text") {
      actions.append(
        el(
          "button",
          {
            class: "bs-iconbtn",
            type: "button",
            title: "保存 (Ctrl/Cmd+S)",
            disabled: !this.state.dirty,
            onclick: () => this.saveFile(),
          },
          icon("save", 15),
        ),
      );
    }
    actions.append(
      el(
        "button",
        { class: "bs-iconbtn", type: "button", title: "重新读取", onclick: () => this.reloadFile() },
        icon("refresh", 15),
      ),
    );
    toolbar.append(actions);
    this.els.main.append(toolbar);

    if (file.kind === "image") {
      this.els.main.append(
        el(
          "div",
          { class: "bs-image-wrap" },
          el("img", { class: "bs-image", src: file.dataUrl, alt: basename(file.path) }),
          el("div", { class: "bs-muted", text: `${formatBytes(file.size)} · ${file.mime}` }),
        ),
      );
    } else if (file.kind === "binary") {
      this.els.main.append(
        el("div", { class: "bs-empty" }, icon("alert", 24), el("p", { text: "这是二进制文件，无法在这里预览。" }), el("p", { class: "bs-muted", text: formatBytes(file.size) })),
      );
    } else if (file.kind === "tooLarge") {
      this.els.main.append(
        el("div", { class: "bs-empty" }, icon("alert", 24), el("p", { text: "文件超过 8 MiB，已停止读取。" }), el("p", { class: "bs-muted", text: formatBytes(file.size) })),
      );
    } else if (file.kind === "text") {
      if (this.state.preview) {
        this.renderPreview(file);
      } else {
        this.renderEditor(file);
      }
    } else {
      this.els.main.append(el("div", { class: "bs-empty" }, el("p", { text: "无法识别这个文件。" })));
    }
  }

  renderEditor(file) {
    const textarea = el("textarea", {
      class: "bs-editor",
      spellcheck: "false",
      wrap: "off",
      "aria-label": `编辑 ${file.path}`,
    });
    textarea.value = file.content ?? "";
    const position = el("span", { class: "bs-cursor", text: "Ln 1, Col 1" });
    const state = el("span", { class: "bs-file-state", text: this.state.dirty ? "未保存" : "已读取" });
    textarea.addEventListener("input", () => {
      file.content = textarea.value;
      this.state.dirty = true;
      state.textContent = "未保存";
      state.classList.add("is-dirty");
      this.els.main.querySelector('[title="保存 (Ctrl/Cmd+S)"]')?.removeAttribute("disabled");
      this.updateCursor(textarea, position);
    });
    textarea.addEventListener("click", () => this.updateCursor(textarea, position));
    textarea.addEventListener("keyup", () => this.updateCursor(textarea, position));
    textarea.value = file.content ?? "";
    this.els.main.append(el("div", { class: "bs-editor-wrap" }, textarea));
    this.els.main.append(
      el("div", { class: "bs-filefoot" }, position, el("span", { text: file.eol === "\r\n" ? "CRLF" : "LF" }), el("span", { text: formatBytes(file.size) }), state),
    );
    if (file.truncated) {
      this.els.main.append(el("div", { class: "bs-warn", text: "文件超过 1.5 MiB，仅加载了前 1.5 MiB，保存会截断文件。" }));
    }
  }

  updateCursor(textarea, output) {
    const upto = textarea.value.slice(0, textarea.selectionStart);
    const lines = upto.split("\n");
    output.textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
  }

  renderPreview(file) {
    const rendered = renderMarkdown(file.content ?? "");
    file.headings = rendered.headings;
    const preview = el("div", { class: "bs-preview" });
    preview.innerHTML = rendered.html;
    preview.addEventListener("click", (event) => {
      const link = event.target.closest("a[data-bs-rel-link]");
      if (!link) return;
      event.preventDefault();
      const raw = link.getAttribute("data-bs-rel-link");
      const target = joinRel(dirname(file.path), raw.split("#")[0].split("?")[0]);
      if (target !== null) this.openFile(target);
    });
    this.els.main.append(preview);
    this.els.main.append(
      el(
        "div",
        { class: "bs-filefoot" },
        el("span", { text: `${rendered.headings.length} 个标题` }),
        el("span", { text: formatBytes(file.size) }),
        el("span", { text: this.state.dirty ? "未保存" : "Markdown 预览" }),
      ),
    );
  }

  togglePreview() {
    this.state.preview = !this.state.preview;
    if (this.state.preview) {
      const textarea = this.els.main.querySelector("textarea");
      if (textarea) this.state.file.content = textarea.value;
    }
    this.renderMain();
  }

  async saveFile() {
    if (!this.state.file || this.state.file.kind !== "text" || !this.state.dirty) return;
    if (this.state.file.truncated) {
      toast("文件过大，只加载了前 1.5 MiB，已禁止保存以免截断原文件", "error");
      return;
    }
    const textarea = this.els.main.querySelector("textarea");
    if (textarea) this.state.file.content = textarea.value;
    this.state.busy = true;
    try {
      let result = await this.invoke("fs.write", {
        root: this.state.rootPath,
        path: this.state.file.path,
        content: this.state.file.content,
        baseMtime: this.state.file.mtimeMs,
        eol: this.state.file.eol,
      });
      if (result.conflict) {
        const overwrite = window.confirm("文件在读取后被其他程序修改。要用当前内容覆盖吗？");
        if (!overwrite) return;
        result = await this.invoke("fs.write", {
          root: this.state.rootPath,
          path: this.state.file.path,
          content: this.state.file.content,
          force: true,
          eol: this.state.file.eol,
        });
      }
      this.state.file.mtimeMs = result.mtimeMs;
      this.state.file.size = result.size;
      this.state.dirty = false;
      toast("已保存", "ok");
      this.renderChrome();
      this.renderMain();
      this.refreshGit();
    } catch (error) {
      toast(error.message || "保存失败", "error");
    } finally {
      this.state.busy = false;
    }
  }

  async reloadFile() {
    if (!this.state.file) return;
    if (this.state.dirty && !window.confirm("放弃未保存的修改并重新读取？")) return;
    const path = this.state.file.path;
    await this.openFile(path);
  }

  backToList() {
    this.state.showingDetail = false;
    this.state.tab = "files";
    this.render();
  }

  renderDiff() {
    const diff = this.state.diff;
    const change = diff.change;
    const toolbar = el("div", { class: "bs-filebar" });
    toolbar.append(
      el("button", { class: "bs-iconbtn bs-backbtn", type: "button", title: "返回列表", onclick: () => this.backToList() }, icon("back", 16)),
    );
    toolbar.append(
      el("div", { class: "bs-filetitle", title: change.path }, icon("git", 14), el("span", { text: basename(change.path) })),
      el("span", { class: "bs-filedir", text: dirname(change.path) || "." }),
      el("span", { class: `bs-badge bs-badge--${change.untracked ? "new" : "mod"}`, text: change.code }),
    );
    const actions = el("div", { class: "bs-file-actions" });
    if (!diff.loading) {
      if (typeof diff.additions === "number") {
        actions.append(el("span", { class: "bs-stat bs-stat--add", text: `+${diff.additions}` }));
        actions.append(el("span", { class: "bs-stat bs-stat--del", text: `−${diff.deletions}` }));
      }
      actions.append(
        el(
          "button",
          { class: "bs-iconbtn", type: "button", title: "打开文件", onclick: () => this.openFile(change.path) },
          icon("file", 15),
        ),
        el(
          "button",
          { class: "bs-iconbtn", type: "button", title: "复制路径", onclick: () => this.copyPath(change.path) },
          icon("copy", 15),
        ),
      );
    }
    toolbar.append(actions);
    this.els.main.append(toolbar);
    if (diff.loading) {
      this.els.main.append(el("div", { class: "bs-loading", text: "正在生成 diff…" }));
      return;
    }
    if (diff.error) {
      this.els.main.append(el("div", { class: "bs-empty" }, icon("alert", 24), el("p", { class: "bs-error", text: diff.error })));
      return;
    }
    if (diff.tooLarge) {
      this.els.main.append(
        el(
          "div",
          { class: "bs-empty" },
          icon("alert", 24),
          el("p", { text: "文件太大，超过 512 KiB，无法在这里生成 diff。" }),
          el("button", { class: "bs-btn", type: "button", onclick: () => this.openFile(change.path) }, "打开文件"),
        ),
      );
      return;
    }
    if (diff.binary) {
      this.els.main.append(el("div", { class: "bs-empty" }, icon("alert", 24), el("p", { text: "二进制文件，没有文本 diff。" })));
      return;
    }
    if (!diff.patch) {
      this.els.main.append(
        el("div", { class: "bs-empty" }, icon("check", 24), el("p", { text: "没有文本差异。" }), el("p", { class: "bs-muted", text: "可能只是权限或文件模式变化。" })),
      );
      return;
    }
    const lines = splitLines(diff.patch);
    const limit = 6000;
    const view = el("div", { class: "bs-diff", role: "region", "aria-label": "Diff" });
    for (const line of lines.slice(0, limit)) {
      let kind = "context";
      if (line.startsWith("@@")) kind = "hunk";
      else if (line.startsWith("+++") || line.startsWith("---")) kind = "file";
      else if (line.startsWith("+")) kind = "add";
      else if (line.startsWith("-")) kind = "del";
      view.append(el("div", { class: `bs-dl bs-dl--${kind}`, text: line || " " }));
    }
    this.els.main.append(view);
    if (lines.length > limit) {
      this.els.main.append(el("div", { class: "bs-warn", text: `diff 过大，仅显示前 ${limit} 行（共 ${lines.length} 行）。` }));
    }
  }

  async copyPath(path) {
    try {
      await navigator.clipboard.writeText(path);
      toast("已复制路径", "ok");
    } catch {
      toast("复制失败", "error");
    }
  }

  renderSettings() {
    const wrap = el("div", { class: "bs-settings" });
    wrap.append(el("h2", { text: "工作区设置" }));
    const rootInput = el("input", { class: "bs-input bs-input--path", type: "text", value: this.state.rootPath, placeholder: "C:\\Projects\\my-project", spellcheck: "false" });
    const rootForm = el(
      "form",
      {
        class: "bs-field",
        onsubmit: (event) => {
          event.preventDefault();
          this.setRoot(rootInput.value);
        },
      },
      el("label", { text: "工作区根目录" }),
      el("div", { class: "bs-inline" }, rootInput, el("button", { class: "bs-btn bs-btn--primary", type: "submit" }, "应用")),
      el("p", { class: "bs-muted", text: "只在这个目录内读写。可输入绝对路径，或从下面的最近工作区选择。" }),
    );
    wrap.append(rootForm);

    const follow = el("input", {
      type: "checkbox",
      checked: Boolean(this.settings.autoFollow),
      onchange: async (event) => {
        await this.saveSettings({ autoFollow: event.target.checked });
        if (event.target.checked) await this.followActiveThread({ silent: true });
      },
    });
    const showIgnored = el("input", {
      type: "checkbox",
      checked: Boolean(this.settings.showIgnored),
      onchange: async (event) => {
        await this.saveSettings({ showIgnored: event.target.checked });
        this.state.entries.clear();
        this.state.expanded.clear();
        await this.loadDirectory("").catch(() => {});
        this.refreshGit();
      },
    });
    wrap.append(
      el("div", { class: "bs-settings-grid" },
        el("label", { class: "bs-check" }, follow, el("span", {}, el("strong", { text: "跟随当前会话" }), el("small", { text: "从选中会话的 Codex session 解析工作区路径。" }))),
        el("label", { class: "bs-check" }, showIgnored, el("span", {}, el("strong", { text: "显示构建目录" }), el("small", { text: "列出 target、dist 等构建目录；node_modules 与 .git 始终隐藏。" }))),
      ),
    );

    const widthLabel = el("span", { text: `抽屉宽度 · ${this.settings.drawerWidth}px` });
    const fontLabel = el("span", { text: `编辑器字号 · ${this.settings.editorFontSize}px` });
    const width = el("input", {
      type: "range",
      min: "320",
      max: "720",
      step: "10",
      value: String(this.settings.drawerWidth),
      oninput: (event) => {
        this.settings.drawerWidth = Number(event.target.value);
        widthLabel.textContent = `抽屉宽度 · ${this.settings.drawerWidth}px`;
        this.applySettingsToDom();
        this.onDrawerWidth?.(this.settings.drawerWidth);
      },
      onchange: (event) => this.saveSettings({ drawerWidth: Number(event.target.value) }),
    });
    const font = el("input", {
      type: "range",
      min: "11",
      max: "18",
      step: "1",
      value: String(this.settings.editorFontSize),
      oninput: (event) => {
        this.settings.editorFontSize = Number(event.target.value);
        fontLabel.textContent = `编辑器字号 · ${this.settings.editorFontSize}px`;
        this.applySettingsToDom();
      },
      onchange: (event) => this.saveSettings({ editorFontSize: Number(event.target.value) }),
    });
    wrap.append(
      el("div", { class: "bs-settings-grid" },
        el("label", { class: "bs-field" }, widthLabel, width),
        el("label", { class: "bs-field" }, fontLabel, font),
      ),
    );

    wrap.append(
      el(
        "div",
        { class: "bs-inline bs-inline--actions" },
        el("button", { class: "bs-btn", type: "button", onclick: () => this.followActiveThread() }, "跟随当前会话"),
        el("button", { class: "bs-btn", type: "button", onclick: () => this.refresh() }, "刷新工作区"),
      ),
    );

    const recentWrap = el("div", { class: "bs-settings-list" });
    recentWrap.append(el("div", { class: "bs-group-title", text: "最近工作区" }));
    this.loadRecentWorkspaces(recentWrap);
    wrap.append(recentWrap);

    wrap.append(
      el(
        "div",
        { class: "bs-about" },
        el("div", { class: "bs-group-title", text: "关于" }),
        el("p", { text: "Better Sidebar 1.0.0" }),
        el("p", { class: "bs-muted", text: "文件与 Git 读取全部在本地完成。Git 历史由 isomorphic-git（MIT）在插件内读取，不调用 git 命令。" }),
        el("p", { class: "bs-muted", text: "快捷键：Ctrl/Cmd+S 保存，Ctrl/Cmd+P 搜索文件名，Esc 关闭抽屉。" }),
      ),
    );
    this.els.main.append(wrap);
  }

  async loadRecentWorkspaces(container) {
    let recent = [];
    try {
      const state = await this.invoke("workspace.state");
      recent = state.recentRoots ?? [];
    } catch {}
    if (!recent.length) {
      container.append(el("p", { class: "bs-muted", text: "还没有最近工作区。" }));
      return;
    }
    for (const item of recent) {
      container.append(
        el(
          "div",
          { class: "bs-recent" },
          el(
            "button",
            { class: "bs-recent-main", type: "button", title: item.root, onclick: () => this.setRoot(item.root) },
            icon("folder", 14),
            el("span", { class: "bs-recent-name", text: basename(item.root) }),
            el("span", { class: "bs-recent-path", text: dirname(item.root) }),
          ),
          el(
            "button",
            {
              class: "bs-iconbtn",
              type: "button",
              title: "从列表移除",
              onclick: async () => {
                await this.invoke("workspace.forget", { root: item.root }).catch(() => {});
                container.querySelector(".bs-group-title")?.scrollIntoView();
                this.renderMain();
              },
            },
            icon("trash", 14),
          ),
        ),
      );
    }
  }

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.applySettingsToDom();
    try {
      await this.api.storage.set(patch);
    } catch (error) {
      console.error("[better-sidebar] save settings", error);
    }
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.searchTimer);
    this.refreshSearch.cancel?.();
    this.unsubscribeStorage?.();
    this.root.classList.remove("bs-root", "bs-root--page", "bs-root--drawer");
    this.root.replaceChildren();
  }
}
