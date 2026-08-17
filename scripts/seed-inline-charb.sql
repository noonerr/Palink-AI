-- 角色B + 会话（用于 D6 切角色验证）
-- 幂等清理
DELETE FROM character_chat_messages WHERE session_id = 'cc-inline-test-0002-0000-0000-000000000001';
DELETE FROM character_chat_session_branches WHERE session_id = 'cc-inline-test-0002-0000-0000-000000000001';
DELETE FROM character_chat_sessions WHERE id = 'cc-inline-test-0002-0000-0000-000000000001';
DELETE FROM characters WHERE id = 'cc-inline-char-b-0000-0000-0000000000b1';

-- 角色B
INSERT INTO characters (id, user_id, name, description, first_mes, created_at, updated_at, talkativeness)
VALUES (
  'cc-inline-char-b-0000-0000-0000000000b1',
  19,
  '测试智能卡角色B',
  'D6 切角色验证用',
  '你好，我是角色B',
  now(),
  now(),
  '0.5'
);

-- 会话B
INSERT INTO character_chat_sessions (id, character_id, user_id, title, dialogue_mode, created_at, updated_at, chat_metadata)
VALUES (
  'cc-inline-test-0002-0000-0000-000000000001',
  'cc-inline-char-b-0000-0000-0000000000b1',
  19,
  '角色B测试会话',
  NULL,
  now(),
  now(),
  NULL
);

-- 分支B
INSERT INTO character_chat_session_branches (id, session_id, parent_branch_id, parent_message_id, branch_name, is_active, created_at, is_frozen, is_favorited, last_message_at)
VALUES (
  'cc-inline-test-0002-0000-0000-000000000002',
  'cc-inline-test-0002-0000-0000-000000000001',
  NULL,
  NULL,
  '分支 1',
  true,
  now(),
  false,
  false,
  now()
);

-- 角色B 的智能卡消息（最后一条 → isLast → 内联渲染）
INSERT INTO character_chat_messages (session_id, branch_id, role, content, name, created_at, is_user, is_system, mesid, swipe_id, swipes, extra, is_hidden, is_locked, content_json)
VALUES (
  'cc-inline-test-0002-0000-0000-000000000001',
  'cc-inline-test-0002-0000-0000-000000000002',
  'assistant',
  $$<style>
  .char-b-panel { font-family: sans-serif; max-width: 420px; border-radius: 14px; background: linear-gradient(135deg, #7c2d12, #f97316); color: #fff; padding: 16px; }
</style>
<div class="char-b-panel">
  <h3>🔥 角色B 状态面板</h3>
  <p>这是角色 B 的最新智能卡消息，应当走内联渲染。</p>
  <p>战力：<strong id="char-b-power">999</strong></p>
</div>$$,
  '测试智能卡角色B',
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