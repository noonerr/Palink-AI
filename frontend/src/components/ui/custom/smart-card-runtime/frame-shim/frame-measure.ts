/**
 * Smart Card 帧内运行时 · 图片懒加载队列 + iframe 高度自适应测量段
 *
 * 来源：CharacterCardRenderer.tsx `buildShim()` 原 L4373-4674，逐字节搬运，
 * 仅将原本内联的两个模块级常量插值改为函数入参（值不变）。
 *
 * 该段紧跟 `LEGACY_ST_SIM_SEGMENT` 之后拼接，同处一个 IIFE：
 * 依赖前段定义的符号，并在结尾调用 prepareQueuedImages() 与三次 scheduleMeasure 兜底。
 *
 * @param initialLoadCount 首屏立即加载的图片数量预算（原 SMART_CARD_IFRAME_IMAGE_INITIAL_LOAD_COUNT）
 * @param queueDelayMs     队列中后续图片的放行间隔毫秒（原 SMART_CARD_IFRAME_IMAGE_QUEUE_DELAY_MS）
 */
export function buildFrameMeasureSegment(initialLoadCount: number, queueDelayMs: number): string {
  return `  const imageQueueInitialLoadCount = ${initialLoadCount};
  const imageQueueDelayMs = ${queueDelayMs};
  const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const queuedImages = [];
  const observedImages = new WeakSet();
  // [TRUNCATION-FIX] 与 observedImages 独立的「已挂载 load 重测」标记：
  // observedImages 在懒加载队列里先 add，若复用同一个 Set 去重，restoreQueuedImage
  // 里再 arm 会被跳过（永远不生效）。用独立 WeakSet 保证每张图只挂一次。
  const measuredImageSet = new WeakSet();
  let immediateImageBudget = imageQueueInitialLoadCount;
  let imageQueueTimer = null;
  let measureFrame = 0;
  let lastMeasuredHeight = 0;
  let lastMeasurePostedAt = 0;
  let lastDeepMeasureAt = 0;
  let lastNaturalHeight = 0;
  let forceNextDeepMeasure = true;
  // [STATUSBAR-HEIGHT] 记录「真实内容高度」：body 被 vh/fixed 高度 + overflow 裁切时，
  // naturalHeight 只是 body 框高，真实内容可达更下方。此值在深层扫描时刷新，非深层测量时
  // 仍以其为准，避免展开后又被 body 高拉回（否则会在展开高度与 body 高之间振荡）。
  let lastRealContentHeight = 0;

  const isQueueableImageUrl = (url) => {
    const value = String(url || '').trim();
    return Boolean(value) && !/^(?:data|blob|about|javascript):/i.test(value);
  };
  const armImageLoadMeasure = (img) => {
    // [TRUNCATION-FIX] 图片真正加载完成（获得尺寸、撑开布局）后才重测。
    // 此前懒加载队列恢复 src 时图片尚未加载，测出的高度偏小 → iframe 截断，
    // 要等用户点击触发重排才展开。这里用独立 WeakSet 去重，只挂一次 load 监听。
    if (!img || measuredImageSet.has(img)) return;
    measuredImageSet.add(img);
    img.addEventListener('load', () => {
      try { scheduleMeasure(true); } catch {}
    }, { once: true });
    img.addEventListener('error', () => {
      try { scheduleMeasure(true); } catch {}
    }, { once: true });
  };
  const restoreQueuedImage = (img) => {
    if (!img || !img.isConnected) return;
    const realSrc = img.getAttribute('data-palink-real-src') || '';
    const realSrcset = img.getAttribute('data-palink-real-srcset') || '';
    if (realSrcset) img.setAttribute('srcset', realSrcset);
    if (realSrc) img.setAttribute('src', realSrc);
    img.removeAttribute('data-palink-real-src');
    img.removeAttribute('data-palink-real-srcset');
    img.removeAttribute('data-palink-image-queued');
    armImageLoadMeasure(img);
    try { img.decoding = 'async'; } catch {}
    try { img.loading = 'lazy'; } catch {}
  };
  const pumpQueuedImages = () => {
    if (imageQueueTimer !== null) return;
    imageQueueTimer = setTimeout(() => {
      imageQueueTimer = null;
      const img = queuedImages.shift();
      if (img) {
        restoreQueuedImage(img);
        scheduleMeasure();
      }
      if (queuedImages.length > 0) pumpQueuedImages();
    }, imageQueueDelayMs);
  };
  const prepareImageForQueuedLoad = (img) => {
    if (!img || observedImages.has(img)) return;
    const realSrc = img.getAttribute('src') || '';
    const realSrcset = img.getAttribute('srcset') || '';
    if (!isQueueableImageUrl(realSrc) && !realSrcset) return;
    observedImages.add(img);
    armImageLoadMeasure(img);
    try { img.decoding = 'async'; } catch {}

    if (immediateImageBudget > 0) {
      immediateImageBudget -= 1;
      try { img.loading = 'eager'; } catch {}
      try { img.fetchPriority = 'high'; } catch {}
      return;
    }

    img.setAttribute('data-palink-image-queued', 'true');
    if (realSrc) img.setAttribute('data-palink-real-src', realSrc);
    if (realSrcset) {
      img.setAttribute('data-palink-real-srcset', realSrcset);
      img.removeAttribute('srcset');
    }
    img.setAttribute('src', transparentPixel);
    try { img.loading = 'lazy'; } catch {}
    try { img.fetchPriority = 'low'; } catch {}
    queuedImages.push(img);
    pumpQueuedImages();
  };
  const prepareQueuedImages = (root = document) => {
    const images = root?.querySelectorAll ? root.querySelectorAll('img') : [];
    images.forEach(prepareImageForQueuedLoad);
  };

  const measure = () => {
    measureFrame = 0;
    const body = document.body;
    const root = document.documentElement;
    // [STATUSBAR-HEIGHT] 状态栏等内联面板：以 body 的「文档流内容」高度为准。
    // 关键：不要取 root/documentElement.scrollHeight——它恒 ≥ 视口高度（且被 position:fixed;height:100%
    // 的 lightbox-overlay 全屏遮罩撑到视口），会把面板撑满/卡死（折叠留白、展开截断）。
    // body.scrollHeight/offsetHeight 只反映真正的文档流内容（含 overflow 裁切）：折叠≈header、展开≈完整面板。
    const naturalHeight = Math.max(
      body?.scrollHeight || 0,
      body?.offsetHeight || 0,
      96,
    );
    // [STATUSBAR-HEIGHT] vh 反馈循环判定：body 高度由 vh 驱动（body 撑满 iframe 内部视口，
    // 即 body.scrollHeight ≈ window.innerHeight）时，高度会随 iframe 高度同步增长形成正反馈。
    // 与父组件轮询兜底（L5310-5314）的判定保持一致，防止 measure() 因未定义变量抛
    // ReferenceError 而中断高度上报（导致 iframe 不能完全展开）。
    // [HEIGHT-OSCILLATION-FIX] 单向判定：内容高度达到或接近 iframe 视口即视为 vh 驱动。
    // 原双向判定 Math.abs(naturalHeight - innerH) <= 4 会在「内容略超/略低于视口」的边界翻转：
    // 例：真实内容底部 914（#app），body 被卡片 CSS 固定高 923.56px → naturalHeight=924；
    //   iframe=914 时 |924-914|=10 → 非 vhDriven → 上报 924+2=926 → iframe 被撑到 926；
    //   iframe=926 时 |924-926|=2 → vhDriven → 用 realContent=914 → 上报 914 → iframe 缩回 914。
    //   两个分支互相朝对方推，形成 914↔926 极限环（用户可见的上下乱闪）。
    // 改为 naturalHeight >= innerH - 4：只要内容达到视口就统一走 realContent 分支，
    // 消除「非 vhDriven 用 naturalHeight(+2)」与「vhDriven 用 realContent」两套测量源的拉锯。
    const vhDriven = (() => {
      const innerH = window.innerHeight || 0;
      return innerH > 0 && naturalHeight >= innerH - 4;
    })();
    const now = Date.now();
    const naturalChanged = Math.abs(naturalHeight - lastNaturalHeight) > 24;
    const shouldDeepMeasure = forceNextDeepMeasure
      || !lastMeasuredHeight
      || !naturalHeight
      || naturalChanged
      || now - lastDeepMeasureAt > 1200;
    if (shouldDeepMeasure) {
      forceNextDeepMeasure = false;
      lastDeepMeasureAt = now;
    }
    // 兜底：body 内容几乎为 0（纯 fixed/absolute 布局卡片）时，回退到根/文档高度并扫描可见元素。
    let measured = naturalHeight;
    let visibleCount = 0;
    let realContent = 0;
    // [STATUSBAR-HEIGHT] 真实内容高度扫描：当 body 自身被 vh/fixed 高度 + overflow:hidden 裁切内容时，
    // naturalHeight 只是 body 框高（≈iframe 高度），而上报 height 若仅用 naturalHeight 会被 vhDriven 冻结在
    // 当前微小高度，导致「点击面板后 iframe 不能完全展开」。故：
    //   - vhDriven 或 body 极小（≤96）或深层测量时，扫描可见元素的最大底部作为真实内容高度；
    //   - 若真实内容 > naturalHeight，说明 body 在裁切内容，按真实内容上报（允许展开），并持久化 lastRealContentHeight，
    //     使非深层测量（不扫描）时仍保持展开高度，避免展开后被 body 高拉回、在两者间振荡。
    if (naturalHeight <= 96 || vhDriven || shouldDeepMeasure) {
      // [STATUSBAR-HEIGHT] 反馈循环防护：卡片 body 常写 height:100vh 并铺满全屏 position:fixed 装饰层
      // （.starfield/.falling-stars/.modal-overlay 等），其高度 = iframe 高度，内部绝对定位粒子也散布到
      // body 底部。若不排除，扫描会把它们当成"真实内容"，measured 追着 iframe 高度跑 → 正反馈无限增高。
      // 因此：① vhDriven 时不再以 root.scrollHeight（=iframe 高度伪内容）为兜底基线；② 整棵排除 fixed 子树。
      // [HEIGHT-OSCILLATION-FIX] fallback 基线也不能无条件采用 root.scrollHeight/root.offsetHeight：
      // 卡片 html 常设 height:100%（跟随 iframe 视口），折叠面板（如 lightbox 全屏遮罩展开、内容折叠）时
      // root.scrollHeight = iframe 高度，用它当基线会让 realContent 追着 iframe 高度跑，
      // 上报 高度+2 → iframe 变高 → html 更高 → 再上报……形成无限增高正反馈。
      // 仅当 root 高度明显大于视口（真实内容溢出视口）时才作为兜底基线；root 高度≈视口
      // （html:100% 跟随 iframe）时放弃，改由可见元素扫描提供真实内容底部。
      // [HEIGHT-OSCILLATION-FIX] 判定阈值必须远大于「root 高度 vs iframe 视口」的合理波动范围：
      // 原阈值 +4 在 root 仅比视口高十几像素的卡片（如 body 末尾被空 <p> 的 margin 撑开，
      // root=1697 而真实内容底部=1681）上会随 iframe 高度翻转——iframe=1684 时 1697>1688 成立
      // fallback 取 1697（上报 1699），iframe=1699 时 1697>1703 失败 fallback 取扫描值 1681
      // （上报 1684），两个分支互相推成 1684↔1699 极限环，每圈都触发 ResizeObserver→重测→
      // setHeight，表现为消息区上下抖动 + CPU 飙升。阈值提到 +64：只有 root 真正明显高于
      // 视口（内容溢出数百像素）才启用 root 兜底，微小 margin 撑开的伪高度不再触发。
      let fallback = 0;
      if (!vhDriven) {
        const rootHeight = Math.max(root?.scrollHeight || 0, root?.offsetHeight || 0);
        const innerH = window.innerHeight || 0;
        if (innerH <= 0 || rootHeight > innerH + 64) {
          fallback = rootHeight;
        }
      }
      const candidates = Array.from(body?.querySelectorAll?.('*') || []);
      // 预收集所有 position:fixed 元素及其整个后代子树（装饰层不参与内容高度）。
      // 注意：本段位于 buildShim 的模板字符串内，TS 不会剥离类型标注，故一律使用无泛型
      // 的 JS 写法（new Set()/new Map()/无参类型标注），避免生成非法 JS（Unexpected token）。
      const fixedSubtree = new Set();
      for (const el of candidates) {
        if (fixedSubtree.has(el)) continue;
        if (window.getComputedStyle(el).position === 'fixed') {
          fixedSubtree.add(el);
          el.querySelectorAll('*').forEach((d) => fixedSubtree.add(d));
        }
      }
      // 缓存 overflow 计算，避免大卡片的每个后代都重复读 getComputedStyle。
      const overflowCache = new Map();
      const isClipping = (el) => {
        let v = overflowCache.get(el);
        if (v === undefined) {
          v = window.getComputedStyle(el).overflow;
          overflowCache.set(el, v);
        }
        return v === 'hidden' || v === 'auto' || v === 'scroll' || v === 'clip';
      };
      for (const el of candidates) {
        if (!el || el === root) continue;
        if (fixedSubtree.has(el)) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.02) continue;
        const rect = el.getBoundingClientRect();
        if (!Number.isFinite(rect.bottom) || rect.width < 1 || rect.height < 1) continue;
        if (rect.bottom <= 0 || rect.right <= 0 || rect.left >= window.innerWidth + 4096) continue;
        // 被 overflow 裁切的子树（如 .main-container 内高出的 .main-character）其可见底部受祖先裁切边界
        // 限制；用最近一个 overflow 裁剪祖先的底部作为可见底部，避免把被裁掉的溢出部分当成内容高度。
        // [STATUSBAR-HEIGHT] 区分两类 overflow 裁剪祖先，避免面板被截断：
        // ① 主动滚动/隐藏容器（scrollHeight <= clientHeight，内容未溢出）：内容确实受限，用框底部封顶；
        // ② 被压缩的容器（scrollHeight > clientHeight，自身在裁切内部内容，如 body 高度受 iframe 限制
        //    时被压缩的 .main-container）：其高度并非内容决定，而是被外部高度压小，内部真实内容溢出。
        //    若仍用框底部封顶，面板永远无法展开到完整内容（截断）。此时改用「容器内容底部
        //    （top + scrollHeight）」作为可见底部，让面板能撑开到完整内容。
        let visibleBottom = rect.bottom;
        // [NESTED-FRAME-HEIGHT] 嵌套同源 iframe（如 BubbleDialogue 的 dcRoot 气泡帧）：
        // 其元素框高常被 CSS/默认值限制（如 220px），而内部内容文档高度远大于框高。
        // measure() 扫描 body.querySelectorAll('*') 只能看到 iframe 元素框，看不到 iframe
        // 文档内部内容，导致面板高度卡在 220px 截断。此处直接读取同源 iframe 的内容文档
        // 高度，把可见底部延伸至 rect.top + 内容高。contentDocument 跨源不可读时静默跳过，
        // 不影响既有逻辑（此时退化为只看 iframe 元素框）。
        if (el.tagName && String(el.tagName).toLowerCase() === 'iframe') {
          try {
            const cDoc = el.contentDocument;
            if (cDoc && cDoc.documentElement) {
              const cH = cDoc.documentElement.scrollHeight || 0;
              if (cH > 1) {
                const cb = (rect.top || 0) + cH;
                if (cb > visibleBottom) visibleBottom = cb;
              }
            }
          } catch (_) {}
        }
        let node = el.parentElement;
        while (node && node !== body) {
          if (isClipping(node)) {
            const nb = node.getBoundingClientRect().bottom;
            let contentBottom = nb;
            try {
              const ns = node.scrollHeight || 0;
              const nc = node.clientHeight || 0;
              if (ns > nc + 1) {
                // 容器自身在裁切内容（scrollHeight > clientHeight）。此时要区分两种语义相反的场景：
                // ② 被视口压缩撑开：容器高度 ≈ iframe 视口（如 body 受限时被压满的 .main-container），
                //    内部真实内容溢出需要更多空间，若用框底部封顶面板会被截断 → 用内容底部（top+scrollHeight）；
                // ③ 主动折叠/收起：容器被卡片脚本显式压到远小于视口（如 .collapsible-content 折叠为
                //    height:0/max-height:0），内容只是被视觉隐藏、布局仍占位，若按内容底部计算，
                //    折叠后 iframe 会保持完整内容高度不收缩（残留大段空白）。
                // 区分判据：容器 clientHeight 是否接近视口（≥视口 60% 视为被视口压缩，需要撑开）；
                // 否则视为折叠/受限，用容器当前框底部跟随收缩。
                const innerH = window.innerHeight || 0;
                const compressedByViewport = innerH > 0 && nc >= innerH * 0.6;
                if (innerH <= 0 || compressedByViewport) {
                  contentBottom = node.getBoundingClientRect().top + ns;
                }
              }
            } catch { /* ignore */ }
            // 取所有 overflow 裁剪祖先中的最小可见底部（不 break）：内部滚动容器
            // （如 card-scroll，自身 ns<=nc 不触发撑开）之上可能还有折叠的
            // collapsible-content（height:0）在裁剪内容，只检查最近一层会漏掉折叠边界。
            if (contentBottom < visibleBottom) visibleBottom = contentBottom;
          }
          node = node.parentElement;
        }
        fallback = Math.max(fallback, visibleBottom);
        visibleCount += 1;
      }
      realContent = Math.max(fallback, 96);
      if (vhDriven) {
        // vhDriven 时 naturalHeight = iframe 高度（body:100vh 伪内容），追上会形成无限增高正反馈，
        // 不能作为上报高度；改用排除装饰层、按裁切边界裁剪后的真实内容高度。
        measured = realContent;
        lastRealContentHeight = realContent;
      } else if (realContent > naturalHeight) {
        measured = realContent;
        lastRealContentHeight = realContent;
      } else {
        lastRealContentHeight = 0;
      }
    } else if (lastRealContentHeight > naturalHeight) {
      // 非深层测量：沿用最近一次扫描到的真实内容高度，防止展开后被 body 高拉回。
      measured = lastRealContentHeight;
    }
    lastNaturalHeight = naturalHeight;
    // [STATUSBAR-HEIGHT] vh 反馈循环防护：若卡片 body 高度由 vh 驱动（body 撑满 iframe 内部视口，
    // 即 body.scrollHeight ≈ window.innerHeight），则 body 高度会随 iframe 高度同步增长
    // （iframe 增高 → 100vh 增高 → scrollHeight 增高），与 measure 的上报形成正反馈，导致 iframe 无限增高。
    // 检测到 vh 驱动时，以当前视口高度为稳定基准上报（不再叠加 +2 的递增），切断循环。
    // 普通内容卡片 body 高度 < 视口高度，不受影响，仍按 Math.ceil(measured + 2) 跟随内容。
    // 注意：vhDriven 且真实内容被裁切时，measured 已取真实内容高度（lastRealContentHeight），
    // 因此这里 vhDriven 分支仍能上报真实内容而非被冻结在 body 高。
    const nextHeight = vhDriven ? Math.ceil(measured) : Math.ceil(measured + 2);
    // [STATUSBAR-HEIGHT] 把最新计算高度写回 body 属性，供父页面「轮询兜底」直读，
    // 与 postMessage 主通道上报值完全一致（已含 +2 / vhDriven 处理），避免轮询单独用
    // body.scrollHeight（不含 realContent 覆盖）与主通道用 realContent 打架、高度周期抖动。
    try { document.body?.setAttribute('data-palink-height', String(nextHeight)); } catch {}
    // [HEIGHT-OSCILLATION-FIX] 上报去抖加强：
    // ① <4px 的变化无条件跳过（扫描噪声/亚像素舍入导致的 1~3px 来回，若上报会触发
    //    setHeight → iframe 内 ResizeObserver → 再测量的高频抖动；4px 以上正常内容增减不受影响）；
    // ② 距上次上报 <240ms 且变化 <8px 时也跳过，抑制 vhDriven 边界附近的中等幅度快速抖动。
    if (Math.abs(nextHeight - lastMeasuredHeight) < 4) return;
    if (now - lastMeasurePostedAt < 240 && Math.abs(nextHeight - lastMeasuredHeight) < 8) return;
    lastMeasuredHeight = nextHeight;
    lastMeasurePostedAt = now;
    post({
      type: 'resize',
      height: nextHeight,
      naturalHeight: Math.ceil(naturalHeight),
      // [TRUNCATION-FIX] realContent 上报条件：vhDriven 时也必须上报！
      // 此前要求 realContent 严格 > naturalHeight 才上报，但 vh 卡片（body 固定高，
      // 如 923px）naturalHeight=923、realContent=923，不满足「>」→ 不上报 → 父组件
      // realContentFlag=0 → 用 maxMeasuredHeight（≤680px）封顶 → iframe 高度 < body 高
      // → 内容被裁切 →「点一下才展开」。
      // vhDriven 分支的 measured 已是「排除 fixed 装饰层、按裁切边界裁剪后的真实内容高度」
      // （lastRealContentHeight），带自身防正反馈机制，父组件收到 realContentFlag>0 即解除封顶。
      realContent: (vhDriven || realContent > naturalHeight) ? Math.ceil(realContent) : undefined,
      visibleCount,
    });
  };
  const scheduleMeasure = (forceDeep) => {
    if (forceDeep === true) forceNextDeepMeasure = true;
    if (measureFrame) return;
    measureFrame = requestAnimationFrame(measure);
  };
  window.addEventListener('load', () => scheduleMeasure(true));
  window.addEventListener('resize', () => scheduleMeasure(true));
  // [TRUNCATION-FIX] 字体加载完成（文本重排、行高变化）后重测。此前只靠固定延迟
  // 重测（最长 3.8s），慢字体/晚到字体加载完时测量已错过 → iframe 截断，点一下才展开。
  try {
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
      document.fonts.ready.then(() => scheduleMeasure(true)).catch(() => {});
    }
  } catch {};
  // [STATUSBAR-HEIGHT] 状态栏面板脚本填数据/动画展开后高度会变，多延迟重测确保不截断
  [120, 400, 900, 1600, 2600, 3800].forEach((d) => setTimeout(() => scheduleMeasure(true), d));
  try {
    new ResizeObserver(() => scheduleMeasure(false)).observe(document.documentElement);
    new MutationObserver((mutations) => {
      let shouldMeasure = false;
      let shouldDeepMeasure = false;
      for (const mutation of mutations) {
        mutation.addedNodes?.forEach((node) => {
          if (node?.nodeType !== 1) return;
          if (node.tagName?.toLowerCase?.() === 'img') prepareImageForQueuedLoad(node);
          prepareQueuedImages(node);
          shouldMeasure = true;
          shouldDeepMeasure = true;
        });
        if (mutation.type === 'attributes' && mutation.target?.tagName?.toLowerCase?.() === 'img') {
          prepareImageForQueuedLoad(mutation.target);
          shouldMeasure = true;
          shouldDeepMeasure = true;
        } else if (mutation.type === 'attributes') {
          shouldMeasure = true;
        }
      }
      if (shouldMeasure) scheduleMeasure(shouldDeepMeasure);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style', 'class'] });
  } catch {}
  prepareQueuedImages();
  setTimeout(() => scheduleMeasure(true), 0);
  setTimeout(() => scheduleMeasure(true), 250);
  setTimeout(() => scheduleMeasure(true), 1000);
  // [NESTED-FRAME-HEIGHT] 嵌套同源 iframe 高度同步：除 measure() 扫描时直接纳入内容高外，
  // 这里主动把嵌套 iframe 元素高度设为内容高度，使卡片布局与父页面「轮询兜底」直读到的高度
  // 一致，并在内容变化时重设 + 触发重测。设置高度不改变 iframe 内部内容，故不会造成反馈环；
  // contentH≈frameH 时阈值守卫跳过，避免抖。跨源 iframe 的 contentDocument 不可读 → 静默跳过。
  const syncNestedFrameHeight = (frame) => {
    try {
      const cDoc = frame.contentDocument;
      if (!cDoc || !cDoc.documentElement) return;
      const contentH = cDoc.documentElement.scrollHeight || 0;
      const frameH = frame.clientHeight || frame.offsetHeight || 0;
      if (contentH > 0 && Math.abs(contentH - frameH) > 2) {
        frame.style.height = contentH + 'px';
        scheduleMeasure(true);
      }
    } catch (_) {}
  };
  const armNestedFrame = (frame) => {
    try {
      if (!frame || frame.dataset.palinkNestedWatched) return;
      const cDoc = frame.contentDocument;
      if (!cDoc || !cDoc.documentElement) return;
      frame.dataset.palinkNestedWatched = '1';
      try { frame.addEventListener('load', () => { syncNestedFrameHeight(frame); }); } catch (_) {}
      // 轻量轮询：嵌套帧内容变化（流式文本/样式刷新/重载 srcdoc）时可靠重设高度。
      // 单帧 400ms 轮询开销可忽略；contentH≈frameH 时阈值守卫跳过，无抖。
      try { frame._palinkNestedTimer = setInterval(() => syncNestedFrameHeight(frame), 400); } catch (_) {}
      syncNestedFrameHeight(frame);
    } catch (_) {}
  };
  const scanNestedFrames = () => {
    try {
      const frames = document.querySelectorAll('iframe');
      for (let i = 0; i < frames.length; i++) armNestedFrame(frames[i]);
    } catch (_) {}
  };
  try {
    new MutationObserver((muts) => {
      for (let mi = 0; mi < muts.length; mi++) {
        const added = muts[mi].addedNodes;
        for (let ni = 0; ni < added.length; ni++) {
          const n = added[ni];
          if (n && n.nodeType === 1) {
            if (n.tagName && String(n.tagName).toLowerCase() === 'iframe') armNestedFrame(n);
            try { const fs = n.querySelectorAll('iframe'); for (let i = 0; i < fs.length; i++) armNestedFrame(fs[i]); } catch (_) {}
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
  scanNestedFrames();
`;
}
