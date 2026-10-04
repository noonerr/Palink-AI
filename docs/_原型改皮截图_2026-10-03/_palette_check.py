# -*- coding: utf-8 -*-
"""报错提示原型改皮：配色色相 / 对比度实测器。
输出 变量级 diff 表所需的全部数字。
"""


def srgb_to_lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(hexstr):
    h = hexstr.lstrip('#')
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return 0.2126 * srgb_to_lin(r) + 0.7152 * srgb_to_lin(g) + 0.0722 * srgb_to_lin(b)


def contrast(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def hue(hexstr):
    """返回色相角(度)；饱和度低于 2% 视作无彩色 -> None"""
    h = hexstr.lstrip('#')
    r, g, b = int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    if d == 0:
        return None, 0.0
    if mx == r:
        hh = 60 * (((g - b) / d) % 6)
    elif mx == g:
        hh = 60 * ((b - r) / d + 2)
    else:
        hh = 60 * ((r - g) / d + 4)
    l = (mx + mn) / 2
    s = 0 if d == 0 else d / (1 - abs(2 * l - 1))
    return round(hh, 1), round(s, 3)


PALETTE = {
    'light': {
        'bg': '#F1F5F9', 'chat': '#F8FAFC', 'card': '#FFFFFF',
        'text': '#09090B', 'muted': '#71717A', 'line': '#E4E4E7',
        'blue': '#3C83F6', 'blue_text': '#2563EB', 'blue_soft': '#EFF6FF',
        'danger': '#DC2626', 'warn': '#D97706', 'ok': '#16A34A',
        'shadow': None,
    },
    'dark': {
        'bg': '#0B1120', 'chat': '#020617', 'card': '#0F172A',
        'text': '#FAFAFA', 'muted': '#A1A1AA', 'line': '#27272A',
        'blue': '#3C83F6', 'blue_text': '#9AB5FF', 'blue_soft': '#16233D',
        'danger': '#ED9188', 'warn': '#DDBB97', 'ok': '#9DCCB0',
        'shadow': None,
    },
}

print('=' * 78)
print('一、中性色色相（规则：200°–250° 或完全无饱和）')
print('=' * 78)
for theme in ('light', 'dark'):
    print(f'\n[{theme}]')
    for k in ('bg', 'chat', 'card', 'text', 'muted', 'line'):
        v = PALETTE[theme][k]
        hh, ss = hue(v)
        hs = f'{hh}°' if hh is not None else '无彩色'
        ok = 'OK' if (hh is None or 200 <= hh <= 250) else 'FAIL'
        print(f'  {k:<6} {v}  hue={hs:<8} sat={ss:<6} {ok}')

print()
print('=' * 78)
print('二、对比度（AA 正文 ≥4.5；大文本/图标 ≥3.0）')
print('=' * 78)
for theme in ('light', 'dark'):
    p = PALETTE[theme]
    print(f'\n[{theme}] 基准底色 card = {p["card"]}')
    rows = [
        ('text 正文', p['text'], 4.5),
        ('muted 辅助', p['muted'], 4.5),
        ('blue_text 动作文字', p['blue_text'], 4.5),
        ('danger 语义(图标/描边)', p['danger'], 3.0),
        ('warn  语义(图标/描边)', p['warn'], 3.0),
        ('ok    语义(图标/描边)', p['ok'], 3.0),
    ]
    for label, col, thr in rows:
        c = contrast(col, p['card'])
        print(f'  {label:<24} {col}  {c:6.2f}:1  (阈值 {thr})  {"OK" if c >= thr else "FAIL"}')
    # 语义色若当文字用（仅报告，规则禁止）
    print('  --- 语义色若当正文用（规则禁止，仅留档）---')
    for k in ('danger', 'warn', 'ok'):
        c = contrast(p[k], p['card'])
        print(f'  {k:<24} {p[k]}  {c:6.2f}:1  (正文阈值 4.5)  {"OK" if c >= 4.5 else "FAIL"}')
    # 文字压在 chat 底（助手气泡 / 页面正文）
    print(f'  --- 文字压在 chat 底 {p["chat"]} ---')
    for k in ('text', 'muted'):
        c = contrast(p[k], p['chat'])
        print(f'  {k:<24} {p[k]}  {c:6.2f}:1  {"OK" if c >= 4.5 else "FAIL"}')

print()
print('=' * 78)
print('三、旧值 vs 新值（同一用途）')
print('=' * 78)
OLD = {
    'light': {'bg': '#f6f4f1', 'chat': '#fffafa', 'text': '#252936', 'muted': '#85858b',
              'line': '#ddd4c5', 'blue': '#557bd7', 'blue_soft': '#eff6ff',
              'danger': '#bd6a64', 'warn': '#a48163', 'ok': '#6b927d'},
    'dark': {'bg': '#171a2b', 'chat': '#1b2032', 'text': '#f5f7ff', 'muted': '#b5bdd0',
             'blue': '#9ab5ff', 'danger': '#ed9188', 'warn': '#ddbb97', 'ok': '#9dccb0'},
}
for theme in ('light', 'dark'):
    print(f'\n[{theme}]')
    for k, nv in PALETTE[theme].items():
        if nv is None or k in ('shadow', 'blue_text'):
            continue
        ov = OLD[theme].get(k)
        if ov is None:
            continue
        oh, os_ = hue(ov)
        nh, ns = hue(nv)
        oc = contrast(ov, OLD[theme].get('card', '#ffffff' if theme == 'light' else '#1b2032'))
        nc = contrast(nv, PALETTE[theme]['card'])
        print(f'  {k:<10} {ov}(hue {oh}) -> {nv}(hue {nh})   对比度 {oc:.2f} -> {nc:.2f}')
