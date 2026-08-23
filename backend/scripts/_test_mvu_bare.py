# -*- coding: utf-8 -*-
"""mvu_engine 裸 JSON Patch 容错单测"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import json

from app.services.mvu_engine import (
    extract_update_variable_blocks,
    strip_update_variable_blocks,
    _looks_like_stat_data_patch,
    _find_stat_data_patch_spans,
)

# 1. 结构校验
print('=== _looks_like_stat_data_patch ===')
print('patch-like:', _looks_like_stat_data_patch([
    {'op': 'replace', 'path': '/桃汐/好感度', 'value': 0},
    {'op': 'delta', 'path': '/苏小兰/好感度', 'value': -5},
]))
print('normal json:', _looks_like_stat_data_patch([{'a': 1, 'b': 2}]))
print('empty:', _looks_like_stat_data_patch([]))
print('readonly _var:', _looks_like_stat_data_patch([{'op': 'replace', 'path': '/_变量', 'value': 1}]))

# 2. 裸 JSON Patch 提取
print('\n=== extract_update_variable_blocks (bare JSON) ===')
bare = '正文内容...\n[\n  {"op": "replace", "path": "/桃汐/好感度", "value": 0},\n  {"op": "replace", "path": "/苏小兰/好感度", "value": 20}\n]\n结尾'
blocks = extract_update_variable_blocks(bare)
print('bare blocks:', len(blocks), blocks)

# 3. 包裹格式仍正常
print('\n=== extract_update_variable_blocks (wrapped) ===')
wrapped = '正文\n<UpdateVariable>\n<Analysis>ok</Analysis>\n<JSONPatch>\n[{"op": "replace", "path": "/桃汐/好感度", "value": 10}]\n</JSONPatch>\n</UpdateVariable>'
print('wrapped blocks:', len(extract_update_variable_blocks(wrapped)))

# 4. strip 裸 JSON
print('\n=== strip_update_variable_blocks (bare) ===')
stripped = strip_update_variable_blocks(bare)
print('stripped:', repr(stripped))
assert '{"op"' not in stripped, 'FAIL: bare JSON not stripped'
print('OK bare stripped')

# 5. 正文无 JSON 时不变
print('\n=== strip normal text ===')
normal = '今天天气不错，我们去公园吧。'
assert strip_update_variable_blocks(normal) == normal.strip()
print('OK normal unchanged')

# 6. 用真实 2160 内容（含裸 JSON 但无 <UpdateVariable>）
print('\n=== real msg2160 ===')
try:
    with open('scripts/../.dbg/msg2160.txt', encoding='utf-8', errors='replace') as f:
        real = f.read()
except Exception:
    real = ''
if real:
    blocks_real = extract_update_variable_blocks(real)
    print('real blocks:', len(blocks_real))
    if blocks_real:
        print('first block size:', len(blocks_real[0]), 'first item:', json.dumps(blocks_real[0][0], ensure_ascii=False)[:200])
    stripped_real = strip_update_variable_blocks(real)
    print('real len before/after:', len(real), '->', len(stripped_real))
else:
    print('msg2160.txt not available, skip')

print('\nALL DONE')
