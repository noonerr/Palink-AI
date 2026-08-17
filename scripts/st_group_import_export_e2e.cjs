#!/usr/bin/env node

/**
 * ST Group Chat & Import/Export 端点真实 round-trip 验证脚本。
 *
 * 使用 Node.js 18+ 内置 fetch（无 Playwright 依赖），按任务描述的 body 形状
 * 逐个调用 Palink 后端暴露的 ST 兼容端点，记录每个请求的 HTTP status code
 * 与返回字段，输出结构化结果。
 *
 * 环境变量：
 *   PALINK_URL           - 测试目标 URL（默认 http://localhost:3000）
 *   PALINK_E2E_USER      - 登录用户名（默认 admin）
 *   PALINK_E2E_PASSWORD  - 登录密码（默认 admin123）
 *   PALINK_TOKEN         - 直接注入的 JWT token（可选，未设置则用账号密码登录）
 *
 * 运行：
 *   node scripts/st_group_import_export_e2e.cjs
 *
 * 退出码：0 表示脚本执行完成（不代表所有断言通过），1 表示脚本本身异常。
 */

const BASE_URL = (process.env.PALINK_URL || 'http://localhost:3000').replace(/\/$/, '');
const USERNAME = process.env.PALINK_E2E_USER || 'admin';
const PASSWORD = process.env.PALINK_E2E_PASSWORD || 'admin123';
const PALINK_TOKEN = process.env.PALINK_TOKEN || '';

// ST 标准群组对象字段（任务要求校验）
const ST_GROUP_REQUIRED_FIELDS = [
  'id',
  'name',
  'members',
  'avatar_url',
  'chat_id',
  'chats',
  'activation_strategy',
  'generation_mode',
  'disabled_members',
  'allow_self_responses',
  'metadata',
];

// ============================================================
// 通用工具
// ============================================================

const errors = [];
const DEBUG = String(process.env.E2E_DEBUG || '').toLowerCase() in { '1': 1, true: 1, yes: 1 };

function recordError(endpoint, status, detail) {
  errors.push({ endpoint, status, detail });
}

function dbg(label, obj) {
  if (!DEBUG) return;
  try {
    const snippet = JSON.stringify(obj).slice(0, 800);
    console.error(`[debug] ${label}: ${snippet}`);
  } catch {
    console.error(`[debug] ${label}: <unserializable>`);
  }
}

/**
 * 调用后端 JSON 接口，自动带上 Authorization 头。
 * 返回 { status, ok, body, text }，永不抛错（异常会被捕获并记录）。
 */
async function callJson(method, path, body, token) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 非 JSON 响应（如 JSONL / PNG），保留原始 text
    }
    return {
      status: response.status,
      ok: response.ok,
      body: parsed,
      text,
      contentType: response.headers.get('content-type') || '',
    };
  } catch (err) {
    return {
      status: -1,
      ok: false,
      body: null,
      text: '',
      contentType: '',
      error: String(err && err.message ? err.message : err),
    };
  }
}

/**
 * 登录获取 access_token。
 */
async function login() {
  if (PALINK_TOKEN) {
    return { token: PALINK_TOKEN, source: 'env' };
  }
  const body = new URLSearchParams();
  body.set('username', USERNAME);
  body.set('password', PASSWORD);
  try {
    const response = await fetch(`${BASE_URL}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (response.ok && json && json.access_token) {
      return { token: json.access_token, source: 'login' };
    }
    return {
      token: null,
      source: 'login-failed',
      status: response.status,
      detail: text.slice(0, 300),
    };
  } catch (err) {
    return {
      token: null,
      source: 'login-error',
      detail: String(err && err.message ? err.message : err),
    };
  }
}

/**
 * 根据任务要求记录非 2xx 响应：
 * - 404 → 标记 missing
 * - 422 → 记录 response body
 * - 其他非 2xx → 记录 status + body 摘要
 */
function classifyFailure(endpoint, result) {
  if (result.status === 404) {
    return { missing: true, status: 404, detail: 'endpoint not found (404)' };
  }
  if (result.status === 422) {
    const detail =
      typeof result.body === 'object' && result.body
        ? JSON.stringify(result.body).slice(0, 500)
        : String(result.text || '').slice(0, 500);
    return { missing: false, status: 422, detail };
  }
  const detail =
    typeof result.body === 'object' && result.body
      ? JSON.stringify(result.body).slice(0, 500)
      : String(result.text || '').slice(0, 500);
  return { missing: false, status: result.status, detail };
}

// ============================================================
// Part 1: Group Chat E2E
// ============================================================

async function runGroupChatE2E(token) {
  const out = {
    listOk: false,
    groupCount: 0,
    createOk: false,
    infoOk: false,
    getOk: false,
    saveOk: false,
    missingFields: [],
  };
  const firstGroupFields = {};

  // 1. 获取群组列表
  const listRes = await callJson('POST', '/api/groups/all', {}, token);
  if (!listRes.ok) {
    const info = classifyFailure('/api/groups/all', listRes);
    recordError('/api/groups/all', info.status, info.detail);
  } else {
    out.listOk = true;
    const groups = Array.isArray(listRes.body) ? listRes.body : [];
    out.groupCount = groups.length;
    if (groups.length > 0) {
      Object.assign(firstGroupFields, groups[0] || {});
    }
  }

  // 2. 如果无群组，创建一个
  let groupId = '';
  if (out.listOk && out.groupCount > 0) {
    // 使用第一个群组的 group_id（Palink 内部 ID）
    const first = firstGroupFields;
    groupId =
      first.group_id ||
      (typeof first.id === 'string' && first.id.startsWith('palink-group-')
        ? first.id.replace(/^palink-group-/, '').replace(/\.png$/, '')
        : first.id) ||
      '';
    dbg('groups/all first item', first);
  } else if (out.listOk && out.groupCount === 0) {
    const createRes = await callJson(
      'POST',
      '/api/groups/create',
      { name: 'E2E Test Group', members: [] },
      token,
    );
    dbg('groups/create status', createRes.status);
    dbg('groups/create body', createRes.body);
    if (!createRes.ok) {
      const info = classifyFailure('/api/groups/create', createRes);
      recordError('/api/groups/create', info.status, info.detail);
    } else {
      out.createOk = true;
      const created = createRes.body || {};
      // 同步收集 create 返回的字段用于 ST 字段校验
      Object.assign(firstGroupFields, created);
      groupId =
        created.group_id ||
        (typeof created.id === 'string' && created.id.startsWith('palink-group-')
          ? created.id.replace(/^palink-group-/, '').replace(/\.png$/, '')
          : created.id) ||
        '';
    }
  }

  if (!groupId) {
    recordError('group-id-resolution', 0, 'unable to resolve group_id for subsequent calls');
    out.missingFields = computeMissingFields(firstGroupFields);
    return out;
  }

  // 3. 获取群聊信息
  const infoRes = await callJson('POST', '/api/chats/group/info', { group_id: groupId }, token);
  dbg('chats/group/info status', infoRes.status);
  dbg('chats/group/info body', infoRes.body);
  if (!infoRes.ok) {
    const info = classifyFailure('/api/chats/group/info', infoRes);
    recordError('/api/chats/group/info', info.status, info.detail);
  } else {
    out.infoOk = true;
    // 用 info 返回的字段做 ST 字段校验（info 返回完整 ST 群组对象）
    Object.assign(firstGroupFields, infoRes.body || {});
  }

  // 4. 获取群聊消息
  const getRes = await callJson('POST', '/api/chats/group/get', { group_id: groupId }, token);
  if (!getRes.ok) {
    const info = classifyFailure('/api/chats/group/get', getRes);
    recordError('/api/chats/group/get', info.status, info.detail);
  } else {
    out.getOk = true;
  }

  // 5. 保存群聊消息
  const saveRes = await callJson(
    'POST',
    '/api/chats/group/save',
    {
      group_id: groupId,
      chat: JSON.stringify([
        { name: 'TestBot', is_user: false, mes: 'hello', send_date: '2024-01-01' },
      ]),
    },
    token,
  );
  if (!saveRes.ok) {
    const info = classifyFailure('/api/chats/group/save', saveRes);
    recordError('/api/chats/group/save', info.status, info.detail);
  } else {
    out.saveOk = true;
  }

  // 6. 校验 ST 标准字段
  out.missingFields = computeMissingFields(firstGroupFields);

  return out;
}

function computeMissingFields(groupObj) {
  const missing = [];
  for (const field of ST_GROUP_REQUIRED_FIELDS) {
    if (!groupObj || !Object.prototype.hasOwnProperty.call(groupObj, field)) {
      missing.push(field);
    }
  }
  return missing;
}

// ============================================================
// Part 2: Import/Export E2E
// ============================================================

async function runImportExportE2E(token) {
  const out = {
    charImportOk: false,
    charExportOk: false,
    chatExportOk: false,
    wiListOk: false,
    wiImportOk: false,
    fieldPreservation: { name: false, description: false, first_mes: false },
  };

  // 1. 角色卡 V2 导入（按任务描述发送 JSON body）
  const importRes = await callJson(
    'POST',
    '/api/characters/import',
    {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'E2E Import Test',
        description: 'test',
        first_mes: 'Hello',
      },
    },
    token,
  );
  if (!importRes.ok) {
    const info = classifyFailure('/api/characters/import', importRes);
    recordError('/api/characters/import', info.status, info.detail);
  } else {
    out.charImportOk = true;
  }

  // 2. 角色卡导出 - 先获取角色列表
  let avatar = '';
  let chatFile = '';
  const listRes = await callJson('POST', '/api/characters/all', {}, token);
  if (listRes.ok) {
    const list = Array.isArray(listRes.body) ? listRes.body : [];
    // 优先找刚导入的角色（名为 E2E Import Test），否则取第一个
    const target =
      list.find((c) => String(c && c.name) === 'E2E Import Test') || list[0] || null;
    if (target) {
      avatar = String(target.avatar || target.id || '');
    }
  } else {
    const info = classifyFailure('/api/characters/all', listRes);
    recordError('/api/characters/all', info.status, info.detail);
  }

  if (avatar) {
    // 角色卡导出
    const exportRes = await callJson(
      'POST',
      '/api/characters/export',
      { avatar_url: avatar, format: 'json' },
      token,
    );
    if (!exportRes.ok) {
      const info = classifyFailure('/api/characters/export', exportRes);
      recordError('/api/characters/export', info.status, info.detail);
    } else {
      out.charExportOk = true;
      // 检查导出是否包含原始字段
      const exported = exportRes.body;
      if (exported && typeof exported === 'object') {
        // chara_card_v2 把字段放在 data 里，也可能直接平铺
        const data =
          exported.data && typeof exported.data === 'object' ? exported.data : exported;
        out.fieldPreservation.name = Boolean(data && data.name);
        out.fieldPreservation.description = Boolean(data && data.description);
        out.fieldPreservation.first_mes = Boolean(data && data.first_mes);
      }
    }

    // 3. 聊天导出 - 需要先找到一个聊天文件名
    const chatsGetRes = await callJson(
      'POST',
      '/api/chats/get',
      { avatar_url: avatar, file_name: null },
      token,
    );
    if (chatsGetRes.ok && Array.isArray(chatsGetRes.body)) {
      // ST 约定首元素是 chat header，后续是聊天文件
      const chatList = chatsGetRes.body;
      for (const item of chatList) {
        if (item && (item.file_name || item.name)) {
          chatFile = String(item.file_name || item.name);
          break;
        }
      }
    }

    if (chatFile) {
      const chatExportRes = await callJson(
        'POST',
        '/api/chats/export',
        { avatar_url: avatar, file_name: chatFile },
        token,
      );
      if (!chatExportRes.ok) {
        const info = classifyFailure('/api/chats/export', chatExportRes);
        recordError('/api/chats/export', info.status, info.detail);
      } else {
        // 检查返回是否为 JSONL 格式（每行一个 JSON 对象）
        const text = chatExportRes.text || '';
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        let jsonlOk = false;
        if (lines.length > 0) {
          jsonlOk = lines.every((line) => {
            try {
              JSON.parse(line);
              return true;
            } catch {
              return false;
            }
          });
        }
        // 也接受 content-type 包含 jsonl
        if (!jsonlOk && /jsonl/i.test(chatExportRes.contentType || '')) {
          jsonlOk = true;
        }
        out.chatExportOk = jsonlOk;
        if (!jsonlOk) {
          recordError(
            '/api/chats/export',
            chatExportRes.status,
            `response is not JSONL (ct=${chatExportRes.contentType}, lines=${lines.length})`,
          );
        }
      }
    } else {
      recordError(
        '/api/chats/export',
        0,
        'no chat file_name available from /api/chats/get; skipping chat export',
      );
    }
  } else {
    recordError(
      '/api/characters/export',
      0,
      'no character avatar available; skipping character & chat export',
    );
  }

  // 4. 世界书 list
  const wiListRes = await callJson('POST', '/api/worldinfo/list', {}, token);
  let wiCount = 0;
  if (!wiListRes.ok) {
    const info = classifyFailure('/api/worldinfo/list', wiListRes);
    recordError('/api/worldinfo/list', info.status, info.detail);
  } else {
    out.wiListOk = true;
    if (wiListRes.body && typeof wiListRes.body === 'object' && !Array.isArray(wiListRes.body)) {
      wiCount = Object.keys(wiListRes.body).length;
    } else if (Array.isArray(wiListRes.body)) {
      wiCount = wiListRes.body.length;
    }
  }

  // 5. 世界书导入（按任务描述发送 JSON body）
  const wiImportRes = await callJson(
    'POST',
    '/api/worldinfo/import',
    {
      name: 'E2E Test WI',
      entries: {
        '0': {
          uid: 0,
          key: ['test'],
          content: 'test content',
          position: 0,
          selective: false,
        },
      },
    },
    token,
  );
  if (!wiImportRes.ok) {
    const info = classifyFailure('/api/worldinfo/import', wiImportRes);
    recordError('/api/worldinfo/import', info.status, info.detail);
  } else {
    out.wiImportOk = true;
  }

  out._worldInfoCount = wiCount;
  return out;
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  const loginResult = await login();
  if (!loginResult.token) {
    const summary = {
      ok: false,
      baseUrl: BASE_URL,
      tokenSource: loginResult.source,
      error: 'login failed',
      detail: loginResult.detail || loginResult.status || 'unknown',
      groupChat: {
        listOk: false,
        groupCount: 0,
        createOk: false,
        infoOk: false,
        getOk: false,
        saveOk: false,
        missingFields: ST_GROUP_REQUIRED_FIELDS.slice(),
      },
      importExport: {
        charImportOk: false,
        charExportOk: false,
        chatExportOk: false,
        wiListOk: false,
        wiImportOk: false,
        fieldPreservation: { name: false, description: false, first_mes: false },
      },
      errors,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  const groupChat = await runGroupChatE2E(loginResult.token);
  const importExport = await runImportExportE2E(loginResult.token);

  // 移除内部调试字段
  const cleanImportExport = {
    charImportOk: importExport.charImportOk,
    charExportOk: importExport.charExportOk,
    chatExportOk: importExport.chatExportOk,
    wiListOk: importExport.wiListOk,
    wiImportOk: importExport.wiImportOk,
    fieldPreservation: importExport.fieldPreservation,
  };

  const summary = {
    groupChat,
    importExport: cleanImportExport,
    errors,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(err && err.message ? err.message : err),
        stack: String(err && err.stack ? err.stack : '').slice(0, 1500),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
