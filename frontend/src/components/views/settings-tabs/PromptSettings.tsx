import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { api, invalidateCache } from '@/services/api';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { AlertCircle, RotateCcw } from 'lucide-react';

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
                    <li>• 角色状态表格：在角色聊天菜单中开启"显示角色状态"后，系统会自动在提示词末尾追加角色状态表格指令，无需手动添加</li>
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
