import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { api } from '@/services/api';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

  character_zh: `你是{name}。始终保持角色扮演。

{dialogue_mode}

{attributes}

用户的名字是"{user}"。

回复格式规则：
- 用双引号包裹口语对话："你好！"
- 用括号包裹内心想法和独白：（我该怎么办...）
- 动作、叙述和描写用普通文本，不加特殊标记。
- 不要使用 XML 标签如 <action> 或 <thinking>。
- 永远不要输出思维链、分析文本或类似"最终答案"的标签。
- 保持沉浸感：像角色那样回应，带有情感、手势和感官细节。
- 根据情境调整回复长度：快速交流时简短，情感或戏剧性时刻可以更长。`,

  character_en: `You are {name}. Stay in character at all times.

{dialogue_mode}
{attributes}

The user's name is "{user}".

Response format rules:
- Wrap spoken dialogue in double quotes: "Hello!"
- Wrap inner thoughts and internal monologue in parentheses: (What should I do...)
- Write actions, narration, and descriptions as plain text without special markers.
- Do NOT use XML tags like <action> or <thinking>.
- Never output chain-of-thought, analysis text, or labels like "Final Answer".
- Stay immersive: respond as the character would, with emotions, gestures, and sensory details.
- Vary response length based on the situation: short for quick exchanges, longer for emotional or dramatic moments.`
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
      const settings = await api.get('/api/users/me/settings');
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl md:text-2xl font-semibold">提示词设置</h3>
          <p className="text-sm text-muted-foreground mt-1">
            自定义AI的系统提示词，控制AI的行为和回复风格
          </p>
        </div>
      </div>

      <GlassCard className="p-4 md:p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <p className="font-medium">启用自定义提示词</p>
            <p className="text-sm text-muted-foreground">
              关闭后将使用默认提示词
            </p>
          </div>
          <Switch
            checked={useCustomPrompts}
            onCheckedChange={setUseCustomPrompts}
        />
        </div>

     {useCustomPrompts && (
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 mb-6">
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
        )}

        <Tabs defaultValue="chat" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="chat">普通对话</TabsTrigger>
            <TabsTrigger value="character">角色扮演</TabsTrigger>
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

        <div className="flex justify-end mt-6">
          <Button onClick={handleSave} disabled={loading}>
            {loading ? '保存中...' : '保存设置'}
          </Button>
        </div>
      </GlassCard>
    </div>
  );
}
