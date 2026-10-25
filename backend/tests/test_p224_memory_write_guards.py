"""[p224 2026-10-25] 记忆写侧三守卫：<cg> 整行剥离 / 切点配对守卫 / 微尾并入。

依据：docs 体检 L2/L3（.tmp_probe/p224_diagnoses.json memory 段）。三类碎渣
（裸插图关键词行、孤立 */” 标记行、25/36 字微型行）全部是写侧切块时代的产物：

- 2747/2733/2861 三条真实消息取自 p224_repro_final.py 的 DB 原文逐字拷贝；
- ``TestStructuralByteIdentity`` 钉死回归红线：structural 策略对现有消息的
  重切产物与存量字节一致（守卫只防未来病态切点，不改现有正确产物）；
  sha256 前 12 位是字节级锚点，lens 同时充当"原文拷贝是否失真"的校验和。
- ``TestDegradedSemanticRepro`` 复现 2026-10-05~10-07 semantic 时代的退化路径
  （epsilon=0.12 高于 bge-m3 实测最大相邻距离 0.101 ⇒ 断点恒 0 ⇒ ~450 字硬切），
  断言守卫生效：切点不再落在未闭合 *…*/“…” 对内。
"""

import hashlib
import json
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.memory_module import semantic_chunker as sc  # noqa: E402
from app.memory_module.config import memory_config  # noqa: E402
from app.utils import clean_memory_content, is_micro_marker_line  # noqa: E402

# 与 p224_repro_final.py 逐字一致的三条真实消息（消息 id → full_content 原文）
_REAL_MESSAGES_JSON = r"""{"2747": "<now_plot>\n\n<background scene=\"岚川北郊浅山别院\" />\n\n\"肯定能理解啊，难不成你要到我的屋子里看我操作你才安心吗。\"\n\n露缇雅原本半阖着眼睛，正把下巴搁在抱枕顶上，任由他掌心那点温度慢慢熨着小腹的空乏。这句轻飘飘的话滑进耳朵的一瞬间，她先是没反应过来，睫毛眨了眨，粉红的瞳孔里空白了一瞬。\n\n*……看他……操作？*\n\n*操作什么？*\n\n两秒之后，那个词在她脑子里\"轰\"地一下炸开了。\n\n露缇雅 | 惊恐 | “——！”\n\n她整个人从抱枕里弹起来半寸，光裸的脚趾在沙发上猛地蜷紧，后腰那对收在裙外的小翅膀扑棱了一下，尾尖那颗心形\"啪\"地抽紧，死死缠住他的手腕。脸从耳根一路烧到脖子，连锁骨上方的皮肤都泛着薄红。\n\n露缇雅 | 难堪 | “谁、谁要看那个了！”\n\n她把声音压得低低的，尾音却翘得发虚，抬手就要去捂他的嘴，手举到半空又觉得不合适，改成狠狠戳了他手臂一下。戳完自己先红了眼圈，别过脸去盯着落地窗外那片被晨光晒得发亮的山茶叶子。\n\n*他怎么说得出口的。*\n\n*当着我面。*\n\n*还操作。*\n\n*什么操作啊！*\n\n她抱着抱枕的手指攥得发白，心里那点火苗越烧越旺，可偏偏越气越觉得脸上发烫——因为她发现自己居然……听懂了。听懂之后耳根那片红，就不是气出来的了。\n\n露缇雅 | 窘迫 | “我是说……我是说你要真的觉得我这样很奇怪，你就直接讲清楚。”\n\n她闷闷地把脸转回来一点点，只露出眼睛在外面，睫毛还带着刚才没散尽的湿意，视线钉在自己搭在他掌心那只手上。\n\n露缇雅 | 纠结 | “别老是……别老是拐着弯逗我。”\n\n顿了顿，尾尖的心形松了半分，又缠回去，尾梢贴着他的腕骨一颤一颤。她自己也察觉到这一点，越想把尾巴收回去，它越是倔强地勾着，像是有自己的主意。\n\n露缇雅 | 委屈 | “还有那个‘安心’。我当然安心。”\n\n她小声嘟囔着，声音软下来，像是跟自己较劲。\n\n露缇雅 | 害羞 | “早上那样，你都没嫌我。那我不就……就安心了嘛。”\n\n说完这句她自己先受不了了，脸往抱枕里埋了一半，只留一截红透的后颈露在外面。客厅里很静，窗外的蝉鸣一阵一阵漫进来，厨房那头的冰箱低低地嗡着，把整栋别院衬得愈发安静。她光着的脚趾搭在沙发边缘，一下一下轻轻点着，把那点没处安放的软全踩进节奏里。\n\n安静了几秒，她忽然从抱枕后面探出脸，飞快地瞟了他一眼，那点装出来的恼意已经散了，只剩一双等答案的眼睛。\n\n露缇雅 | 依恋 | “那你以后别用那种话逗我。我会当真的。”\n\n说完她自己也愣了一下，慌忙把脸又埋回去，耳尖红得发亮。可搭在他掌心的那只手，却悄悄从虚虚搭着，收紧了一点，把整只小手都嵌进了他的掌心里。尾巴尖一下一下蹭着他的手腕，像是替她把那句\"会当真\"按了又按。\n\n</now_plot>\n\n<cg>害羞</cg>\n\n<cg>傲娇</cg>\n\n【声音：软糯羞窘、带着撒娇鼻音的娇软少女音】", "2733": "<now_plot>\n\n\"换好了吗\"——露缇雅愣了一下，才反应过来他在问自己身上这条裙子。\n\n她下意识低头看了看，浅蓝的荷叶边裙摆还带着刚熨过的挺括，是自己特意挑的一件。她吸了吸鼻子，把脸上没擦干净的泪痕蹭了蹭，小声\"嗯\"了一句。\n\n可紧接着那句\"换洗衣服你就自己洗吧\"落下来，她整个人又僵住了半秒。\n\n*……自己洗。*\n\n*他说的，是那条内裤。*\n\n露缇雅 | 难堪 | “知、知道啦。”\n\n她脸\"腾\"地又红了一片，从耳根一路烧到脖子，抬手就把脸别到一边去，像是这样就能把刚才那摊丢人的事从记忆里抹掉。可越是这样，她越忍不住用眼角去瞟他——瞟他是不是在笑，是不是在打量她。结果他神色平平，像刚才那句只是顺口一提的日常家务，一点别的意思都没有。\n\n*他到底……是装作不在意，还是真的不在意。*\n\n这个念头卡在她心里，上不去下不来。她刚才鼓足勇气问的那句\"会不会嫌弃我\"，到现在也没等到一个正经的答复，反倒是被一句\"自己洗衣服\"轻轻带过去了。胸口那点被接住的暖意还没散，又混进一点说不清的闷。\n\n她咬着下唇，尾巴尖在他小指上又收紧了一点，尾尖的心形一下一下蹭着他的指节。\n\n露缇雅 | 委屈 | “……你刚才是不是没听见我问你。”\n\n她把脸转回来，仰起来看他，睫毛还是湿的，粉红的眼睛里带着一点没消尽的红。语气软软的，带着点撒娇式的不甘心，像是非要讨个说法。\n\n露缇雅 | 忐忑 | “我问你会不会嫌弃我。”\n\n这一回她把话说全了，声音不大，却一字一顿，像是怕他再绕开。细白的手指在裙摆边悄悄攥起一小团布，攥得指节发白。\n\n空气静了两秒。\n\n走廊尽头的窗子开着一条缝，山风溜进来，掀了掀她垂在颊边的银发，也把她后腰那对小翅膀上贴着的裙料吹得轻轻起伏。她光着脚站在木地板上，脚趾忍不住蜷了一下，却一步都没往后退——往常被戳穿心事的时候，她总是先慌乱地拉开距离，可这一次，她只是站在原地等着。\n\n她其实也说不清自己为什么非要问这一句。明明从早上到现在，哥哥什么都替她兜住了：抱她下楼，抱她上楼，撞见那些东西也没说一句难听话，还把哭得稀里哗啦的她揽在怀里，说\"人之常情\"。可正因为被兜得这么稳，她才更怕——怕这份\"理解\"只是兄长式的宽容，怕他心里的某个角落，其实早就把她归类成了\"有点麻烦的妹妹\"，然后悄悄退开半步。\n\n露缇雅 | 害羞 | “还有那个……刚才的东西。”\n\n她说着，又飞快地补了一句，声音更小了，视线垂到两个人之间的地板上。\n\n露缇雅 | 纠结 | “我不是一天两天买回来的。攒了好久。就……就觉得自己好像有点奇怪。”\n\n她顿了顿，喉头滚了一下，像是把更难的话咽回去半截，只留下最外层的部分。\n\n露缇雅 | 犹豫 | “所以你要是觉得我很奇怪，你就直接说。别像刚才那样，问都不问就让我自己去洗衣服。”\n\n话说到最后，尾音有点翘，带着自己都没察觉的怨气。说完她自己也意识到这像是在耍赖，脸又烧起来，赶紧把视线挪到一边，只留尾巴还勾着他的手不肯放。\n\n窗外的蝉叫一阵接一阵，从浅山的林子里漫过来。她站了一会儿，到底没忍住，又把脸转回来一点点，用余光瞄他。那点装出来的硬气已经散了，只剩下湿漉漉的睫毛底下，一双等答案的眼睛。\n\n露缇雅 | 依恋 | “……你说句话呀。”\n\n尾尖的心形轻轻贴着他的指腹，一下、一下，像是替她把心跳都递了过去。\n\n</now_plot>\n\n<cg>害羞</cg>\n<cg>哭哭</cg>\n\n【声音：软糯委屈、带着哭腔余韵的娇软少女音】", "2861": "<now_plot>\n\n<background scene=\"岚川北郊浅山别院\" />\n\n“那就这样吗？”\n\n这句话落在走廊里，轻飘飘的，却像一根手指，正好戳在她心里那处最软、最不敢碰的地方。\n\n露缇雅本来已经把脸埋进他颈窝了，听见这句，整个人先僵了一下，睫毛在他肩头的衣料上颤了颤。她没立刻答，只是把手从他肩头慢慢收回来一点，攥着裙摆的一角，指节捏得发白。\n\n*就这样吗。*\n\n*就这样，进去，躺一会儿，然后呢。*\n\n*然后我肚子还是空的。*\n\n那道纹路底下又开始抽了，一阵一阵，比在楼下沙发上还急。她刚才一路被抱着上来，身上那点气味全散在他鼻尖底下，这会儿他这么一问，她心里那点侥幸就彻底没了——他这是在问她，要不要就到这儿。要不要就这么着，把刚才那些全当没发生。\n\n她咬着下唇，眼睛盯着那扇木门，看了好一会儿。\n\n*不要。*\n\n*我不要就这样。*\n\n这个念头冒出来的一瞬间，她耳根就烫了。她知道自己这副样子有多不像话——妹妹被哥哥抱到卧室门口，还赖在怀里不肯下来，还想说不要就这样。可她越是清楚这一点，越是把那句话在喉咙里压着，压得胸口发闷。\n\n露缇雅 | 纠结 | “……不要。”\n\n这两个字很小，几乎是从齿缝里漏出来的。说完她自己先愣住，随即慌忙把脸埋回他颈窝，只留一截烧红的后颈露在外面，声音闷闷的，带着一点她自己都没察觉的委屈。\n\n露缇雅 | 难堪 | “不要就这样。”\n\n顿了顿，她攥着裙摆的手松了半分，又慢慢收回去，指尖蹭着他衣领，像是在给自己壮胆。\n\n露缇雅 | 害羞 | “我进去……躺一会儿。你也进来。”\n\n说到“你也进来”的时候，她声音低下去，尾音黏着颤，连自己都觉得这话太直白了，赶紧又补了一句，越补越乱。\n\n露缇雅 | 窘迫 | “就……就躺一会儿。你别想歪。”\n\n说完她自己也觉得这补得太拙劣，耳尖又红了一层，干脆把脸整个埋进他颈窝，不吭声了。可尾尖那枚心形却已经先一步绕紧了他的手腕，尾梢一下一下蹭着腕骨，比她本人诚实太多。\n\n过了几秒，她才从他颈窝里抬起一点点脸，睫毛垂着，没敢看他的眼睛，只往那扇门上瞟了一眼，声音轻得像怕被谁听见。\n\n露缇雅 | 依恋 | “……开门。”\n\n</now_plot>\n\n<cg>害羞</cg>\n<cg>露出魔纹</cg>\n\n【声音：软糯羞窘、带着心慌与依恋气音的娇软少女音】"}"""

# structural 重切产物的字节级锚点（sha256 前 12 位），改动二/三施工前实测捕获。
# 同批 pinned lens 兼当"上文 _REAL_MESSAGES_JSON 拷贝是否失真"的校验和。
_EXPECTED_STRUCTURAL = {
    "2747": {
        "cleaned_len": 1125,
        "lens": [293, 320, 330, 154],
        "shas": ["bb1680d27431", "2f60ef470625", "29e25bf5a77f", "8d17fff176f5"],
    },
    "2733": {
        "cleaned_len": 1383,
        "lens": [327, 314, 309, 325, 78],
        "shas": ["c17cb1f07edf", "fe5620a8ea52", "603603335c82", "974a0ee72b6e", "4712f20090eb"],
    },
    "2861": {
        "cleaned_len": 887,
        "lens": [322, 333, 209],
        "shas": ["1d7e0a01542a", "1b0b91afbf7d", "a7825be19ea4"],
    },
}

_MESSAGES = json.loads(_REAL_MESSAGES_JSON)


def _clean(mid: str) -> str:
    return clean_memory_content(_MESSAGES[mid])


def _sha12(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:12]


class TestCgWholeLineStrip:
    """改动一：整行就是一个 <cg>…</cg> 时整行删；夹在正文中的标签不动。"""

    def test_whole_line_removed(self):
        out = clean_memory_content("剧情第一段，足够长的一句话。\n<cg>害羞</cg>\n剧情第二段。")
        assert "剧情第一段" in out and "剧情第二段" in out
        assert "害羞" not in out

    def test_line_with_surrounding_whitespace_removed(self):
        out = clean_memory_content("剧情。\n  <cg>傲娇</cg>  \n尾声。")
        assert "傲娇" not in out and "剧情。" in out and "尾声。" in out

    def test_tag_with_attribute_removed(self):
        out = clean_memory_content("剧情。\n<cg mood=\"blush\">露出魔纹</cg>\n尾声。")
        assert "露出魔纹" not in out

    def test_tag_inside_prose_kept_as_text(self):
        """反例：夹在正文中间的 <cg> 不删行，仍走拆标签留文字。"""
        out = clean_memory_content("她摆出<cg>害羞</cg>的表情，别过了脸。")
        assert "她摆出害羞的表情，别过了脸。" == out

    def test_unclosed_tag_falls_back_to_unwrap(self):
        """判据收窄：未闭合的 <cg> 不算"整行就是一个标签"，维持拆标签兜底。"""
        out = clean_memory_content("剧情。\n<cg>害羞\n尾声。")
        assert "害羞" in out and "剧情。" in out

    def test_real_messages_bare_keyword_lines_gone(self):
        """真实消息：裸插图关键词行消失，对话竖线里的"害羞"一字不动。"""
        out = _clean("2747")
        lines = [ln.strip() for ln in out.split("\n")]
        assert "害羞" not in lines and "傲娇" not in lines
        assert '露缇雅 | 害羞 | “早上那样，你都没嫌我。那我不就……就安心了嘛。”' in out
        assert "【声音：软糯羞窘、带着撒娇鼻音的娇软少女音】" in out
        out_2733 = _clean("2733")
        lines_2733 = [ln.strip() for ln in out_2733.split("\n")]
        assert "害羞" not in lines_2733 and "哭哭" not in lines_2733
        assert '露缇雅 | 害羞 | “还有那个……刚才的东西。”' in out_2733


class TestPairGuard:
    """改动二：切点落在未闭合 *…* / “…” 对内时移到对外交界。"""

    def test_cut_moves_before_unclosed_star_pair(self):
        # max_len=310 时原切点（句末！之后）落在 *什么操作啊！* 的开闭符之间
        text = "甲" * 300 + "*什么操作啊！*" + "乙" * 300
        cut = sc._find_cut_index(text, 310)
        assert cut == 300, f"切点应回退到开符之前（300），实际 {cut}"

    def test_cut_moves_before_unclosed_quote_pair(self):
        # max_len=304 时原切点落在 “不要。” 的开引号与闭引号之间
        text = "甲" * 300 + "“不要。”" + "乙" * 300
        cut = sc._find_cut_index(text, 304)
        assert cut == 300, f"切点应回退到开引号之前（300），实际 {cut}"

    def test_closed_pair_cut_unchanged(self):
        """切点不落在对内时是恒等变换（守卫不改现有正确产物）。

        全文无句末/弱/软边界 ⇒ 走硬切 310；head 内星号已闭合 ⇒ 守卫不动它。
        """
        text = "甲" * 300 + "*完整斜体对*" + "乙" * 300
        assert sc._find_cut_index(text, 310) == 310

    def test_opener_at_text_start_keeps_hard_cut(self):
        """开符就在文首、无处可退时维持原切点（不产生超限块/零切点）。"""
        text = "*一整段没有终止符的超长斜体内容" + "甲" * 500
        cut = sc._find_cut_index(text, 100)
        assert cut == 100

    def test_hard_cut_also_guarded(self):
        text = "甲" * 300 + "乙" * 49 + "*未闭合" + "丙" * 300
        # head[:350] 以未闭合的 *（下标 349）收尾 ⇒ 硬切 350 落在对内 → 回退到 349
        cut = sc._find_cut_index(text, 350)
        assert cut == 349, f"守卫应把硬切点挪到开符之前（349），实际 {cut}"


class TestDegradedSemanticRepro:
    """改动二端到端：semantic 退化路径（eps=0.12 + 全同向量 ⇒ 恒硬切）不再产出
    孤立标记头的碎块。该路径正是存量 9 行孤立星号头 / 12 行孤立右引号头的水源。"""

    @pytest.fixture(autouse=True)
    def _degraded_env(self, monkeypatch):
        monkeypatch.setattr(memory_config, "CHUNK_STRATEGY", "semantic")
        monkeypatch.setattr(memory_config, "CHUNK_DISTANCE_EPSILON", 0.12)
        monkeypatch.setattr(memory_config, "CHUNK_TRIGGER_CHARS", 100)
        monkeypatch.setattr(memory_config, "CHUNK_MIN_SENTENCE_CHARS", 2)

    @staticmethod
    def _same_vec_embed(sentences):
        import numpy as np

        return np.ones((len(sentences), 8), dtype="float32")

    @pytest.mark.parametrize("mid", ["2747", "2733", "2861"])
    def test_no_orphan_marker_heads(self, mid):
        chunks = sc.semantic_split(_clean(mid), embed_fn=self._same_vec_embed)
        assert len(chunks) >= 2
        for c in chunks:
            assert not c.lstrip().startswith("”"), f"孤立右引号头碎块残留: {c[:24]!r}"
        # 2747 的星号在原文全部成对 ⇒ 守卫生效的充要表现：任何切块星号数都是偶数
        if mid == "2747":
            for c in chunks:
                assert c.count("*") % 2 == 0, f"斜体对被拦腰切断: {c[-24:]!r}"

    def test_pair_moves_intact_into_next_chunk(self):
        """2747 的 *什么操作啊！* 应完整归入后块（施工前它被拦腰切成两半）。"""
        chunks = sc.semantic_split(_clean("2747"), embed_fn=self._same_vec_embed)
        assert any(c.lstrip().startswith("*什么操作啊！*") for c in chunks)


class TestStructuralByteIdentity:
    """回归红线：structural 策略对现有消息的重切产物必须与存量字节一致。

    （p224 侦查实测 structural 57 行 0 碎渣——守卫只防未来病态切点，
    微尾并入只认"纯 marker 类"块，真实剧情尾块不受影响。）
    """

    @pytest.mark.parametrize("mid", ["2747", "2733", "2861"])
    def test_chunks_byte_identical(self, mid):
        expected = _EXPECTED_STRUCTURAL[mid]
        cleaned = _clean(mid)
        assert len(cleaned) == expected["cleaned_len"], (
            f"消息 {mid} 清洗长度 {len(cleaned)} ≠ pinned {expected['cleaned_len']}"
            "（_REAL_MESSAGES_JSON 拷贝失真或清洗行为漂移）"
        )
        chunks = sc.structural_split(cleaned)
        assert [len(c) for c in chunks] == expected["lens"], (
            f"消息 {mid} 块长漂移：{[len(c) for c in chunks]} ≠ {expected['lens']}"
        )
        for i, c in enumerate(chunks):
            assert _sha12(c) == expected["shas"][i], (
                f"消息 {mid} 第 {i} 块字节漂移：{_sha12(c)} ≠ {expected['shas'][i]}"
            )


class TestMicroTailMerge:
    """改动三：末尾纯 marker/【声音】类微型块并入前块，上限 CHUNK_MAX_CHARS。"""

    @pytest.fixture(autouse=True)
    def _pin_structural(self, monkeypatch):
        monkeypatch.setattr(memory_config, "CHUNK_STRATEGY", "structural")

    def test_structural_voice_marker_tail_merged(self):
        """前块 330 + marker 13 = 343 > hi(337)：旧规则必分家，新规则（≤450）并入。"""
        marker = "【声音：软糯羞窘的娇软少女音】"
        body = "她把脸埋进他颈窝，指尖攥着他的衣角不放，" * 16 + "然后轻轻叹了一口气。"
        assert len(body) == 330
        text = body + "\n\n" + marker
        chunks = sc.structural_split(text)
        assert len(chunks) == 1, f"纯【声音】微尾应并入前块，实际 {[len(c) for c in chunks]}"
        assert marker in chunks[0]
        assert len(chunks[0]) <= memory_config.CHUNK_MAX_CHARS

    def test_structural_marker_tail_over_cap_stays_separate(self):
        """并入受 CHUNK_MAX_CHARS 上限约束：335 + 119 > 450 ⇒ 不并。"""
        body = "她把脸埋进他颈窝，指尖攥着他的衣角不放，" * 16 + "然后轻轻叹了一口气。轻轻叹气。"  # 335
        assert len(body) == 335
        marker = "【" + "声" * 117 + "】"  # 119 字纯【…】行，< lo(120)
        assert len(marker) == 119 and is_micro_marker_line(marker)
        chunks = sc.structural_split(body + "\n\n" + marker)
        assert len(chunks) == 2, f"超上限的 marker 尾不得强并：{[len(c) for c in chunks]}"

    def test_structural_real_content_tail_stays_separate(self):
        """真实剧情尾块（非 marker 类）即使 < lo 也不并过 hi 上限——字节回归红线。"""
        body = "她把脸埋进他颈窝，指尖攥着他的衣角不放，" * 15 + "然后轻轻叹了一口气。"
        tail = '露缇雅 | 依恋 | “……你说句话呀。”\n尾尖的心形轻轻贴着他的指腹，一下一下，像替她把心跳递过去。'
        chunks = sc.structural_split(body + "\n\n" + tail)
        assert len(chunks) == 2, f"真实剧情尾块不得被并入：{[len(c) for c in chunks]}"
        assert chunks[-1].startswith("露缇雅")

    @staticmethod
    def _three_topic_embed(n_a: int, n_b: int):
        """前 n_a 句向量 a、次 n_b 句向量 b、末句向量 c（两两正交 ⇒ 断点在组界）。"""
        import numpy as np

        vecs = np.eye(3, dtype="float32")

        def embed(sentences):
            out = []
            for idx in range(len(sentences)):
                if idx < n_a:
                    out.append(vecs[0])
                elif idx < n_a + n_b:
                    out.append(vecs[1])
                else:
                    out.append(vecs[2])
            return np.array(out, dtype="float32")

        return embed

    def test_semantic_marker_group_tail_merged(self, monkeypatch):
        """semantic 路径：_shape_sizes 幸存的纯 marker 尾组（前组并入会超上限时
        无邻居可并）在终切后并入前块。构造：A 组 459 字（终切余 17）+ marker 组。"""
        monkeypatch.setattr(memory_config, "CHUNK_STRATEGY", "semantic")
        monkeypatch.setattr(memory_config, "CHUNK_DISTANCE_EPSILON", 0.01)
        monkeypatch.setattr(memory_config, "CHUNK_TRIGGER_CHARS", 50)
        monkeypatch.setattr(memory_config, "CHUNK_MIN_SENTENCE_CHARS", 2)
        monkeypatch.setattr(memory_config, "CHUNK_BUFFER_WINDOW", 0)  # 去平滑，断点钉在组界
        sent = "这一句足够长，用来填充话题的内容。"
        assert len(sent) == 17
        text = sent * 27 + "【声音：少女音】"  # 27×17=459 > 450 ⇒ 组自身也要终切
        chunks = sc.semantic_split(text, embed_fn=self._three_topic_embed(27, 0))
        assert not any(sc._is_marker_block(c) for c in chunks), (
            f"纯 marker 尾组不得单独成块：{[c[-16:] for c in chunks]}"
        )
        assert chunks[-1].endswith("】") and len(chunks[-1]) > len("【声音：少女音】")

    def test_semantic_tail_merge_respects_cap(self, monkeypatch):
        """并入受 CHUNK_MAX_CHARS 上限约束：装不下就不并（不产生超限巨块）。

        构造同上但 A 组 799 字（终切余 357）：357 + 119 > 450 ⇒ 保持独立。"""
        monkeypatch.setattr(memory_config, "CHUNK_STRATEGY", "semantic")
        monkeypatch.setattr(memory_config, "CHUNK_DISTANCE_EPSILON", 0.01)
        monkeypatch.setattr(memory_config, "CHUNK_TRIGGER_CHARS", 50)
        monkeypatch.setattr(memory_config, "CHUNK_MIN_SENTENCE_CHARS", 2)
        monkeypatch.setattr(memory_config, "CHUNK_BUFFER_WINDOW", 0)
        sent = "这一句足够长，用来填充话题的内容。"
        big_marker = "【" + "声" * 117 + "】"  # 119 字纯【…】行
        text = sent * 47 + "\n" + big_marker
        chunks = sc.semantic_split(text, embed_fn=self._three_topic_embed(47, 0))
        assert len(chunks) == 3, f"超上限的 marker 尾不得强并：{[len(c) for c in chunks]}"
        assert chunks[-1] == big_marker
        assert all(len(c) <= memory_config.CHUNK_MAX_CHARS for c in chunks)

    def test_marker_block_predicate(self):
        assert is_micro_marker_line("【声音：软糯委屈、带着哭腔余韵的娇软少女音】")
        assert is_micro_marker_line("害羞")
        assert is_micro_marker_line("”|【声音：软糯】|害羞|露出魔纹")
        assert not is_micro_marker_line("……你说句话呀。")  # 有句末标点，保
        assert not is_micro_marker_line("露缇雅 | 依恋 | “……开门。”")
        assert sc._is_marker_block("【声音：x】\n害羞")
        assert not sc._is_marker_block("这是一句真实的剧情描述。")
