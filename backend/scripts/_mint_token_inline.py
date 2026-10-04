"""在后端容器内签发 admin 访问令牌（验收脚本用；JWT 只经 stdout，不落盘）。"""

import sys

sys.path.insert(0, "/app")
from app.core.security import create_access_token  # noqa: E402

print("TOKEN=" + create_access_token({"sub": "admin"}))