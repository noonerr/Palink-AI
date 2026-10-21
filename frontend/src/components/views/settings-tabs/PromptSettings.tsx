import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { api, invalidateCache } from '@/services/api';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SettingsGroup, SettingsRow, SettingsRowWide } from './settings-ui';
import { AlertCircle, RotateCcw } from 'lucide-react';

/** 数字输入统一夹紧（空值/非法值回落 fallback，不把 NaN 写进 DB）。 */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

interface PromptSettingsProps {
  token: string;
}

const DEFAULT_PROMPTS = {
  chat_zh: `你是一个有帮助的AI助手。

只返回最终答案给用户。不要透露思维链或内部分析过程。永远不要输出类似'最终答案'、'分析'或'思考'这样的标签。

除非用户明确要求，否则使用与用户相同的语言回复。`,

  chat_en: `You are a helpful assistant.

Return only the final answer for the user. Do not reveal chain-of-thought or internal analysis. Never output labels like 'Final Answer', 'Analysis', or 'Thinking'.

Reply in the same language as the user unless explicitly requested otherwise.`,

  character_zh: `Write {name}'s next reply in a fictional chat between {name} and {user}.

【角色卡】
{attributes}

【输出格式约定 - Palink 扩展，非 ST 规范】
- 口语对话：用双引号包裹 "你好！"
- 内心想法：用括号包裹 （我该怎么办...）
- 动作叙述：用普通文本，不加特殊标记
- 禁止使用：<action>、<thinking>等XML标签
- 根据情境调整回复长度：快速交流时简短，情感或戏剧性时刻可以更长

【声音描述要求】
- 在回复的最后，用一行文字描述当前回复适合的声音特点
- 格式：【声音：描述】
- 描述应包括：语气（如温柔/活泼/成熟/稳重等）、情绪（如开心/害羞/兴奋/愤怒等）
- 示例：【声音：温柔开心的女声】或【声音：稳重低沉的男声】`,

  character_en: `Write {name}'s next reply in a fictional chat between {name} and {user}.

[Character Card]
{attributes}

[Output Format Conventions - Palink Extension, not part of ST]
- Spoken Dialogue: Wrap in double quotes "Hello!"
- Inner Thoughts: Wrap in parentheses (What should I do...)
- Actions/Narration: Use plain text without special markers
- Prohibited: XML tags like <action> or <thinking>
- Vary Response Length: Short for quick exchanges, longer for emotional or dramatic moments

[Voice Description Requirement]
- At the end of your response, add a line describing the voice characteristics suitable for this response
- Format: [Voice: description]
- Description should include: tone (gentle/lively/mature/steady, etc.) and emotion (happy/shy/excited/angry, etc.)
- Example: [Voice: gentle and happy female voice] or [Voice: steady deep male voice]`
};

export function PromptSettings({ token }: PromptSettingsProps) {
  const [useCustomPrompts, setUseCustomPrompts] = useState(false);
  const [chatPromptZh, setChatPromptZh] = useState(DEFAULT_PROMPTS.chat_zh);
  const [chatPromptEn, setChatPromptEn] = useState(DEFAULT_PROMPTS.chat_en);
  const [characterPromptZh, setCharacterPromptZh] = useState(DEFAULT_PROMPTS.character_zh);
  const [characterPromptEn, setCharacterPromptEn] = useState(DEFAULT_PROMPTS.character_en);
  const [loading, setLoading] = useState(false);
  // [批次UI1 2026-10-21] 作者注四项 —— 后端读写与装配消费早已存在，此前纯缺控件。
  // 取值语义对齐 ST 1.18（见 schemas/user.py 与报告 §2）：
  //   位置 -1 停用 / 0 场景后 / 1 聊天内@深度 / 2 场景前；深度仅位置=1 时生效。
  const [authorNote, setAuthorNote] = useState('');
  const [authorNotePosition, setAuthorNotePosition] = useState<number>(1);
  const [authorNoteFrequency, setAuthorNoteFrequency] = useState<number>(0);
  const [authorNoteDepth, setAuthorNoteDepth] = useState<number>(4);
  const [savingAuthorNote, setSavingAuthorNote] = useState(false);
  // [批次UI1 2026-10-21] 用户全局破甲（UserSetting.jailbreak；本批才加 UserSettingUpdate 字段）。
  const [jailbreak, setJailbreak] = useState('');
  const [savingJailbreak, setSavingJailbreak] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const settings = await api.get('/api/users/me/settings', { cacheTtlMs: 30_000 });
      setUseCustomPrompts(settings.use_custom_prompts || false);
      setChatPromptZh(settings.custom_chat_prompt_zh || DEFAULT_PROMPTS.chat_zh);
    setChatPromptEn(settings.custom_chat_prompt_en || DEFAULT_PROMPTS.chat_en);
      setCharacterPromptZh(settings.custom_character_prompt_zh || DEFAULT_PROMPTS.character_zh);
      setCharacterPromptEn(settings.custom_character_prompt_en || DEFAULT_PROMPTS.character_en);
      // 作者注：后端 GET 已回四格（未设置时有默认值），这里只做类型防呆。
      setAuthorNote(typeof settings.author_note === 'string' ? settings.author_note : '');
      setAuthorNotePosition(
        typeof settings.author_note_position === 'number' ? settings.author_note_position : 1,
      );
      setAuthorNoteFrequency(
        typeof settings.author_note_frequency === 'number' ? settings.author_note_frequency : 0,
      );
      setAuthorNoteDepth(
        typeof settings.author_note_depth === 'number' ? settings.author_note_depth : 4,
      );
      setJailbreak(typeof settings.jailbreak === 'string' ? settings.jailbreak : '');
    } catch (e) {
      console.error('Failed to fetch prompt settings:', e);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
    await api.put('/api/users/me/settings', {
        use_custom_prompts: useCustomPrompts,
        custom_chat_prompt_zh: chatPromptZh,
        custom_chat_prompt_en: chatPromptEn,
        custom_character_prompt_zh: characterPromptZh,
        custom_character_prompt_en: characterPromptEn
      });
      invalidateCache('/api/users/me/settings');
      toast.success('提示词设置已保存');
    } catch (e) {
      console.error('Failed to save prompt settings:', e);
      toast.error('保存失败');
    } finally {
      setLoading(false);
    }
  };

  // [批次UI1] 作者注四项单独保存：不必先滚到底部点"保存设置"（那是自定义提示词的保存键）。
  const handleSaveAuthorNote = async () => {
    setSavingAuthorNote(true);
    try {
      await api.put('/api/users/me/settings', {
        author_note: authorNote,
        author_note_position: authorNotePosition,
        author_note_frequency: authorNoteFrequency,
        author_note_depth: authorNoteDepth,
      });
      invalidateCache('/api/users/me/settings');
      toast.success('作者注设置已保存');
    } catch (e) {
      console.error('Failed to save author note settings:', e);
      toast.error('保存作者注失败');
    } finally {
      setSavingAuthorNote(false);
    }
  };

  // [批次UI1] 全局破甲：空串是合法的"清空 = 不注入"（后端约定，见 schemas/user.py）。
  const handleSaveJailbreak = async () => {
    setSavingJailbreak(true);
    try {
      await api.put('/api/users/me/settings', { jailbreak });
      invalidateCache('/api/users/me/settings');
      toast.success('破甲设置已保存');
    } catch (e) {
      console.error('Failed to save jailbreak settings:', e);
      toast.error('保存破甲失败');
    } finally {
      setSavingJailbreak(false);
    }
  };

  const handleReset = (type: 'chat_zh' | 'chat_en' | 'character_zh' | 'character_en') => {
    switch (type) {
      case 'chat_zh':
        setChatPromptZh(DEFAULT_PROMPTS.chat_zh);
        break;
      case 'chat_en':
     setChatPromptEn(DEFAULT_PROMPTS.chat_en);
        break;
      case 'character_zh':
        setCharacterPromptZh(DEFAULT_PROMPTS.character_zh);
      break;
      case 'character_en':
        setCharacterPromptEn(DEFAULT_PROMPTS.character_en);
        break;
    }
    toast.success('已恢复默认提示词');
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* [批次UI1] 作者注：后端 GET/PUT 与装配读取早已就绪，此前唯一人工入口是
          /note slash 命令（写逐会话 chat_metadata，改不到全局）。 */}
      <SettingsGroup label="作者注（Author's Note）">
        <SettingsRowWide
          title="作者注内容"
          desc="每一轮按下面的位置/频率注入的额外指令；支持 {{char}} / {{user}} 宏。留空 = 不注入。"
        >
          <Textarea
            data-testid="author-note-text"
            value={authorNote}
            onChange={(e) => setAuthorNote(e.target.value)}
            rows={5}
            className="font-mono text-sm"
            placeholder="例如：保持回复简短，不要替玩家做决定。"
          />
        </SettingsRowWide>
        <SettingsRowWide
          title="插入位置"
          desc="对齐 ST 1.18 extension_prompt_types：-1 停用 / 0 场景后 / 1 聊天内 @ 深度 / 2 场景前。"
        >
          <select
            data-testid="author-note-position"
            value={authorNotePosition}
            onChange={(e) => setAuthorNotePosition(Number(e.target.value))}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value={2}>场景前（Before Main Prompt / Story String）</option>
            <option value={0}>场景后（After Main Prompt / Story String）</option>
            <option value={1}>聊天内 @ 深度（In-chat @ Depth）</option>
            <option value={-1}>停用（NONE，不注入）</option>
          </select>
        </SettingsRowWide>
        <SettingsRowWide
          title="插入频率"
          desc={
            authorNotePosition === -1
              ? '当前位置为「停用」，频率不适用（控件已禁用）。'
              : 'ST 语义：0 = 停用、1 = 每条；本仓装配把 0 与 1 都视为「每条」（0 是历史默认值），要停用请把位置选「停用」。N ≥ 2 = 每 N 条消息注入一次。'
          }
        >
          <Input
            data-testid="author-note-frequency"
            type="number"
            min={0}
            max={9999}
            value={authorNoteFrequency}
            disabled={authorNotePosition === -1}
            onChange={(e) => setAuthorNoteFrequency(clampInt(e.target.value, 0, 9999, 0))}
            className="w-28"
          />
        </SettingsRowWide>
        <SettingsRowWide
          title="插入深度"
          desc={
            authorNotePosition === 1
              ? '仅「聊天内 @ 深度」生效：0 = 最后一条消息处，ST 默认 4。'
              : '仅当位置为「聊天内 @ 深度」时才有意义，当前不可用（控件已禁用，未隐藏）。'
          }
        >
          <Input
            data-testid="author-note-depth"
            type="number"
            min={0}
            max={9999}
            value={authorNoteDepth}
            disabled={authorNotePosition !== 1}
            onChange={(e) => setAuthorNoteDepth(clampInt(e.target.value, 0, 9999, 4))}
            className="w-28"
          />
        </SettingsRowWide>
        <div className="flex items-center justify-end px-4 py-3">
          <Button
            data-testid="author-note-save"
            onClick={handleSaveAuthorNote}
            disabled={savingAuthorNote}
            className="h-8 md:h-9 rounded-md px-3 text-xs"
          >
            {savingAuthorNote ? '保存中...' : '保存作者注'}
          </Button>
        </div>
      </SettingsGroup>

      {/* [批次UI1] 全局破甲：批次JB 已接进装配（卡 > 模板 > 全局），
          但 UserSettingUpdate 此前没有该字段 ⇒ 用户无法写。 */}
      <SettingsGroup label="破甲（Jailbreak）">
        <SettingsRowWide
          title="用户全局破甲"
          desc="优先级：角色卡自带的破甲 > 上下文模板的破甲 > 这里。卡片自带破甲时会覆盖本内容（不是叠加）；留空 = 不注入。"
        >
          <Textarea
            data-testid="jailbreak-text"
            value={jailbreak}
            onChange={(e) => setJailbreak(e.target.value)}
            rows={5}
            className="font-mono text-sm"
            placeholder="留空表示不注入全局破甲。"
          />
        </SettingsRowWide>
        <div className="flex items-center justify-end px-4 py-3">
          <Button
            data-testid="jailbreak-save"
            onClick={handleSaveJailbreak}
            disabled={savingJailbreak}
            className="h-8 md:h-9 rounded-md px-3 text-xs"
          >
            {savingJailbreak ? '保存中...' : '保存破甲'}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup label="自定义提示词">
        <SettingsRow title="启用自定义提示词">
          <Switch
            checked={useCustomPrompts}
            onCheckedChange={setUseCustomPrompts}
          />
        </SettingsRow>

     {useCustomPrompts && (
          <div className="px-4 py-3">
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
              <div className="flex gap-2">
                <AlertCircle className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-blue-500 mb-1">提示词变量说明</p>
                  <ul className="text-muted-foreground space-y-1">
                    <li>• 角色扮演提示词支持变量：<code className="bg-black/20 px-1 rounded">{'{name}'}</code>（角色名）、<code className="bg-black/20 px-1 rounded">{'{user}'}</code>（用户昵称）</li>
                    <li>• 其他变量：<code className="bg-black/20 px-1 rounded">{'{personality}'}</code>、<code className="bg-black/20 px-1 rounded">{'{background}'}</code>、<code className="bg-black/20 px-1 rounded">{'{scenario}'}</code>、<code className="bg-black/20 px-1 rounded">{'{description}'}</code>、<code className="bg-black/20 px-1 rounded">{'{system_prompt}'}</code></li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup label="提示词内容">
        <div className="p-4 space-y-4">
          <Tabs defaultValue="chat" className="w-full">
            <TabsList className="grid w-full grid-cols-2 gap-1 h-auto bg-secondary/60 rounded-xl p-1">
              <TabsTrigger
                value="chat"
                className="rounded-lg py-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm dark:data-[state=active]:bg-background dark:data-[state=active]:text-foreground"
              >
                普通对话
              </TabsTrigger>
              <TabsTrigger
                value="character"
                className="rounded-lg py-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm dark:data-[state=active]:bg-background dark:data-[state=active]:text-foreground"
              >
                角色扮演
              </TabsTrigger>
            </TabsList>

            <TabsContent value="chat" className="space-y-4 mt-4">
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">中文提示词</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleReset('chat_zh')}
                      disabled={!useCustomPrompts}
                    >
                      <RotateCcw className="w-4 h-4 mr-1" />
                      恢复默认
                    </Button>
                  </div>
                  <Textarea
                    value={chatPromptZh}
                    onChange={(e) => setChatPromptZh(e.target.value)}
                    disabled={!useCustomPrompts}
                    rows={8}
                    className="font-mono text-sm"
                    placeholder="输入中文提示词..."
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">英文提示词</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleReset('chat_en')}
                      disabled={!useCustomPrompts}
                    >
                      <RotateCcw className="w-4 h-4 mr-1" />
                      Reset
                    </Button>
                  </div>
                  <Textarea
                    value={chatPromptEn}
                    onChange={(e) => setChatPromptEn(e.target.value)}
                    disabled={!useCustomPrompts}
                    rows={8}
                    className="font-mono text-sm"
                    placeholder="Enter English prompt..."
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="character" className="space-y-4 mt-4">
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">中文提示词</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleReset('character_zh')}
                      disabled={!useCustomPrompts}
                    >
                      <RotateCcw className="w-4 h-4 mr-1" />
                      恢复默认
                    </Button>
                  </div>
                  <Textarea
                    value={characterPromptZh}
                    onChange={(e) => setCharacterPromptZh(e.target.value)}
                    disabled={!useCustomPrompts}
                    rows={12}
                    className="font-mono text-sm"
                    placeholder="输入中文角色扮演提示词..."
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">英文提示词</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleReset('character_en')}
                      disabled={!useCustomPrompts}
                    >
                      <RotateCcw className="w-4 h-4 mr-1" />
                      Reset
                    </Button>
                  </div>
                  <Textarea
                    value={characterPromptEn}
                    onChange={(e) => setCharacterPromptEn(e.target.value)}
                    disabled={!useCustomPrompts}
                    rows={12}
                    className="font-mono text-sm"
                    placeholder="Enter English character prompt..."
                  />
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex items-center justify-end">
            <Button onClick={handleSave} disabled={loading} className="h-8 md:h-9 rounded-md px-3 text-xs">
              {loading ? '保存中...' : '保存设置'}
            </Button>
          </div>
        </div>
      </SettingsGroup>
    </div>
  );
}
