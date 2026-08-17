"""SillyTavern 1.18.0 兼容的确定性 PRNG (seedrandom) 与字符串哈希。

本模块精确移植 ST 1.18.0 以下两个核心算法，使 ``{{pick}}`` 宏的随机选择
与 ST 前端逐字节一致（相同 chatIdHash + rawContent + offset → 相同结果）：

1. ``getStringHash`` (utils.js:522) — 53-bit MurmurHash2/3 变体。
2. ``seedrandom`` (seedrandom.js, David Bau) — RC4-drop[256] PRNG。

移植依据: ``SillyTavern-1.18.0/node_modules/seedrandom/seedrandom.js``
与 ``SillyTavern-1.18.0/public/scripts/utils.js``。
所有 JS 32 位整数运算用 ``& 0xFFFFFFFF`` 归一化到无符号 32 位空间，
与 JS ``Math.imul`` / ``>>>`` 在无符号解释下等价（最终输出仅用无符号值）。
"""
from __future__ import annotations


_WIDTH = 256
_MASK = 255  # width - 1
_CHUNKS = 6
_DIGITS = 52
_STARTDENOM = _WIDTH ** _CHUNKS        # 2^48
_SIGNIFICANCE = 2 ** _DIGITS           # 2^52
_OVERFLOW = _SIGNIFICANCE * 2          # 2^53


def _math_imul(a: int, b: int) -> int:
    """JS ``Math.imul``: 32 位整数乘法，返回低 32 位（无符号解释）。"""
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def st_get_string_hash(s: str, seed: int = 0) -> int:
    """ST 1.18.0 ``getStringHash`` (utils.js:522) — 53-bit MurmurHash2/3 变体。

    返回值范围为 [0, 2^53)，始终非负，与 JS ``getStringHash`` 逐位一致。
    """
    if not isinstance(s, str):
        return 0
    h1 = (0xDEADBEEF ^ seed) & 0xFFFFFFFF
    h2 = (0x41C6CE57 ^ seed) & 0xFFFFFFFF
    for ch in s:
        c = ord(ch)
        h1 = _math_imul(h1 ^ c, 2654435761)
        h2 = _math_imul(h2 ^ c, 1597334677)
    # JS: h1 = Math.imul(h1 ^ (h1 >>> 16), ...) ^ Math.imul(h2 ^ (h2 >>> 13), ...)
    # h1/h2 已为无符号 32 位，``>>>`` 等价于 Python ``>>``。
    h1 = (_math_imul(h1 ^ (h1 >> 16), 2246822507)
          ^ _math_imul(h2 ^ (h2 >> 13), 3266489909)) & 0xFFFFFFFF
    h2 = (_math_imul(h2 ^ (h2 >> 16), 2246822507)
          ^ _math_imul(h1 ^ (h1 >> 13), 3266489909)) & 0xFFFFFFFF
    # JS: 4294967296 * (2097151 & h2) + (h1 >>> 0)
    return 4294967296 * (h2 & 0x1FFFFF) + (h1 & 0xFFFFFFFF)


def _mixkey(seed_str: str, key: list) -> list:
    """ST seedrandom ``mixkey`` (seedrandom.js:179)。

    将种子字符串混入 key 整数数组，返回更新后的 key。
    ``key`` 在调用时通常为空列表 ``[]``（确定性模式，无 entropy pool）。
    """
    smear = 0  # JS ``var smear`` (undefined → 位运算视为 0)
    j = 0
    n = len(seed_str)
    while j < n:
        idx = j & _MASK
        # JS: smear ^= key[idx] * 19; key[idx] 为 undefined 时 * 19 = NaN，
        # NaN 在位运算中转为 0，故 smear ^= 0 = smear。
        existing = key[idx] if idx < len(key) else None
        if existing is not None:
            smear = (smear ^ (existing * 19)) & 0xFFFFFFFF
        else:
            # undefined * 19 → NaN → 位运算 0，smear 不变
            smear = smear & 0xFFFFFFFF
        val = (smear + ord(seed_str[j])) & _MASK
        if idx < len(key):
            key[idx] = val
        else:
            # 扩展 key 到 idx 位置（JS 数组稀疏赋值，这里补 0）
            key.extend([0] * (idx - len(key)))
            key.append(val)
        j += 1
    return key


class _ARC4:
    """ST seedrandom ARC4 (RC4) 实现 (seedrandom.js:116-147)。

    构造时执行 RC4 密钥调度，并丢弃前 256 字节输出（RC4-drop[256]）。
    """

    def __init__(self, key: list) -> None:
        keylen = len(key)
        if not keylen:
            # JS: 空密钥视为 [0]
            key = [0]
            keylen = 1
        self.S = list(range(_WIDTH))
        self.i = 0
        self.j = 0
        j = 0
        s = self.S
        for i in range(_WIDTH):
            t = s[i]
            j = (j + key[i % keylen] + t) & _MASK
            s[i] = s[j]
            s[j] = t
        # RC4-drop[256]: 丢弃前 256 字节
        self._g(_WIDTH)

    def _g(self, count: int) -> int:
        """返回后续 ``count`` 字节输出拼接成的整数（r = r*256 + byte）。"""
        r = 0
        i = self.i
        j = self.j
        s = self.S
        while count:
            i = (i + 1) & _MASK
            t = s[i]
            j = (j + t) & _MASK
            s[i] = s[j]
            s[j] = t
            r = r * _WIDTH + s[(s[i] + s[j]) & _MASK]
            count -= 1
        self.i = i
        self.j = j
        return r


def _flatten_seed(seed) -> str:
    """ST seedrandom ``flatten`` (seedrandom.js:164) 对数值种子的简化。

    对于数值 seed: ``flatten(seed, 3)`` 返回 ``String(seed) + '\\0'``。
    （JS: typeof number !== 'object' 且 !== 'string' → ``obj + '\\0'``）
    """
    if isinstance(seed, str):
        return seed
    return str(seed) + "\0"


def st_seedrandom(seed) -> "_StPrng":
    """ST 1.18.0 ``seedrandom(seed)`` 等价（确定性，无 entropy）。

    ``seed`` 为数值（通常是 ``getStringHash`` 结果）或字符串。
    返回一个 PRNG 对象，其 ``next()`` 返回 [0, 1) 浮点数，与 JS
    ``seedrandom(seed)()`` 逐位一致。
    """
    seed_str = _flatten_seed(seed)
    key: list = []
    _mixkey(seed_str, key)
    arc4 = _ARC4(key)

    return _StPrng(arc4)


class _StPrng:
    """seedrandom PRNG 句柄，``next()`` 对齐 JS ``prng()``。"""

    def __init__(self, arc4: _ARC4) -> None:
        self._arc4 = arc4

    def next(self) -> float:
        """返回 [0, 1) 浮点数，与 JS ``prng()`` (seedrandom.js:58-73) 一致。"""
        arc4 = self._arc4
        n = arc4._g(_CHUNKS)          # < 2^48
        d = _STARTDENOM               # 2^48
        x = 0
        while n < _SIGNIFICANCE:      # n < 2^52
            n = (n + x) * _WIDTH
            d *= _WIDTH
            x = arc4._g(1)
        while n >= _OVERFLOW:         # n >= 2^53
            n /= 2
            d /= 2
            x = int(x) >> 1           # JS ``>>>= 1`` (无符号右移)
        return (n + x) / d


def st_pick_index(chat_id_hash, raw_content: str, offset: int, list_length: int) -> int:
    """ST 1.18.0 ``{{pick}}`` 宏的确定性索引计算 (macros.js:516-544)。

    参数:
        chat_id_hash: 聊天 ID 哈希（``getStringHash(chatId)``，或缓存的
            ``chat_metadata.chat_id_hash``）。可为 int 或 str。
        raw_content: 宏所在文本的原始完整内容（宏求值前的文本）。
        offset: ``{{pick}}`` 匹配在 ``raw_content`` 中的起始位置（``m.start()``）。
        list_length: 候选列表长度。

    返回: ``Math.floor(rng() * list_length)`` 的整数索引。
    """
    raw_content_hash = st_get_string_hash(raw_content)
    combined = f"{chat_id_hash}-{raw_content_hash}-{offset}"
    final_seed = st_get_string_hash(combined)
    rng = st_seedrandom(final_seed)
    return int(rng.next() * list_length)
