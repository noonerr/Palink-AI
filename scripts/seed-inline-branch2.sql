-- 分支2：从分支1的同名消息处分支（greeting 之后新建），含一条新的智能卡消息作为分支2最后一条
-- 幂等清理
DELETE FROM character_chat_messages WHERE branch_id = 'cc-inline-test-0001-0000-0000-000000000003';
DELETE FROM character_chat_session_branches WHERE id = 'cc-inline-test-0001-0000-0000-000000000003';

-- 分支2（从分支1的 greeting 消息处分支）
INSERT INTO character_chat_session_branches (id, session_id, parent_branch_id, parent_message_id, branch_name, is_active, created_at, is_frozen, is_favorited, last_message_at)
VALUES (
  'cc-inline-test-0001-0000-0000-000000000003',
  'cc-inline-test-0001-0000-0000-000000000001',
  'cc-inline-test-0001-0000-0000-000000000002',
  1947,
  '分支 2',
  false,
  now(),
  false,
  false,
  now()
);

-- 分支2 的智能卡消息（最后一条 → isLast → 内联渲染）
INSERT INTO character_chat_messages (session_id, branch_id, role, content, name, created_at, is_user, is_system, mesid, swipe_id, swipes, extra, is_hidden, is_locked, content_json)
VALUES (
  'cc-inline-test-0001-0000-0000-000000000001',
  'cc-inline-test-0001-0000-0000-000000000003',
  'assistant',
  $$<style>
  .branch2-panel { font-family: sans-serif; max-width: 420px; border-radius: 14px; background: linear-gradient(135deg, #065f46, #10b981); color: #fff; padding: 16px; }
</style>
<div class="branch2-panel">
  <h3>🌿 分支2 状态面板</h3>
  <p>这是分支 2 的最新智能卡消息，应当走内联渲染。</p>
  <p>好感度：<strong id="branch2-val">88</strong></p>
</div>$$,
  '测试智能卡角色',
  now() - interval '1 minute',
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

-- 把分支2 设为 active，分支1 设为非 active
UPDATE character_chat_session_branches SET is_active = false WHERE session_id = 'cc-inline-test-0001-0000-0000-000000000001';
UPDATE character_chat_session_branches SET is_active = true WHERE id = 'cc-inline-test-0001-0000-0000-000000000003';