"""ST 1.18.0 画廊端点契约测试（对齐 src/endpoints/images.js + util.js getImages）。

重点验证 P1-10 修复后的真实契约：
- /api/images/list 响应为「纯字符串数组」（非对象数组）
- 缺 folder → 400 {"error": "No folder specified"}
- type 位掩码过滤（IMAGE=1/VIDEO=2/AUDIO=4），默认仅 IMAGE
- 默认排序 sortField='date'
"""
import pytest

from app.api.silly_tavern import (
    STImagesListRequest,
    _st_filter_media_by_type,
    _ST_MEDIA_TYPE_IMAGE,
    _ST_MEDIA_TYPE_VIDEO,
    _ST_MEDIA_TYPE_AUDIO,
)


# --- 纯函数：type 位掩码过滤（ST getImages 等价逻辑） ----------------------

def test_filter_image_only():
    names = ["a.png", "b.mp4", "c.mp3", "d.jpg", "e.webm"]
    assert _st_filter_media_by_type(names, _ST_MEDIA_TYPE_IMAGE) == ["a.png", "d.jpg"]


def test_filter_video_only():
    names = ["a.png", "b.mp4", "c.mp3", "d.mov", "e.webm"]
    assert set(_st_filter_media_by_type(names, _ST_MEDIA_TYPE_VIDEO)) == {"b.mp4", "d.mov", "e.webm"}


def test_filter_audio_only():
    names = ["a.png", "b.mp4", "c.mp3", "d.wav", "e.ogg"]
    assert set(_st_filter_media_by_type(names, _ST_MEDIA_TYPE_AUDIO)) == {"c.mp3", "d.wav", "e.ogg"}


def test_filter_combined_mask():
    names = ["a.png", "b.mp4", "c.mp3", "d.txt", "e.svg"]
    result = _st_filter_media_by_type(names, _ST_MEDIA_TYPE_IMAGE | _ST_MEDIA_TYPE_VIDEO | _ST_MEDIA_TYPE_AUDIO)
    assert set(result) == {"a.png", "b.mp4", "c.mp3", "e.svg"}


def test_filter_default_is_image_only():
    """ST 默认 type=IMAGE(1)，不应返回视频（修复前会误返回图+视频）。"""
    names = ["a.png", "b.mp4", "c.jpg"]
    assert _st_filter_media_by_type(names, 1) == ["a.png", "c.jpg"]


# --- 请求模型默认值（对齐 ST images.js:96-98） ----------------------------

def test_model_defaults_match_st():
    req = STImagesListRequest(folder="x")
    assert req.sortField == "date"      # ST 默认 'date'（修复前为 'name'）
    assert req.type == 1                # ST MEDIA_REQUEST_TYPE.IMAGE
    assert req.sortOrder == "asc"
    # folder 可选（缺失时由处理器返回 400，而非 FastAPI 422）
    assert STImagesListRequest().folder is None


# --- HTTP 行为（需鉴权） --------------------------------------------------

def test_http_missing_folder_returns_400(client, auth_headers):
    resp = client.post("/api/images/list", json={}, headers=auth_headers)
    assert resp.status_code == 400
    assert resp.json() == {"error": "No folder specified"}


def test_http_empty_folder_returns_pure_string_array(client, auth_headers):
    resp = client.post(
        "/api/images/list",
        json={"folder": "__st_gallery_contract_nonexistent__"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    # ST 返回纯字符串数组，不是 {"files": [...]} 对象
    assert isinstance(body, list)
    assert all(isinstance(x, str) for x in body)
