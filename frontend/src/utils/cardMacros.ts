import { substituteParamsExtended, type MacroEnv } from '@/lib/sillytavern/macros';

interface CardMacroContext {
  userName: string;
  charName: string;
  personality?: string;
  scenario?: string;
  description?: string;
  systemPrompt?: string;
  firstMes?: string;
  mesExample?: string;
  [key: string]: string | undefined;
}

export function substituteCardMacros(text: string, context: CardMacroContext): string {
  const env: MacroEnv = {
    userName: context.userName,
    characterName: context.charName,
    charName: context.charName,
  };

  let result = substituteParamsExtended(text, env);

  const macroMap: Record<string, string | undefined> = {
    personality: context.personality,
    scenario: context.scenario,
    description: context.description,
    system_prompt: context.systemPrompt,
    first_mes: context.firstMes,
    mes_example: context.mesExample,
  };

  result = result.replace(/\{\{([^}:]+?)\}\}/gi, (match, macroName: string) => {
    const key = macroName.toLowerCase();
    if (key in macroMap) {
      const value = macroMap[key];
      return value !== undefined ? value : match;
    }
    return match;
  });

  return result;
}

export type { CardMacroContext };
