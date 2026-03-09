import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
