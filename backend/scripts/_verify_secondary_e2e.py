"""端到端验证：副 AI 兜底链路（_run_secondary_mvu_sync）。

模拟真实场景：主模型没输出 <UpdateVariable> 块，副 AI 兜底应生成 patches。
用真实角色 schema + 真实剧情 + 已配置的副模型（deepseek-v4-flash）。
"""

import asyncio
import json
import logging
import sys

sys.path.insert(0, "/app")

logging.basicConfig(level=logging.INFO)

from app.core.database import SessionLocal  # noqa: E402
from app.models import Character  # noqa: E402
from app.services.mvu_engine import (  # noqa: E402
    build_initial_stat_data,
    apply_patches,
    merge_character_book_entries,
)
from app.api.websocket import _run_secondary_mvu_sync  # noqa: E402

CHAR_ID = "c21c3512-7d38-4177-a55f-742afabe5ca6"
USER_ID = 1

STORY = """（清晨的阳光透过窗帘缝隙洒进出租屋，我揉了揉眼睛从床上坐起来。手机屏幕亮着，显示今天是8月18日，周二——新学期前的最后一个自由周。窗外传来几声清脆的鸟鸣，混杂着远处校园里隐约的晨跑声。）

我伸了个懒腰，趿拉着拖鞋走到窗边拉开窗帘。大学城的街道上已经有三三两两的学生走动，其中不少女生头顶的猫耳在晨光中微微抖动，尾巴悠闲地晃着。

手机震了一下，是桃汐发来的消息：「懒虫起床没喵！今天说好陪我去猫咪甜品屋的，新出了布偶慕斯，再不去就被抢光啦！」

我盯着屏幕笑了笑。桃汐从小就是这样，急性子，做什么都风风火火的。我回了个「起了起了，十分钟后楼下见」，然后开始洗漱换衣服。

出门时，晨风带着初秋的凉意扑面而来。我沿着熟悉的路走到桃汐家楼下，她已经在门口等着了——樱粉色的短发在阳光下泛着柔和的光泽，布偶猫特有的蓝眼睛亮晶晶的，尾巴在身后轻轻摆动。

「慢死了喵！」她叉着腰，假装生气地瞪我，但嘴角的笑意藏不住，「再晚一步布偶慕斯就没了，你赔我啊！」

「这不是来了嘛。」我笑着跟上她的脚步。

桃汐走在我旁边，尾巴时不时蹭过我的手背，毛茸茸的触感带着温度。她今天穿了件浅蓝色的连衣裙，裙摆随着步伐轻轻晃动。我们沿着种满梧桐树的街道往商业街方向走，她一路上叽叽喳喳地说着暑假的见闻。

「对了对了，」她忽然转过头来，猫耳竖得笔直，「你下学期是不是要去做家教？我听阿姨说的。」

「嗯，老城区那边有个初二的小姑娘，家长托人介绍的。」

「哇——」桃汐眨眨眼，尾巴尖微微翘起，「那你要加油喵！要是教不好，人家家长可是会找上门的哦。」

我无奈地笑了笑：「你倒是比我还有信心。」

她哼了一声，仰起下巴：「那当然，你可是我从小看到大的笨蛋，再怎么笨也不会差到哪去的喵！」

阳光透过树叶的缝隙洒下来，在她脸上投下斑驳的光影。我忽然觉得，这个暑假的最后一周，大概会过得挺有意思的。"""


async def main() -> None:
    db = SessionLocal()
    db.commit()
    char = db.query(Character).filter(Character.id == CHAR_ID).first()

    # 构建 char_ext_raw
    char_ext_raw = {}
    try:
        char_ext_raw = json.loads(char.extensions) if isinstance(char.extensions, str) else (char.extensions or {})
    except Exception:
        pass
    wb_entries = []
    for wb in (char.world_books or []):
        if getattr(wb, "type", "") == "character_book":
            for stage in (wb.entries or []):
                wb_entries.append(str(stage.content or ""))
    char_ext_raw = merge_character_book_entries(char_ext_raw, wb_entries)

    # 初始 stat_data
    init = build_initial_stat_data(char_ext_raw)
    print(f"[INFO] 初始 stat_data 世界信息: {init.get('stat_data', {}).get('世界信息')}")

    # 调 _run_secondary_mvu_sync（websocket 里的兜底函数）
    main_loop = asyncio.get_running_loop()
    patches, logs = await asyncio.to_thread(
        _run_secondary_mvu_sync,
        db, USER_ID, char_ext_raw, init, STORY, main_loop,
    )
    print(f"[INFO] 副 AI 兜底生成 {len(patches)} 个 patches")
    for p in patches:
        print(f"  patch: {p}")

    if patches:
        new_vars, applied = apply_patches(init, patches)
        sd = new_vars.get("stat_data", {})
        print(f"[INFO] 应用后 世界信息: {sd.get('世界信息')}")
        print(f"[INFO] 应用后 桃汐好感度: {sd.get('桃汐', {}).get('好感度')}")
        print(f"[INFO] 应用后 桃汐服饰: {sd.get('桃汐', {}).get('服饰')}")
        print("[PASS] 副 AI 兜底链路正常（主模型没输出块时也能更新 stat_data）")
    else:
        print("[WARN] 副 AI 兜底未生成 patches")


asyncio.run(main())
