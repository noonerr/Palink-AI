// 【K18 临时诊断 · 2026-09-03 · 视口问题闭环后整体删除本文件与 main.tsx 的调用】
// 背景：iOS 27.0 PWA 顶部系统栏灰底 + 底部 dock 下方大空白，源码内所有修复
// （black-translucent / viewport-fit=cover / shell=100svh+env / spacer）真机实测
// 均未按预期生效。与其继续按假设改公式，不如按项目铁律「让用户报读数，用数据定位」。
// 用法：PWA/Safari 地址栏打开  https://<host>:3000/?vpdebug=1
//      → 左上角浮层常驻（sessionStorage 记住，站内跳转不丢），截图回传即可。
// 读数含义见每行 label；bottomDock/shellRect 用于核对 dock 锚点与 shell 实际底边。

type Probe = { el: HTMLDivElement; read: () => string };

const units = (px: number) => `${Math.round(px * 100) / 100}px`;

function makeProbes(): Probe[] {
  const cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;';

  const svh = document.createElement('div');
  svh.style.cssText = cssText + 'height:100svh;';
  const lvh = document.createElement('div');
  lvh.style.cssText = cssText + 'height:100lvh;';
  const dvh = document.createElement('div');
  dvh.style.cssText = cssText + 'height:100dvh;';
  const inset = document.createElement('div');
  inset.style.cssText =
    cssText + 'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);';

  document.body.append(svh, lvh, dvh, inset);

  return [
    { el: svh, read: () => `100svh=${units(svh.offsetHeight)}` },
    { el: lvh, read: () => `100lvh=${units(lvh.offsetHeight)}` },
    { el: dvh, read: () => `100dvh=${units(dvh.offsetHeight)}` },
    {
      el: inset,
      read: () => {
        const cs = getComputedStyle(inset);
        return `envTop=${cs.paddingTop} envBottom=${cs.paddingBottom}`;
      },
    },
  ];
}

export function mountViewportDebug(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('vpdebug')) {
      sessionStorage.setItem('palink-vpdebug', '1');
    }
    if (sessionStorage.getItem('palink-vpdebug') !== '1') return;

    const box = document.createElement('div');
    box.id = 'palink-vpdebug';
    box.style.cssText = [
      'position:fixed', 'left:8px', 'z-index:2147483647',
      'top:max(8px, env(safe-area-inset-top, 0px))',
      'max-width:92vw', 'padding:8px 10px', 'border-radius:10px',
      'background:rgba(2,6,23,0.88)', 'color:#4ade80',
      'font:600 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace',
      'white-space:pre', 'pointer-events:none', 'text-shadow:0 1px 2px rgba(0,0,0,.6)',
    ].join(';');
    document.body.appendChild(box);

    const probes = makeProbes();

    const render = () => {
      const vv = window.visualViewport;
      const dock = document.querySelector('nav[data-dock="true"]') as HTMLElement | null;
      const shell = document.querySelector('.palink-app-shell') as HTMLElement | null;
      const dockRect = dock?.getBoundingClientRect();
      const shellRect = shell?.getBoundingClientRect();
      const standalone =
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;

      const lines = [
        '⌶K18 视口读数（截图回传）',
        `mode=${standalone ? 'PWA(standalone)' : 'browser'}`,
        `screen=${window.screen.width}x${window.screen.height} dpr=${window.devicePixelRatio}`,
        `innerHeight=${units(window.innerHeight)}`,
        `clientHeight=${units(document.documentElement.clientHeight)}`,
        `vv.height=${vv ? units(vv.height) : 'n/a'} vv.offsetTop=${vv ? units(vv.offsetTop) : 'n/a'}`,
        ...probes.map((p) => p.read()),
        shellRect
          ? `shellRect top=${units(shellRect.top)} bottom=${units(shellRect.bottom)} h=${units(shellRect.height)}`
          : 'shellRect=n/a',
        dockRect
          ? `dockRect top=${units(dockRect.top)} bottom=${units(dockRect.bottom)}`
          : 'dockRect=n/a',
        `docHeight=${units(document.documentElement.scrollHeight)}`,
      ];
      box.textContent = lines.join('\n');
    };

    render();
    window.addEventListener('resize', render, { passive: true });
    window.addEventListener('orientationchange', render, { passive: true });
    window.visualViewport?.addEventListener('resize', render);
    // 键盘/布局迟报告兜底：定时轻刷（诊断期临时，删除时一并移除）
    window.setInterval(render, 1500);
  } catch {
    // 诊断浮层绝不影响主功能
  }
}
