/**
 * 世界书类型定义
 * 基于 SillyTavern 1.18.0 world-info.js
 */

// ============================================================
// 世界书条目
// ============================================================

/**
 * 逻辑门类型
 */
export enum WorldInfoLogic {
  AND_ANY = 0,    // 任一关键词匹配
  NOT_ALL = 1,    // 非全部匹配
  NOT_ANY = 2,    // 非任一匹配
  AND_ALL = 3,    // 全部匹配
}

/**
 * 插入位置
 */
export enum WorldInfoPosition {
  BEFORE_CHAR = 0,   // 角色定义前
  AFTER_CHAR = 1,    // 角色定义后
  BEFORE_AN = 2,     // 作者注释前
  AFTER_AN = 3,      // 作者注释后
  AT_DEPTH = 4,      // 指定深度
}

/**
 * 扫描状态
 */
export enum ScanState {
  NONE = 0,
  INITIAL = 1,
  RECURSION = 2,
  MIN_ACTIVATIONS = 3,
}

/**
 * 世界书条目
 */
export interface WorldBookEntry {
  id: string;
  uid: number;
  
  // 关键词
  key: string[];           // 主关键词
  keysecondary: string[];  // 副关键词
  
  // 内容
  content: string;         // 注入内容
  comment: string;         // 备注
  
  // 逻辑
  selectiveLogic: WorldInfoLogic;
  selective: boolean;      // 是否启用选择性匹配
  constant: boolean;       // 是否常驻注入
  vectorized: boolean;     // 是否使用向量匹配
  
  // 位置
  position: WorldInfoPosition;
  depth: number;           // 注入深度
  order: number;           // 优先级
  
  // 扫描
  scanDepth: number | null;      // 扫描深度
  caseSensitive: boolean;        // 大小写敏感
  matchWholeWords: boolean;      // 全词匹配
  useGroupScoring: boolean;      // 使用组评分
  
  // 匹配范围
  matchPersonaDescription: boolean;
  matchCharacterDescription: boolean;
  matchCharacterPersonality: boolean;
  matchCharacterDepthPrompt: boolean;
  matchScenario: boolean;
  matchCreatorNotes: boolean;
  
  // 时间效果
  sticky: number;          // 粘性（持续激活的消息数）
  cooldown: number;        // 冷却（激活后需要间隔的消息数）
  delay: number;           // 延迟（需要多少条消息后才能激活）
  
  // 概率
  probability: number;     // 激活概率 (0-100)
  
  // 组
  group: string;           // 所属组
  groupOverride: boolean;  // 组覆盖
  groupWeight: number;     // 组权重
  
  // 装饰器
  decorators: string[];    // @@activate, @@dont_activate 等
  characterFilter?: string[];  // 角色过滤（names/tags），为空时不限制
  
  // 元数据
  addMemo: boolean;
  enabled: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  
  // 扩展
  extensions: Record<string, any>;
}

/**
 * 世界书
 */
export interface WorldBook {
  id: string;
  name: string;
  description: string;
  entries: WorldBookEntry[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// 扫描配置
// ============================================================

/**
 * 扫描配置
 */
export interface ScanConfig {
  scanDepth: number;           // 扫描深度
  caseSensitive: boolean;      // 大小写敏感
  matchWholeWords: boolean;    // 全词匹配
  useGroupScoring: boolean;    // 使用组评分
  maxRecursionDepth: number;   // 最大递归深度
  minActivations: number;      // 最小激活数
  budgetCap: number;           // 预算上限 (token)
}

/**
 * 扫描上下文
 */
export interface ScanContext {
  messages: string[];           // 最近的消息
  personaDescription: string;   // 用户人设描述
  characterDescription: string; // 角色描述
  characterPersonality: string; // 角色性格
  characterDepthPrompt: string; // 角色深度提示
  scenario: string;             // 场景
  creatorNotes: string;         // 创作者注释
  characterName?: string;       // 当前角色名称，用于 characterFilter 过滤
  characterTags?: string[];     // 当前角色 tags，用于 characterFilter 过滤
}

/**
 * 扫描结果
 */
export interface ScanResult {
  entries: WorldBookEntry[];    // 激活的条目
  totalTokens: number;         // 总token数
  matchedKeywords: Map<string, string[]>; // 匹配的关键词
}

// ============================================================
// 时间效果
// ============================================================

/**
 * 时间效果状态
 */
export interface TimedEffectState {
  entryId: string;
  stickyRemaining: number;     // 剩余粘性消息数
  cooldownRemaining: number;   // 剩余冷却消息数
  delayRemaining: number;      // 剩余延迟消息数
  lastActivated: number;       // 最后激活的消息索引
}

// ============================================================
// 预算管理
// ============================================================

/**
 * 预算配置
 */
export interface BudgetConfig {
  maxTokens: number;           // 最大token数
  strategy: 'evenly' | 'character_first' | 'global_first';
}

/**
 * 预算结果
 */
export interface BudgetResult {
  entries: WorldBookEntry[];   // 预算内的条目
  totalTokens: number;         // 总token数
  truncated: boolean;          // 是否被截断
}

// ============================================================
// 世界书蓝图（Blueprints, ST 1.18.0）
// ============================================================

/**
 * 世界书蓝图 —— 批量定义一组关联条目和触发逻辑
 */
export interface Blueprint {
  id: number;
  name: string;
  description: string;
  entries_json: string;   // JSON 字符串：条目定义数组
  trigger_logic: string;  // JSON 字符串：触发逻辑（auto_activate / recursion_depth）
  created_at: string;
  updated_at: string;
}

/**
 * 蓝图应用结果
 */
export interface BlueprintApplyResult {
  status: string;
  worldbook_id: string;
  blueprint_id: number;
  created_count: number;
  skipped_count: number;
  created_entry_ids: string[];
  skipped_comments: string[];
}
