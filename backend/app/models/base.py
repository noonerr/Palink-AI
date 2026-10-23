from datetime import datetime, timezone
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()


def utc_now():
    """统一的时间戳默认值（UTC aware）。

    收口前 models/ 下 20 个文件各抄了一份同样的三行实现；本处为唯一真源。
    影响所有表 created_at/updated_at 的默认值，勿改返回值语义。
    """
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    """统一的时间戳字符串（UTC ISO 8601）。

    收口前 api/services 下 3 份 _utc_now_iso 各抄了一份同样的实现。
    """
    return datetime.now(timezone.utc).isoformat()
