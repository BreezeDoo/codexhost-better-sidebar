import { Workbench } from "../shared/workbench.mjs";
import { el, icon } from "../shared/ui.mjs";

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

function clampWidth(value) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Number(value) || 400)));
}

export async function activate(api) {
  if (!document.body) return () => {};
  const mount = api.dom.mount(document.body, "append");
  const container = mount.container;
  container.style.position = "fixed";
  container.style.inset = "0";
  container.style.zIndex = "2147483000";
  container.style.pointerEvents = "none";

  const launcher = el(
    "button",
    {
      class: "bs-web-launcher",
      type: "button",
      title: "打开 Better Sidebar 工作台",
      "aria-label": "打开 Better Sidebar 工作台",
      onclick: () => openDrawer(),
    },
    icon("sidebar", 14),
    el("span", { text: "工作台" }),
  );

  const root = el("div", { class: "bs-workbench" });
  const resizer = el("div", { class: "bs-drawer-resize", title: "拖动调整宽度", "aria-hidden": "true" });
  const host = el("aside", { class: "bs-drawer-host", hidden: true, "aria-label": "Better Sidebar" }, root, resizer);
  container.append(launcher, host);

  let workbench = null;
  let initialized = false;
  let lastThreadId = null;
  let followTimer = 0;
  let widthTimer = 0;
  let sidebarObserver = null;
  let sidebarPoll = 0;

  const stored = await api.storage.get().catch(() => ({}));
  let width = clampWidth(stored?.drawerWidth);
  applyWidth(width);

  function applyWidth(value) {
    width = clampWidth(value);
    host.style.width = `${width}px`;
    host.style.setProperty("--bs-drawer-width", `${width}px`);
  }

  async function ensureWorkbench() {
    if (initialized) return workbench;
    initialized = true;
    workbench = new Workbench(root, api, {
      variant: "drawer",
      onClose: () => closeDrawer(),
      onDrawerWidth: (next) => applyWidth(next),
    });
    await workbench.init();
    workbench.settings.drawerWidth = width;
    return workbench;
  }

  async function openDrawer() {
    launcher.hidden = true;
    host.hidden = false;
    try {
      await ensureWorkbench();
    } catch (error) {
      console.error("[better-sidebar] init", error);
      closeDrawer();
      return;
    }
    if (!workbench.state.rootPath && !workbench.state.dirty && workbench.settings.autoFollow) {
      await workbench.followActiveThread({ silent: true });
    }
    lastThreadId = workbench.findActiveThreadId();
    attachSidebarObserver();
    requestAnimationFrame(() => {
      workbench.els.shell.querySelector("textarea, .bs-list, .bs-main")?.focus?.();
    });
  }

  function closeDrawer() {
    host.hidden = true;
    launcher.hidden = false;
    launcher.focus?.();
    sidebarObserver?.disconnect();
    sidebarObserver = null;
    clearInterval(sidebarPoll);
  }

  function scheduleFollow() {
    clearTimeout(followTimer);
    followTimer = setTimeout(async () => {
      if (host.hidden || !workbench || workbench.state.dirty) return;
      const threadId = workbench.findActiveThreadId();
      if (!threadId || threadId === lastThreadId) return;
      lastThreadId = threadId;
      if (workbench.settings.autoFollow) {
        await workbench.followActiveThread({ silent: true });
      }
    }, 320);
  }

  function attachSidebarObserver() {
    clearInterval(sidebarPoll);
    const sidebar = document.querySelector('[data-cx-region="sidebar"]');
    if (!sidebar) {
      clearInterval(sidebarPoll);
      sidebarPoll = setInterval(() => {
        if (!host.hidden && document.querySelector('[data-cx-region="sidebar"]')) attachSidebarObserver();
      }, 2000);
      return;
    }
    sidebarObserver?.disconnect();
    sidebarObserver = new MutationObserver(() => scheduleFollow());
    sidebarObserver.observe(sidebar, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-selected", "aria-current", "data-row-key"],
    });
    lastThreadId = workbench?.findActiveThreadId() ?? lastThreadId;
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && !host.hidden) {
      event.stopPropagation();
      closeDrawer();
    }
  }

  function startResize(event) {
    if (window.matchMedia("(max-width: 680px)").matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = host.getBoundingClientRect().width;
    host.classList.add("is-resizing");
    resizer.classList.add("is-dragging");
    resizer.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => {
      applyWidth(startWidth + (startX - moveEvent.clientX));
    };
    const up = () => {
      host.classList.remove("is-resizing");
      resizer.classList.remove("is-dragging");
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      resizer.removeEventListener("pointercancel", up);
      clearTimeout(widthTimer);
      widthTimer = setTimeout(() => {
        api.storage.set({ drawerWidth: width }).catch(() => {});
        if (workbench) workbench.settings.drawerWidth = width;
      }, 120);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  }

  resizer.addEventListener("pointerdown", startResize);
  document.addEventListener("keydown", onKeyDown, true);

  const unsubscribeStorage = api.storage.onChange?.((next) => {
    if (next && typeof next.drawerWidth === "number") {
      applyWidth(next.drawerWidth);
      if (workbench) workbench.settings.drawerWidth = width;
    }
  });

  const cleanup = () => {
    document.removeEventListener("keydown", onKeyDown, true);
    unsubscribeStorage?.();
    sidebarObserver?.disconnect();
    clearInterval(sidebarPoll);
    clearTimeout(followTimer);
    clearTimeout(widthTimer);
    workbench?.destroy();
    mount.dispose();
  };
  api.signal?.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}
