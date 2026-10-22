/*
 * [MVU-STATUSBAR-LIVE 2026-10-05] 决定「卡片 iframe 上下文」里该放哪一份变量。
 *
 * ## 为什么要有这个函数
 *
 * 卡片自带的状态栏（regex 脚本替换出的 HTML）里的脚本是这样工作的：
 *
 *   function populateLutiyaData() { const vars = getAllVariables(); ... }
 *   eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => populateLutiyaData());
 *
 * 即：**首帧画一次，之后靠变量更新事件重画**。
 *
 * 而事件能不能来，取决于父窗口有没有把新变量推进 iframe：
 *
 *   父窗口 context 变化 → postContextToFrame（按签名去重）
 *     → iframe 收到 context-update → deepMergeVariablesCompat
 *     → emit VARIABLE_UPDATE_ENDED → 卡片回调执行 → 重画
 *
 * **这条链断在第一步**：此前 context 里放的是该楼**冻结快照**
 * （message.extra.variables 优先），变量更新后它**不变** → 签名不变
 * → 去重逻辑判定「没变化」**不发** → 后面全不执行 → 面板停在首帧。
 *
 * ## 语义依据（为什么改成实时值优先是对的）
 *
 * ST 语义下 MVU 变量存在 **chat 级单一 store**，每一楼的状态栏读的都是
 * **同一份实时值**，所以变量一变所有楼层一起刷新。
 * 按楼冻结的快照是 Palink 为「提示词装配 / 分支回退」加的，属另一条消费链，
 * 不该喂给卡片渲染。**状态栏是「当前状态」显示，不是「那一楼的历史状态」。**
 *
 * 注：卡片按楼取值走的是另一条路（Mvu.getMvuData({type:'message'}) 读 chatMessages
 * 里的 extra.variables），不受本函数影响。
 */

export interface CardVariables {
  stat_data?: Record<string, unknown>;
  // 索引签名：卡片上下文对 variables 的期望类型是
  // `{ stat_data?: Record<string, unknown> } & Record<string, unknown>`，
  // 缺了它 TS 会报「Index signature for type 'string' is missing」。
  // 变量对象本身也确实是任意键的 map（除 stat_data 外还可能有 initialized_lorebooks 等）。
  [key: string]: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasNonEmptyStatData(v: unknown): boolean {
  return (
    isPlainObject(v) &&
    isPlainObject((v as Record<string, unknown>).stat_data) &&
    Object.keys((v as Record<string, unknown>).stat_data as object).length > 0
  );
}

/**
 * 解析卡片上下文用的变量。
 *
 * **两种语义必须分开**（[MVU-AS-OF 2026-10-22 批次MS-2]，老板验收线：切换故事线或看不同
 * 楼层时，显示必须是那条故事线那一楼层的状态）：
 *
 * - `isViewpoint = true`（默认，也是旧行为）：这是**当前视点那一楼**（列表最后一条）。
 *   走「会话级实时值优先」——上游 MVU 的变量本就是 chat 级单一 store，且只有实时值
 *   会让 context 签名变化，进而触发 `VARIABLE_UPDATE_ENDED`、卡片才会重画。
 *   这条优先级由 `card-variables-live-preference.test.ts` 钉着，本批**未改判**。
 * - `isViewpoint = false`：这是**历史楼层**。必须用该楼层自己的明细
 *   （后端 `character_ext._materialize_floor_variables_for_display` 已把被自动清理摘掉的
 *   明细按 `mvu_patch` 重演补回 `extra.variables`）；补不出来的**如实给空 + 标记**，
 *   绝不退回会话级 —— 旧行为正是「回跳第 2 条显示的却是第 100 条的变量数据」的直接来源。
 *
 * @param sessionVariables      会话级实时变量（生成后由事件更新；页面加载时拉取）
 * @param messageExtraVariables 该楼落库时的冻结快照（或被后端重演补回后的版本）
 * @param isViewpoint           该消息是否就是当前视点（列表最后一条）。默认 true 保持旧调用点行为
 */
export function resolveCardVariables(
  sessionVariables: unknown,
  messageExtraVariables: unknown,
  isViewpoint: boolean = true,
): CardVariables {
  if (!isViewpoint) {
    if (hasNonEmptyStatData(messageExtraVariables)) {
      return messageExtraVariables as CardVariables;
    }
    // 该楼取不到 ⇒ 空状态 + 显式标记。返回 null 会让卡片脚本读崩，故给空对象。
    return { stat_data: {}, mvu_state_unavailable: true };
  }

  if (isPlainObject(sessionVariables)) {
    return sessionVariables as CardVariables;
  }
  if (isPlainObject(messageExtraVariables)) {
    return messageExtraVariables as CardVariables;
  }
  return { stat_data: {} };
}
