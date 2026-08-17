import json
from app.services.mvu_engine import build_initial_stat_data

cb_content = "<initvar>\n桃汐:\n  头像通常: \"http://x/1.png\"\n  服饰: \"粉色毛衣\"\n  内心想法: \"想打招呼\"\n  发情期: \"2026年05月28日\"\n苏小兰:\n  头像通常: \"http://x/2.png\"\n</initvar>"

ext = {
    "character_book": {
        "entries": {
            "44": {"content": cb_content},
        }
    },
    "tavern_helper": {
        "scripts": [
            {
                "content": (
                    "import { registerMvuSchema } from 'x';\n"
                    "export const Schema = z.object({\n"
                    "  桃汐: z.object({\n"
                    "    头像通常: z.string().prefault(''),\n"
                    "    服饰: z.string().prefault(''),\n"
                    "    内心想法: z.string().prefault(''),\n"
                    "    发情期: z.string().prefault(''),\n"
                    "  }).prefault({}),\n"
                    "  苏小兰: z.object({\n"
                    "    头像通常: z.string().prefault(''),\n"
                    "  }).prefault({}),\n"
                    "});\n"
                )
            }
        ],
        "variables": {},
    },
}

r = build_initial_stat_data(ext)
print(json.dumps(r, ensure_ascii=False, indent=1))