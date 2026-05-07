import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function parseThinkingContent(content: string): { thinkingContent: string | null; mainContent: string } {
  if (!content) {
    return { thinkingContent: null, mainContent: content };
  }

  const extractTaggedThinking = (source: string, tag: string) => {
    const openTag = `<${tag}>`;
    const closeTag = `</${tag}>`;
    let cursor = 0;
    let cleaned = '';
    const parts: string[] = [];

    while (cursor < source.length) {
      const start = source.indexOf(openTag, cursor);
      if (start === -1) {
        cleaned += source.slice(cursor);
        break;
      }

      cleaned += source.slice(cursor, start);
      const contentStart = start + openTag.length;
      const end = source.indexOf(closeTag, contentStart);

      if (end === -1) {
        const tail = source.slice(contentStart);
        if (tail.trim()) {
          parts.push(tail.trim());
        }
        break;
      }

      const section = source.slice(contentStart, end);
      if (section.trim()) {
        parts.push(section.trim());
      }
      cursor = end + closeTag.length;
    }

    return { parts, cleaned };
  };

  const channelSeparator = '<channel|>';
  const channelIndex = content.indexOf(channelSeparator);

  if (channelIndex !== -1) {
    const thinkingPart = content.slice(0, channelIndex).trim();
    const contentPart = content.slice(channelIndex + channelSeparator.length).trim();
    return {
      thinkingContent: thinkingPart || null,
      mainContent: contentPart,
    };
  }

  const thinkResult = extractTaggedThinking(content, 'think');
  const modelReasoningResult = extractTaggedThinking(thinkResult.cleaned, 'model_reasoning');

  const thinkingParts = [...thinkResult.parts, ...modelReasoningResult.parts];
  let cleanedContent = modelReasoningResult.cleaned.trim();

  if (!thinkingParts.length) {
    const thinkingMatch = content.match(/^([\s\S]*?)\n\n([\s\S]*)$/);
    if (thinkingMatch && thinkingMatch[1].trim().length > 0) {
      const potentialThinking = thinkingMatch[1].trim();
      const potentialContent = thinkingMatch[2].trim();
      if (potentialThinking.length > 20 && potentialContent.length > 0) {
        thinkingParts.push(potentialThinking);
        cleanedContent = potentialContent;
      }
    }
  }

  const joinedThinking = thinkingParts.join('\n\n').trim();
  return {
    thinkingContent: joinedThinking || null,
    mainContent: cleanedContent,
  };
}

export function replacePlaceholders(
  text: string, 
  userNickname: string = "用户", 
  characterName: string = ""
): string {
  if (!text) return text;
  
  let result = text;
  
  result = result.replace(/user\*/gi, userNickname);
  
  result = result.replace(/\{\{user\}\}/g, userNickname);
  result = result.replace(/\{user\}/g, userNickname);
  result = result.replace(/\{\{用户\}\}/g, userNickname);
  result = result.replace(/\{用户\}/g, userNickname);
  result = result.replace(/\{\{你\}\}/g, userNickname);
  result = result.replace(/\{你\}/g, userNickname);
  result = result.replace(/\{\{您\}\}/g, userNickname);
  result = result.replace(/\{您\}/g, userNickname);
  
  if (characterName) {
    result = result.replace(/\{\{char\}\}/g, characterName);
    result = result.replace(/\{char\}/g, characterName);
    result = result.replace(/\{\{角色\}\}/g, characterName);
    result = result.replace(/\{角色\}/g, characterName);
    result = result.replace(/\{\{character\}\}/g, characterName);
    result = result.replace(/\{character\}/g, characterName);
  }
  
  return result;
}
