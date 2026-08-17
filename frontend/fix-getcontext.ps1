$filePath = "d:\项目\Palink-AI\frontend\src\lib\sillytavern\getContext.ts"
$content = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)
$nl = "`n"
$count = 0

# === INTERFACE CHANGES ===

# 1. chatId type
$old = "  chatId: string | null;$nl"
if ($content.Contains($old)) { $content = $content.Replace($old, "  chatId: string;$nl"); $count++ }

# 2. characters type
$old = "  characters: Record<string, StCharacter>;$nl"
if ($content.Contains($old)) { $content = $content.Replace($old, "  characters: StCharacter[];$nl"); $count++ }

# 3. characterId type
$old = "  characterId: string | null;$nl"
if ($content.Contains($old)) { $content = $content.Replace($old, "  characterId: number;$nl"); $count++ }

# 4. Add thisChid and persona after personaName in interface
$old = "  personaName: string;$nl$nl  // 事件系统字段"
$new = "  personaName: string;$nl  thisChid: number;$nl  persona: {$nl    name: string;$nl    description: string;$nl    persona_description: string;$nl    persona_show_description: boolean;$nl    persona_description_position: number;$nl  };$nl$nl  // 事件系统字段"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 5. Add snake_case aliases after onlineStatus in interface
$old = "  // 在线状态$nl  onlineStatus: string;$nl$nl  // 扩展模板渲染"
$new = "  // 在线状态$nl  onlineStatus: string;$nl$nl  // ST 1.18.0 snake_case 别名与补全字段$nl  main_api: string;$nl  api_server: string;$nl  online_status: string;$nl  ai_name: string;$nl  status_string: string;$nl  streamProcessing: boolean;$nl  isStreaming: boolean;$nl  is_send_press: boolean;$nl  send_textarea: string;$nl  message_count: number;$nl  depth_prompt: string;$nl  extension_prompts: Record<string, any>;$nl  chat_metadata: Record<string, any>;$nl  selected_group_id: string | null;$nl  selected_chat_id: string;$nl  selected_character_id: number;$nl  active_group: string | null;$nl  group_id: string | null;$nl$nl  // 扩展模板渲染"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

Write-Host "Interface replacements: $count"

# === IMPLEMENTATION CHANGES ===

# 6. chatId implementation
$old = "  const chatId = ctx?.chatId ?? null;"
if ($content.Contains($old)) { $content = $content.Replace($old, "  const chatId = ctx?.chatId ?? '';"); $count++ }

# 7. characters array implementation
$old = "  const characters: Record<string, StCharacter> = {};$nl  if (ctx?.characters) {$nl    for (const c of ctx.characters) {$nl      if (c.name) characters[c.name] = c;$nl    }$nl  }"
$new = "  const characters: StCharacter[] = ctx?.characters ?? [];"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 8. characterId implementation
$old = "  // Task 11.8: 使用真实角色 ID，而非 chatId（会话 ID）$nl  const characterId = (ctx as any)?.characterId ?? messageManager.getCurrentCharacterId() ?? null;"
$new = "  // Task 11.8: 使用真实角色 ID，而非 chatId（会话 ID）$nl  // ST 1.18.0: characterId 是角色在 characters 数组中的索引（number），非 string$nl  const rawCharacterId = (ctx as any)?.characterId ?? messageManager.getCurrentCharacterId();$nl  const charactersArray = ctx?.characters ?? [];$nl  const characterId: number = (() => {$nl    if (typeof rawCharacterId === 'number') return rawCharacterId;$nl    if (rawCharacterId == null || rawCharacterId === '') return 0;$nl    const num = Number(rawCharacterId);$nl    if (!Number.isNaN(num)) return num;$nl    // 非数字字符串：查找在 characters 数组中的索引$nl    const idx = charactersArray.findIndex(c =>$nl      (c as any).id === rawCharacterId || c.name === rawCharacterId$nl    );$nl    return idx >= 0 ? idx : 0;$nl  })();"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 9. Add onlineStatus, extensionPrompts, isGenerating variables
$old = "  const personaName = name1;$nl"
$new = "  const personaName = name1;$nl  const onlineStatus = ctx?.onlineStatus ?? 'active';$nl  const extensionPrompts = promptInjection.getPromptsForGeneration?.() ?? {};$nl  const isGenerating = () => generationEngine.state.isGenerating;$nl"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 10. isGenerating shorthand
$old = "    isGenerating: () => {$nl      return generationEngine.state.isGenerating;$nl    },"
$new = "    isGenerating,"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 11. extensionPrompts shorthand
$old = "    extensionPrompts: promptInjection.getPromptsForGeneration?.() ?? {},"
$new = "    extensionPrompts,"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 12. Add thisChid and persona to return statement
$old = "    character,$nl    personaName,$nl$nl    // 事件系统字段"
$new = "    character,$nl    personaName,$nl    thisChid: characterId,$nl    persona: {$nl      name: name1,$nl      description: '',$nl      persona_description: '',$nl      persona_show_description: false,$nl      persona_description_position: 0,$nl    },$nl$nl    // 事件系统字段"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 13. onlineStatus shorthand and snake_case aliases in return
$old = "    // 在线状态$nl    onlineStatus: ctx?.onlineStatus ?? 'active',$nl$nl    // 扩展模板渲染"
$new = "    // 在线状态$nl    onlineStatus,$nl$nl    // ST 1.18.0 snake_case 别名与补全字段$nl    main_api: (ctx as any)?.mainApi || 'openai',$nl    api_server: (ctx as any)?.apiServer || '',$nl    online_status: onlineStatus,$nl    ai_name: name2,$nl    status_string: '',$nl    streamProcessing: false,$nl    isStreaming: isGenerating(),$nl    is_send_press: false,$nl    send_textarea: '',$nl    message_count: chat.length,$nl    depth_prompt: (promptInjection as any).getDepthPrompt?.() ?? '',$nl    extension_prompts: extensionPrompts,$nl    chat_metadata: chatMetadata,$nl    selected_group_id: null,$nl    selected_chat_id: chatId,$nl    selected_character_id: characterId,$nl    active_group: null,$nl    group_id: groupId,$nl$nl    // 扩展模板渲染"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 14. toStMessage: add is_system
$old = "  return {$nl    name: msg.name,$nl    mes: msg.mes,$nl    is_user: msg.is_user,$nl    send_date:"
$new = "  return {$nl    name: msg.name,$nl    mes: msg.mes,$nl    is_user: msg.is_user,$nl    is_system: msg.is_system ?? false,$nl    send_date:"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 15. messageFormatting: delegate to runtime
$old = "    messageFormatting: (content: string, ..._args: any[]) => {$nl      // 简化实现 — 实际格式化由渲染管线处理$nl      return content;$nl    },"
$new = "    messageFormatting: (content: string, ...args: any[]) => {$nl      if (runtime?.messageFormatting) {$nl        return runtime.messageFormatting(content, ...args);$nl      }$nl      return content;$nl    },"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

# 16. substituteParams: pass env
$old = "    substituteParams: (input: string) => {$nl      try {$nl        return substituteParamsExtended(input);$nl      } catch {$nl        return evaluateMacros(input);$nl      }$nl    },"
$new = "    substituteParams: (input: string) => {$nl      try {$nl        const env = {$nl          userName: name1,$nl          characterName: name2,$nl          charName: name2,$nl          modelName: (ctx as any)?.modelName || '',$nl          dynamicMacros: {},$nl        };$nl        return substituteParamsExtended(input, env);$nl      } catch {$nl        return evaluateMacros(input);$nl      }$nl    },"
if ($content.Contains($old)) { $content = $content.Replace($old, $new); $count++ }

Write-Host "Total replacements: $count"

# Write to temp file then copy
$tempPath = "$filePath.tmp"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($tempPath, $content, $utf8NoBom)
Copy-Item -Path $tempPath -Destination $filePath -Force
Remove-Item -Path $tempPath -Force

# Verify
$verifyContent = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)
Write-Host "=== VERIFICATION ==="
Write-Host "Has 'chatId: string;': $($verifyContent.Contains('chatId: string;'))"
Write-Host "Has 'characters: StCharacter[]': $($verifyContent.Contains('characters: StCharacter[]'))"
Write-Host "Has 'characterId: number': $($verifyContent.Contains('characterId: number'))"
Write-Host "Has 'thisChid': $($verifyContent.Contains('thisChid'))"
Write-Host "Has 'persona_description': $($verifyContent.Contains('persona_description'))"
Write-Host "Has 'main_api': $($verifyContent.Contains('main_api'))"
Write-Host "Has 'is_system: msg.is_system': $($verifyContent.Contains('is_system: msg.is_system'))"
Write-Host "Has 'runtime?.messageFormatting': $($verifyContent.Contains('runtime?.messageFormatting'))"
Write-Host "Has 'substituteParamsExtended(input, env)': $($verifyContent.Contains('substituteParamsExtended(input, env)'))"
Write-Host "Has 'const onlineStatus': $($verifyContent.Contains('const onlineStatus'))"
Write-Host "Has 'const extensionPrompts': $($verifyContent.Contains('const extensionPrompts'))"
Write-Host "Has 'const isGenerating': $($verifyContent.Contains('const isGenerating'))"
Write-Host "Has 'isStreaming: isGenerating()': $($verifyContent.Contains('isStreaming: isGenerating()'))"
