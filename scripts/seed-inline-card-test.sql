-- 智能卡内联渲染测试数据（card_test_user, user_id=19, 角色 f03aa553）
-- 幂等清理
DELETE FROM character_chat_messages WHERE session_id = 'cc-inline-test-0001-0000-0000-000000000001';
DELETE FROM character_chat_session_branches WHERE session_id = 'cc-inline-test-0001-0000-0000-000000000001';
DELETE FROM character_chat_sessions WHERE id = 'cc-inline-test-0001-0000-0000-000000000001';

-- 会话
INSERT INTO character_chat_sessions (id, character_id, user_id, title, dialogue_mode, created_at, updated_at, chat_metadata)
VALUES (
  'cc-inline-test-0001-0000-0000-000000000001',
  'f03aa553-3c28-46b6-a693-fc44aed47544',
  19,
  '智能卡内联渲染测试',
  NULL,
  now(),
  now(),
  NULL
);

-- 分支
INSERT INTO character_chat_session_branches (id, session_id, parent_branch_id, parent_message_id, branch_name, is_active, created_at, is_frozen, is_favorited, last_message_at)
VALUES (
  'cc-inline-test-0001-0000-0000-000000000002',
  'cc-inline-test-0001-0000-0000-000000000001',
  NULL,
  NULL,
  '分支 1',
  true,
  now(),
  false,
  false,
  now()
);

-- 消息 1：greeting（智能卡 HTML）
INSERT INTO character_chat_messages (session_id, branch_id, role, content, name, created_at, is_user, is_system, mesid, swipe_id, swipes, extra, is_hidden, is_locked, content_json)
VALUES (
  'cc-inline-test-0001-0000-0000-000000000001',
  'cc-inline-test-0001-0000-0000-000000000002',
  'assistant',
  $$<style>
  .test-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 16px; border-radius: 12px; font-family: sans-serif; }
  .test-card button { background: #fff; color: #333; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: bold; }
</style>
<div class="test-card">
  <h3>智能卡欢迎面板</h3>
  <p id="card-text-greet">欢迎来到内联渲染测试（greeting）。</p>
</div>
<p>我是智能卡角色，会在一段对话后展示完整面板。</p>$$,
  '测试智能卡角色',
  now() - interval '10 minutes',
  false,
  false,
  NULL,
  0,
  NULL,
  NULL,
  false,
  false,
  NULL
);

-- 消息 2：user
INSERT INTO character_chat_messages (session_id, branch_id, role, content, name, created_at, is_user, is_system, mesid, swipe_id, swipes, extra, is_hidden, is_locked, content_json)
VALUES (
  'cc-inline-test-0001-0000-0000-000000000001',
  'cc-inline-test-0001-0000-0000-000000000002',
  'user',
  '展示你的完整状态面板',
  'card_test_user',
  now() - interval '5 minutes',
  true,
  false,
  NULL,
  0,
  NULL,
  NULL,
  false,
  false,
  NULL
);

-- 消息 3：assistant（智能卡 HTML，最后一条 → isLast → 内联渲染）
INSERT INTO character_chat_messages (session_id, branch_id, role, content, name, created_at, is_user, is_system, mesid, swipe_id, swipes, extra, is_hidden, is_locked, content_json)
VALUES (
  'cc-inline-test-0001-0000-0000-000000000001',
  'cc-inline-test-0001-0000-0000-000000000002',
  'assistant',
  $$<style>
  .status-panel { font-family: sans-serif; max-width: 420px; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.12); }
  .status-header { background: linear-gradient(135deg, #1e3a8a, #3b82f6); color: #fff; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; }
  .status-body { background: #fff; color: #1f2937; padding: 16px; }
  .status-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed #e5e7eb; }
  .status-btn { background: #2563eb; color: #fff; border: none; border-radius: 8px; padding: 8px 14px; margin-top: 12px; cursor: pointer; font-weight: bold; }
  .status-btn:hover { background: #1d4ed8; }
</style>
<div class="status-panel">
  <div class="status-header">
    <span>✨ 测试智能卡角色 状态面板</span>
    <span>LV.5</span>
  </div>
  <div class="status-body">
    <div class="status-row"><span>❤️ 好感度</span><span id="stat-affection">42</span></div>
    <div class="status-row"><span>⚡ 体力</span><span id="stat-energy">87</span></div>
    <div class="status-row"><span>💬 当前状态</span><span>对话中</span></div>
    <button class="status-btn" id="btn-hello">❤️ 好感 +1</button>
  </div>
</div>
<p>这是你的完整状态面板，按钮可以交互。</p>
<script>
(function () {
  var btn = document.getElementById('btn-hello');
  var el = document.getElementById('stat-affection');
  if (btn && el) {
    btn.addEventListener('click', function () {
      el.innerText = String(Number(el.innerText) + 1);
    });
  }
})();
</script>
$$,
  '测试智能卡角色',
  now(),
  false,
  false,
  NULL,
  0,
  NULL,
  NULL,
  false,
  false,
  NULL
);
