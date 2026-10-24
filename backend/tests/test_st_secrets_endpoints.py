"""[API-1 2026-10-24] /api/secrets/* 八端点真实现 —— 存/读闭环 + 越权隔离。

一手依据（不是推测，锚点都在本仓/上游源码里）：

- ST 1.18.0 服务端形状：``_reference/sillytavern-1.18.0/src/endpoints/secrets.js``
  （write:511 / read:529 / view:540 / find:560 / delete:588 / rotate:606 /
  rename:624 / settings:642；SECRET_KEYS:9-73；getMaskedValue:181-195）。
- ST 1.18.0 客户端消费：``public/scripts/secrets.js`` 只看 response.ok + JSON 体
  （write:361 取 {id}、find:436 取 {value}、read:413 整个 state map、
  delete/rotate/rename 只认 response.ok）。
- 本批替换对象：silly_tavern.py 的 Task 37 stub（{result:False, error:"Use
  Palink ConnectionProfiles API"} 时代行为）。

钉的不是"端点存在"（test_st_contract.py 的静态注册检查已覆盖），是行为：

  ① write→read 闭环：find **逐字**读回原值；read 是整个 state map（值打码）；
  ② 落库即密文：value_encrypted 列不含明文，Fernet 解密还原原值；
  ③ view 是扁平 map（ST getAllSecrets 形状），只含本用户的全部 key；
  ④ delete/rotate/rename 各自语义 + ST 的 400/204/404 错误形状（纯文本文案逐字）；
  ⑤ **越权失败**（用户 B 的 token 读/列/删/改名用户 A 的 key 必须失败）——
     本文件的反证锚：去掉后端 user_id 过滤，本组用例必须红；
  ⑥ 无凭据不得 200（与同族 ST 写面同一道门，QR 批 ⑦ 同款）；
  ⑦ SECRET_KEYS 62 键与 ST 1.18.0 声明序逐键一致（防转录漂移）。

单槽位语义（unique(user_id,key)，主脑钉死）：write 覆盖当前值且行 id 稳定、
rotate 恒 204、read 的 state 每 key 至多一条 —— 与 ST 多条目数组的差异见
silly_tavern.py 端点 docstring。

运行: cd backend && py -3 -m pytest tests/test_st_secrets_endpoints.py -q
"""
import uuid as _uuid

import pytest
from fastapi import status
from fastapi.testclient import TestClient

WRITE_PATH = "/api/secrets/write"
READ_PATH = "/api/secrets/read"
VIEW_PATH = "/api/secrets/view"
FIND_PATH = "/api/secrets/find"
DELETE_PATH = "/api/secrets/delete"
ROTATE_PATH = "/api/secrets/rotate"
RENAME_PATH = "/api/secrets/rename"
SETTINGS_PATH = "/api/secrets/settings"

# 与 ST 1.18.0 src/endpoints/secrets.js:9-73 的 SECRET_KEYS 值序一致
# （_MIGRATED 迁移标记有意排除——ST getSecretState 也跳过它）。
# 这份清单是独立转录的第二份账本，与实现的 _SECRET_KEY_IDS 互为对账。
ST_SECRET_KEYS_IN_ORDER = [
    "api_key_horde", "api_key_mancer", "api_key_vllm", "api_key_aphrodite",
    "api_key_tabby", "api_key_openai", "api_key_novel", "api_key_claude",
    "deepl", "libre", "libre_url", "lingva_url", "api_key_openrouter",
    "api_key_ai21", "oneringtranslator_url", "deeplx_url", "api_key_makersuite",
    "api_key_vertexai", "api_key_serpapi", "api_key_togetherai",
    "api_key_mistralai", "api_key_custom", "api_key_ooba", "api_key_infermaticai",
    "api_key_dreamgen", "api_key_nomicai", "api_key_koboldcpp", "api_key_llamacpp",
    "api_key_cohere", "api_key_perplexity", "api_key_groq", "api_key_azure_tts",
    "api_key_featherless", "api_key_huggingface", "api_key_stability",
    "api_key_custom_openai_tts", "api_key_tavily", "api_key_chutes",
    "api_key_electronhub", "api_key_nanogpt", "api_key_bfl", "api_key_comfy_runpod",
    "api_key_falai", "api_key_generic", "api_key_deepseek", "api_key_serper",
    "api_key_aimlapi", "api_key_xai", "api_key_fireworks",
    "vertexai_service_account_json", "api_key_minimax", "minimax_group_id",
    "api_key_moonshot", "api_key_cometapi", "api_key_azure_openai", "api_key_zai",
    "api_key_siliconflow", "api_key_elevenlabs", "api_key_pollinations",
    "volcengine_app_id", "volcengine_access_key", "api_key_workers_ai",
]


def _second_user(db_session) -> dict[str, str]:
    """造用户 B 并发其 Bearer headers（越权测试的对端）。"""
    from app.core.security import create_access_token, get_password_hash
    from app.models import User

    user = User(
        username=f"st_secrets_other_{_uuid.uuid4().hex[:8]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    token = create_access_token({"sub": user.username})
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# ① settings / 读写闭环
# ---------------------------------------------------------------------------

def test_settings_returns_allow_keys_exposure_false(client, auth_headers):
    """ST secrets.js:642-644：{allowKeysExposure}；Palink 恒 False（ST 默认口径）。"""
    resp = client.post(SETTINGS_PATH, json={}, headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK, resp.text
    assert resp.json() == {"allowKeysExposure": False}


def test_write_find_roundtrip_exact_value(client, auth_headers):
    """① 存进去什么，find 就逐字吐什么——这是 P-1 要修活的链路本体。"""
    value = "fixture-roundtrip-9876543210-abcdefXYZ"
    resp = client.post(WRITE_PATH, json={"key": "api_key_custom", "value": value, "label": "main"}, headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK, resp.text
    body = resp.json()
    assert isinstance(body.get("id"), str) and body["id"], body

    found = client.post(FIND_PATH, json={"key": "api_key_custom"}, headers=auth_headers)
    assert found.status_code == status.HTTP_200_OK, found.text
    assert found.json() == {"value": value}, "find 没有逐字读回原值"


def test_rewrite_same_key_keeps_id_and_replaces_value(client, auth_headers):
    """单槽位语义钉死：同 key 重写 = 覆盖值、行 id 稳定（docstring 承诺的行为）。"""
    r1 = client.post(WRITE_PATH, json={"key": "api_key_custom", "value": "first-value-0001"}, headers=auth_headers)
    id1 = r1.json()["id"]
    r2 = client.post(WRITE_PATH, json={"key": "api_key_custom", "value": "second-value-0002", "label": "v2"}, headers=auth_headers)
    assert r2.status_code == status.HTTP_200_OK
    assert r2.json()["id"] == id1, "重写不应换行 id（单槽位 upsert）"
    found = client.post(FIND_PATH, json={"key": "api_key_custom"}, headers=auth_headers)
    assert found.json() == {"value": "second-value-0002"}


def test_read_state_map_shape(client, auth_headers):
    """read 回整个 state map（ST getSecretState 形状），不是 stub 时代的信封。"""
    value = "fixture-state-map-value-0123456789"  # 30 字符 > 10
    client.post(WRITE_PATH, json={"key": "api_key_custom", "value": value, "label": "mine"}, headers=auth_headers)
    resp = client.post(READ_PATH, json={}, headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK, resp.text
    state = resp.json()
    assert isinstance(state, dict)
    # 已知键：存过的给单元素数组（值打码 = 7 星 + 末 3 位），active 恒真
    entries = state.get("api_key_custom")
    assert isinstance(entries, list) and len(entries) == 1, entries
    entry = entries[0]
    assert set(entry) == {"id", "value", "label", "active"}, entry
    assert entry["value"] == "*" * 7 + value[-3:], entry
    assert value not in resp.text, "state map 泄露了明文"
    assert entry["label"] == "mine" and entry["active"] is True
    # 没存的已知键：null（ST 同款）
    assert state.get("api_key_openai") is None
    # 未写入的自定义键不该出现在 state（ST getSecretState 只枚举已知键）
    assert "my_plugin_custom_key" not in state


def test_state_label_defaults_to_unlabeled(client, auth_headers):
    """write 不带 label → state 显示 ST 默认 'Unlabeled'。"""
    client.post(WRITE_PATH, json={"key": "api_key_custom", "value": "no-label-value"}, headers=auth_headers)
    state = client.post(READ_PATH, json={}, headers=auth_headers).json()
    assert state["api_key_custom"][0]["label"] == "Unlabeled"


# ---------------------------------------------------------------------------
# ② 落库即密文
# ---------------------------------------------------------------------------

def test_value_never_stored_in_plaintext(client, auth_headers, db_session):
    """value 永不明文落库：列里是 Fernet 密文，解密后还原原值。"""
    from app.api.silly_tavern import _secret_decrypt
    from app.models import StPluginSecret

    value = "fixture-plaintext-must-not-leak-42"
    client.post(WRITE_PATH, json={"key": "api_key_custom", "value": value}, headers=auth_headers)
    row = db_session.query(StPluginSecret).one()
    assert row.value_encrypted != value
    assert value not in row.value_encrypted
    assert _secret_decrypt(row.value_encrypted) == value


# ---------------------------------------------------------------------------
# ④ ST 错误形状（文案逐字 + 204/404 空体）
# ---------------------------------------------------------------------------

def test_write_validation_400_st_text(client, auth_headers):
    """ST secrets.js:515-517：!key || typeof value !== 'string' → 400 'Invalid key or value'。"""
    for payload in ({"value": "no-key"}, {"key": "api_key_custom"}, {"key": "", "value": "x"}, {"key": "k", "value": 123}):
        resp = client.post(WRITE_PATH, json=payload, headers=auth_headers)
        assert resp.status_code == status.HTTP_400_BAD_REQUEST, (payload, resp.status_code)
        assert resp.text == "Invalid key or value", resp.text
    # 无 body（Body(None) → payload None）同款 400
    resp = client.post(WRITE_PATH, headers=auth_headers)
    assert resp.status_code == status.HTTP_400_BAD_REQUEST
    assert resp.text == "Invalid key or value"


def test_find_validation_and_404(client, auth_headers):
    """ST secrets.js:564-578：!key → 400 'Key is required'；state 缺该键 → 404 空体。"""
    resp = client.post(FIND_PATH, json={}, headers=auth_headers)
    assert resp.status_code == status.HTTP_400_BAD_REQUEST
    assert resp.text == "Key is required"
    resp = client.post(FIND_PATH, json={"key": "api_key_custom"}, headers=auth_headers)
    assert resp.status_code == status.HTTP_404_NOT_FOUND
    assert resp.content == b"", "ST sendStatus(404) 是空体"


def test_find_wrong_id_returns_empty_value(client, auth_headers):
    """ST readSecret（:268-282）find-miss：id 对不上回 {value: ''}，不是 404。"""
    r = client.post(WRITE_PATH, json={"key": "api_key_custom", "value": "real-value-9999"}, headers=auth_headers)
    real_id = r.json()["id"]
    resp = client.post(FIND_PATH, json={"key": "api_key_custom", "id": "not-the-id"}, headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK
    assert resp.json() == {"value": ""}
    resp = client.post(FIND_PATH, json={"key": "api_key_custom", "id": real_id}, headers=auth_headers)
    assert resp.json() == {"value": "real-value-9999"}


# ---------------------------------------------------------------------------
# ③ view 扁平 map
# ---------------------------------------------------------------------------

def test_view_flat_map_lists_all_own_keys(client, auth_headers):
    """ST secrets.js:540-558 + getAllSecrets：{key: 当前值} 扁平 map，全量本用户。"""
    client.post(WRITE_PATH, json={"key": "api_key_custom", "value": "v-custom-1"}, headers=auth_headers)
    client.post(WRITE_PATH, json={"key": "deepl", "value": "v-deepl-2"}, headers=auth_headers)
    resp = client.post(VIEW_PATH, json={}, headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK, resp.text
    data = resp.json()
    assert data == {"api_key_custom": "v-custom-1", "deepl": "v-deepl-2"}, data


# ---------------------------------------------------------------------------
# delete / rotate / rename 语义
# ---------------------------------------------------------------------------

def test_delete_semantics(client, auth_headers):
    """ST secrets.js:588-604：命中删→204 空体；没命中也 204；!key→400 原文文案。"""
    r = client.post(WRITE_PATH, json={"key": "api_key_custom", "value": "to-delete-1"}, headers=auth_headers)
    row_id = r.json()["id"]
    # 带错 id：ST deleteSecret 只删 id 匹配的条目 → 不命中，原值仍在
    resp = client.post(DELETE_PATH, json={"key": "api_key_custom", "id": "wrong-id"}, headers=auth_headers)
    assert resp.status_code == status.HTTP_204_NO_CONTENT and resp.content == b""
    assert client.post(FIND_PATH, json={"key": "api_key_custom"}, headers=auth_headers).json() == {"value": "to-delete-1"}
    # 带对 id：删除 → find 404
    resp = client.post(DELETE_PATH, json={"key": "api_key_custom", "id": row_id}, headers=auth_headers)
    assert resp.status_code == status.HTTP_204_NO_CONTENT and resp.content == b""
    assert client.post(FIND_PATH, json={"key": "api_key_custom"}, headers=auth_headers).status_code == status.HTTP_404_NOT_FOUND
    # 不带 id（ST active 兜底）：无存也 204；重复删不炸
    resp = client.post(DELETE_PATH, json={"key": "api_key_custom"}, headers=auth_headers)
    assert resp.status_code == status.HTTP_204_NO_CONTENT
    # !key → 400 'Key and ID are required'（ST 原文）
    resp = client.post(DELETE_PATH, json={}, headers=auth_headers)
    assert resp.status_code == status.HTTP_400_BAD_REQUEST
    assert resp.text == "Key and ID are required"


def test_rotate_semantics(client, auth_headers):
    """ST secrets.js:606-622：!key||!id→400；有效参数恒 204；单槽位下值不变。"""
    client.post(WRITE_PATH, json={"key": "api_key_custom", "value": "stable-value-1"}, headers=auth_headers)
    resp = client.post(ROTATE_PATH, json={"key": "api_key_custom"}, headers=auth_headers)
    assert resp.status_code == status.HTTP_400_BAD_REQUEST
    assert resp.text == "Key and ID are required"
    resp = client.post(ROTATE_PATH, json={"key": "api_key_custom", "id": "whatever-id"}, headers=auth_headers)
    assert resp.status_code == status.HTTP_204_NO_CONTENT and resp.content == b""
    # 旋转后值原样在（单槽位恒 active）
    assert client.post(FIND_PATH, json={"key": "api_key_custom"}, headers=auth_headers).json() == {"value": "stable-value-1"}


def test_rename_semantics(client, auth_headers):
    """ST secrets.js:624-640：!key||!id||!label→400；id 匹配改 label；错 id 静默不改。"""
    r = client.post(WRITE_PATH, json={"key": "api_key_custom", "value": "rename-target", "label": "old"}, headers=auth_headers)
    row_id = r.json()["id"]

    def _label() -> str:
        state = client.post(READ_PATH, json={}, headers=auth_headers).json()
        return state["api_key_custom"][0]["label"]

    resp = client.post(RENAME_PATH, json={"key": "api_key_custom", "id": row_id}, headers=auth_headers)
    assert resp.status_code == status.HTTP_400_BAD_REQUEST
    assert resp.text == "Key, ID, and label are required"
    resp = client.post(RENAME_PATH, json={"key": "api_key_custom", "id": "wrong-id", "label": "sneaky"}, headers=auth_headers)
    assert resp.status_code == status.HTTP_204_NO_CONTENT
    assert _label() == "old", "错 id 不得改名（ST renameSecret 只改 id 匹配的条目）"
    resp = client.post(RENAME_PATH, json={"key": "api_key_custom", "id": row_id, "label": "new-label"}, headers=auth_headers)
    assert resp.status_code == status.HTTP_204_NO_CONTENT and resp.content == b""
    assert _label() == "new-label"


# ---------------------------------------------------------------------------
# ⑤ 越权失败（反证锚：去掉 user_id 过滤这组必须红）
# ---------------------------------------------------------------------------

def test_cross_user_isolation(client, auth_headers, db_session):
    """用户 B 的 token 对用户 A 的 key：find 404 / view 看不到 / state 是 null /
    delete 删不掉 / rename 改不动。"""
    secret_value = "A-secret-do-not-leak-159"
    r = client.post(WRITE_PATH, json={"key": "api_key_custom", "value": secret_value, "label": "A-label"}, headers=auth_headers)
    a_row_id = r.json()["id"]
    b_headers = _second_user(db_session)

    # B find A 的 key → 404（绝不能回 A 的值）
    resp = client.post(FIND_PATH, json={"key": "api_key_custom"}, headers=b_headers)
    assert resp.status_code == status.HTTP_404_NOT_FOUND, f"越权读被放行：{resp.status_code} {resp.text}"
    assert secret_value not in resp.text

    # B 的 state：A 存的键必须是 null
    state = client.post(READ_PATH, json={}, headers=b_headers).json()
    assert state.get("api_key_custom") is None, "B 的 state 里出现了 A 的密钥"
    assert secret_value not in str(state)

    # B 的 view：不含 A 的任何 key
    view = client.post(VIEW_PATH, json={}, headers=b_headers).json()
    assert "api_key_custom" not in view, f"B 的 view 泄露了 A 的密钥：{view}"
    assert secret_value not in str(view)

    # B delete A 的行（带 A 的真实 id）→ 204 静默，但 A 的值原封不动
    resp = client.post(DELETE_PATH, json={"key": "api_key_custom", "id": a_row_id}, headers=b_headers)
    assert resp.status_code == status.HTTP_204_NO_CONTENT
    still = client.post(FIND_PATH, json={"key": "api_key_custom"}, headers=auth_headers)
    assert still.status_code == status.HTTP_200_OK and still.json() == {"value": secret_value}, "B 删掉了 A 的密钥"

    # B rename A 的行 → 204 静默，label 不动
    resp = client.post(RENAME_PATH, json={"key": "api_key_custom", "id": a_row_id, "label": "B-was-here"}, headers=b_headers)
    assert resp.status_code == status.HTTP_204_NO_CONTENT
    state_a = client.post(READ_PATH, json={}, headers=auth_headers).json()
    assert state_a["api_key_custom"][0]["label"] == "A-label", "B 改掉了 A 的标签"

    # 反向：B 自己写的 key，A 也看不见
    client.post(WRITE_PATH, json={"key": "deepl", "value": "B-deepl-key"}, headers=b_headers)
    view_a = client.post(VIEW_PATH, json={}, headers=auth_headers).json()
    assert "deepl" not in view_a or view_a.get("deepl") != "B-deepl-key", "A 的 view 泄露了 B 的密钥"


# ---------------------------------------------------------------------------
# ⑥ 认证门 / ⑦ SECRET_KEYS 对账
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", [WRITE_PATH, READ_PATH, VIEW_PATH, FIND_PATH, DELETE_PATH, ROTATE_PATH, RENAME_PATH, SETTINGS_PATH])
def test_unauthenticated_is_rejected(client, path):
    """无凭据不得 200（与同族 ST 写面同一道门；QR 批 ⑦ 同款判据）。"""
    resp = client.post(path, json={"key": "api_key_custom", "value": "x"})
    assert resp.status_code != status.HTTP_200_OK, f"{path} 匿名可访问"
    assert resp.status_code in (
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ), f"{path} 期望 401/403，实得 {resp.status_code}"


def test_secret_keys_match_st_1180_declaration_order():
    """⑦ 62 键逐键逐序对账 ST 1.18.0 SECRET_KEYS（防转录漂移）。"""
    from app.api.silly_tavern import _SECRET_STATE_KEYS

    assert _SECRET_STATE_KEYS == ST_SECRET_KEYS_IN_ORDER


def test_write_rejects_unencodable_value_with_400_not_500(client, auth_headers):
    """孤代理字符（json \\ud800 逃逸）的 value 必须落 400 invalid，不得 500 裸抛（自查员第3项缺口）。

    注意必须发原始 JSON 文本：TestClient 的 httpx 会在客户端就拒绝编码含孤代理的
    Python str（ensure_ascii=False 后 .encode 失败），只有 \\ud800 转义序列能活着
    到达服务端的 json.loads——那才是真实攻击面。
    """
    raw_body = '{"key": "api_key_custom", "value": "abc\\ud800"}'
    resp = client.post(
        WRITE_PATH,
        content=raw_body,
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    assert resp.status_code == status.HTTP_400_BAD_REQUEST, (
        f"期望 400，实得 {resp.status_code}（500=UnicodeEncodeError 裸抛回归）"
    )
    assert "Invalid key or value" in resp.text
