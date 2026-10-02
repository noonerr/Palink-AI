/**
 * 插件侧「角色身份」的统一派生规则（2026-10-02，P1 批次）
 *
 * 背景（见 docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md §2.5 / §2.6）：
 * Palink 交给 ST 插件的 `characterId` / `this_chid` 此前是用**角色名**的 charCode 求和算的，
 * 两份拷贝分别在
 *   - `components/views/character/CharacterChat.tsx`（构造 ST context 时）
 *   - `components/st-plugin-ui-host/Live2DPoolPanel.tsx`（Live2D 绑定的 modelId）
 * 名字哈希的直接后果是**同名必然同键**：库里 4 张都叫「露缇雅1.2」的卡共用一份插件状态，
 * 用户删卡重导后仍能看见上一张卡的解锁立绘 —— 这正是本批次要修的现象。
 *
 * 修法：改用 `characters.id`（UUID）派生。UUID 跟着卡走、卡跟着用户走。
 *
 * 三条硬约束（改错任意一条都会变成用户可见事故）：
 *   1. **返回值必须是 number 且 ≠ 0**。ST 插件普遍把它当数字用，
 *      而 0 在 ST 语义里常表示「未选中当前角色」
 *      （`sillyTavernPluginRuntime.ts:767` 里非 number 直接回落 0）。
 *   2. **必须确定性**。禁止 `Math.random` / `Date.now` / 任何随运行环境变化的输入，
 *      否则用户刷新一次页面，插件按 id 存的状态就全部读不回来了。
 *   3. **全仓唯一实现**。新增消费方一律从本文件 import，
 *      不要再复制第三份（前两份已经制造过一次口径漂移：一处返回 number、一处返回 string）。
 */

/** 身份缺失时的兜底值。非 0（见约束 1），且与旧实现一致，避免改动前后取值范围突变。 */
export const PLUGIN_CHARACTER_ID_FALLBACK = 1;

/** 派生结果的取值区间上界（含）。留在 32 位正整数域内，避免越界成浮点精度问题。 */
const ID_CEILING = 0x7ffffffe; // 2^31 - 2

/**
 * 由角色 UUID 派生出给 ST 插件用的数字角色 id。
 *
 * 用 FNV-1a 32 位而非简单的 charCode 求和：求和会让「名字各字符重新排列」的卡撞成同一个值
 * （如「甲乙」与「乙甲」），UUID 场景下同理 —— 虽然 UUID 本身差异度足够高，
 * 但求和的低位熵太差，多卡并存时碰撞概率明显高于哈希。
 *
 * 同域仇恨的处理：为什么不能直接 `h >>> 0`？
 * 因为 `>>> 0` 的取值域是 [0, 2^32-1]，落到 32 位有符号整数域会变成负数，
 * 插件里做 `window.characters[characterId]` 之类的访问时行为不可预期。
 * 这里统一取模压到 [1, 2^31-2]，恒为 Safe Integer 正整数。
 *
 * @param uuid `characters.id`。缺失/空串时返回兜底值 1（与旧行为一致）。
 */
export function pluginCharacterIdFromUuid(uuid: string | null | undefined): number {
  const raw = typeof uuid === 'string' ? uuid.trim() : '';
  if (!raw) return PLUGIN_CHARACTER_ID_FALLBACK;

  // FNV-1a 32 位
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % ID_CEILING) + 1;
}

/**
 * Live2D 等 IndexedDB 消费者把 id 当 **字符串主键** 用（`GalgameUIPluginDB/live2dModels`
 * 的 `modelId`）。这里统一提供转换，避免各处自己 `String()` 时格式漂移。
 */
export function pluginCharacterKeyFromUuid(uuid: string | null | undefined): string {
  return String(pluginCharacterIdFromUuid(uuid));
}
