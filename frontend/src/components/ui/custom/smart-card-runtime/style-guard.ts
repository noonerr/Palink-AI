/**
 * 卡片样式守护（方案 A · 2026-10-18）
 *
 * 复盘：三轨并一轨后，4MB 插件 bundle 在 iframe 里跑起来后会在第 3~5 秒
 * 重置 document.head / 整页 write，悄无声息地抽走卡片自己的 <style> 与
 * <link rel="stylesheet">，导致 "先正常显示 3 秒左右后变成错误渲染样式"。
 * removeChild / remove / innerHTML 拦截三组实验全部 0 命中（见
 * docs/_active/report/REPORT_ST适配体检_三轨并一轨后渲染回归_2026-10-18.md §2.2），
 * 指向 document.write / head.replaceWith 类操作 —— 拦截不到的。
 *
 * ⚠️ 第一版踩坑（2026-10-18 01:36 真机复测）：把 `frameDoc` 当成固定引用去补节点
 * 是**错的** —— 插件是换 document，旧 doc 的 head 早已 detach，往它身上补等于白补。
 * 所以本版必须**动态解析**当前 document：从 iframe 元素每次重新取 contentDocument，
 * 发现换了就重挂 MutationObserver + 往新 head 里补。
 *
 * 策略：iframe 加载完拍一次 head 里所有 <style> / <link rel="stylesheet">
 * 的 outerHTML 快照；之后挂 MutationObserver 监听 head childList，一旦发现
 * 快照里登记过的节点被移走就克隆一份补回；再加一个 800ms × 40 次的 interval
 * 兜住 document/head 被整体替换、observer 随之失联的极端情况。
 *
 * 取舍：快照法是 "白名单保留" —— 插件想"清理 head"也会被回灌；这是最小
 * 手术的代价。卡片样式是 srcdoc 写死的固定集合，体积与生命期都已知，
 * 反复回灌不会引入内存问题。
 */

export interface CardStyleGuardHandle {
  /** 停掉 MO + 清掉自愈 interval。idempotent。 */
  dispose(): void;
}

interface SnapEntry {
  tag: 'STYLE' | 'LINK';
  outerHTML: string;
}

/** 自愈节奏：800ms 一次、共 40 次（约 32 秒）。密度足够覆盖 3~5 秒的重置窗口，
 *  又不会长期占用 iframe 主线程（每次只做一次 O(n) 的 outerHTML 集合比对，n≈10）。 */
const SELF_HEAL_INTERVAL_MS = 800;
const SELF_HEAL_MAX_TICKS = 40;

export function installCardStyleGuard(frameOrDoc: HTMLIFrameElement | Document): CardStyleGuardHandle | null {
  const frameEl = resolveFrameElement(frameOrDoc);
  const initialDoc = resolveDocument(frameOrDoc, frameEl);
  if (!initialDoc || !initialDoc.head) return null;

  const snapshot: SnapEntry[] = takeSnapshot(initialDoc.head);
  // 快照为空 = 这份文档里没有卡片样式（可能已被插件清空、或是二次 load 打进来的
  // about:blank）。返回 null 让调用方**保留旧守护**（旧守护手里才有正确快照）。
  if (snapshot.length === 0) return null;

  // 观测面（诊断用，与 __palinkFrameErrors / __palinkIframeLru 同口径）：
  //   __palinkStyleGuard = { installed, restored, lastRestoreAt }
  try {
    const host = (frameEl?.ownerDocument?.defaultView || window) as any;
    host.__palinkStyleGuard = host.__palinkStyleGuard || { installed: 0, restored: 0, lastRestoreAt: 0 };
    host.__palinkStyleGuard.installed += 1;
  } catch { /* ignore */ }
  try { frameEl?.setAttribute('data-palink-style-guard', '1'); } catch { /* ignore */ }

  let disposed = false;
  let observer: MutationObserver | null = null;
  let observedHead: Element | null = null;
  let selfHealTimer: ReturnType<typeof setInterval> | null = null;
  let ticks = 0;

  const currentDoc = (): Document | null => resolveDocument(frameOrDoc, frameEl);

  const attachObserver = (head: Element): void => {
    if (observedHead === head) return;
    observer?.disconnect();
    observer = new MutationObserver(() => {
      restoreMissing();
    });
    observer.observe(head, { childList: true });
    observedHead = head;
  };

  const restoreMissing = (): void => {
    if (disposed) return;
    const doc = currentDoc();
    if (!doc || !doc.head) return;
    // document 被换 → 重挂 observer 到新 head
    attachObserver(doc.head);

    const present = new Set<string>();
    doc.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((el) => {
      present.add(el.outerHTML);
    });
    const frag = doc.createDocumentFragment();
    for (const entry of snapshot) {
      if (present.has(entry.outerHTML)) continue;
      const tpl = doc.createElement('template');
      tpl.innerHTML = entry.outerHTML;
      const node = tpl.content.firstElementChild;
      if (node) frag.appendChild(node);
    }
    if (frag.childNodes.length > 0) {
      doc.head.appendChild(frag);
      try {
        const host = (frameEl?.ownerDocument?.defaultView || window) as any;
        if (host.__palinkStyleGuard) {
          host.__palinkStyleGuard.restored += 1;
          host.__palinkStyleGuard.lastRestoreAt = Date.now();
        }
      } catch { /* ignore */ }
    }
  };

  attachObserver(initialDoc.head);

  if (typeof setInterval === 'function') {
    selfHealTimer = setInterval(() => {
      ticks += 1;
      if (ticks > SELF_HEAL_MAX_TICKS) {
        if (selfHealTimer) clearInterval(selfHealTimer);
        selfHealTimer = null;
        return;
      }
      restoreMissing();
    }, SELF_HEAL_INTERVAL_MS);
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      observer = null;
      observedHead = null;
      if (selfHealTimer) clearInterval(selfHealTimer);
      selfHealTimer = null;
    },
  };
}

function resolveFrameElement(frameOrDoc: HTMLIFrameElement | Document): HTMLIFrameElement | null {
  if (isDocument(frameOrDoc)) {
    try {
      const win = frameOrDoc.defaultView;
      const el = win?.frameElement;
      return el && el.tagName === 'IFRAME' ? (el as HTMLIFrameElement) : null;
    } catch {
      return null;
    }
  }
  return frameOrDoc;
}

function resolveDocument(frameOrDoc: HTMLIFrameElement | Document, frameEl: HTMLIFrameElement | null): Document | null {
  if (frameEl) {
    try {
      const doc = frameEl.contentDocument;
      if (doc) return doc;
    } catch {
      /* 跨源时拿不到 */
    }
  }
  return isDocument(frameOrDoc) ? frameOrDoc : null;
}

function isDocument(value: HTMLIFrameElement | Document): value is Document {
  return typeof (value as Document).createElement === 'function';
}

function takeSnapshot(head: Element): SnapEntry[] {
  const out: SnapEntry[] = [];
  head.querySelectorAll('style, link[rel="stylesheet"]').forEach((el) => {
    const tag = el.tagName === 'LINK' ? 'LINK' : 'STYLE';
    out.push({ tag, outerHTML: el.outerHTML });
  });
  return out;
}
