"""admin 图片清理递归修复回归（AUDIT-2026-09-25）。

背景：旧实现只遍历 uploads 的一层目录，`generated-images/`、`tts_clones/`
等子目录在 os.remove 时抛 IsADirectoryError 被 except 吞掉——生成图实际
永不清理。修复后按 os.walk 递归删除过期文件并收掉空目录（根目录保留）。
"""

import os
import sys
import time
from datetime import datetime, timedelta, timezone

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.api.admin import _cleanup_stale_upload_files  # noqa: E402


def _make_file(path: str, content: bytes = b"x") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(content)


class TestRecursiveCleanup:
    def test_nested_generated_images_get_cleaned(self, tmp_path):
        upload_dir = str(tmp_path / "uploads")
        generated = os.path.join(upload_dir, "40", "generated-images")
        _make_file(os.path.join(generated, "old.png"), b"png")
        _make_file(os.path.join(upload_dir, "40", "top.txt"), b"txt")
        # 让文件时间戳早于 cutoff（cutoff = 30 天前 → 文件放 40 天前）
        past = time.time() - 40 * 24 * 3600
        os.utime(os.path.join(generated, "old.png"), (past, past))
        os.utime(os.path.join(upload_dir, "40", "top.txt"), (past, past))

        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        deleted, freed = _cleanup_stale_upload_files(upload_dir, cutoff)

        assert (deleted, freed) == (2, 6)
        assert not os.path.exists(os.path.join(generated, "old.png"))
        assert not os.path.exists(os.path.join(upload_dir, "40", "top.txt"))

    def test_recent_files_survive(self, tmp_path):
        upload_dir = str(tmp_path / "uploads")
        generated = os.path.join(upload_dir, "7", "generated-images")
        _make_file(os.path.join(generated, "fresh.png"), b"png")

        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        deleted, _freed = _cleanup_stale_upload_files(upload_dir, cutoff)

        assert deleted == 0
        assert os.path.exists(os.path.join(generated, "fresh.png"))

    def test_empty_dirs_removed_but_root_kept(self, tmp_path):
        upload_dir = str(tmp_path / "uploads")
        generated = os.path.join(upload_dir, "9", "generated-images")
        _make_file(os.path.join(generated, "old.png"), b"png")
        past = time.time() - 40 * 24 * 3600
        os.utime(os.path.join(generated, "old.png"), (past, past))

        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        _cleanup_stale_upload_files(upload_dir, cutoff)

        assert not os.path.exists(generated)  # 空壳目录被收掉
        assert not os.path.exists(os.path.join(upload_dir, "9"))
        assert os.path.isdir(upload_dir)      # uploads 根目录保留

    def test_missing_dir_is_noop(self, tmp_path):
        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        deleted, freed = _cleanup_stale_upload_files(str(tmp_path / "nope"), cutoff)
        assert (deleted, freed) == (0, 0)
