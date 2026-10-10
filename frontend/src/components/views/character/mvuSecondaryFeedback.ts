/*
 * [MVU-SECONDARY-FEEDBACK 2026-10-05] 副 AI 变量更新结果的「用户可见反馈」映射。
 *
 * 为什么单独抽成纯函数：
 * 这段 if/else 原本内联在 CharacterChat 的 handleManualMvuSecondary 里，
 * **漏了 `call_failed` 分支** —— 后端在副模型调用抛异常时返回 reason='call_failed'，
 * 前端没有对应分支，掉进兜底 else 显示「变量更新完成（无变化）」，
 * 用户被误导以为成功了（实际什么都没发生）。抽出来后可用单测钉住，
 * 避免下次后端新增 reason 时又静默掉进兜底。
 *
 * 后端 reason 全集（backend/app/api/character_ext.py，trigger_mvu_secondary）：
 *   secondary_disabled / secondary_model_missing / no_schema
 *   call_failed / no_patches / ok / no_change
 *
 * 设计口径：**未知 reason 一律按失败报出**。
 * 宁可误报成失败，也不要把「没做成」显示成「做完了」—— 那正是本文件要修的 bug 类。
 */

export type MvuSecondaryToastLevel = 'success' | 'error' | 'info';

export interface MvuSecondaryFeedback {
  level: MvuSecondaryToastLevel;
  message: string;
}

export function resolveMvuSecondaryFeedback(
  applied: boolean | undefined,
  reason: string | undefined,
): MvuSecondaryFeedback {
  if (applied) {
    return { level: 'success', message: '变量已更新' };
  }

  switch (reason ?? 'no_patches') {
    case 'secondary_disabled':
    case 'secondary_model_missing':
      return { level: 'error', message: '副 AI 未配置，请在设置中开启并填写模型' };
    case 'no_schema':
      return { level: 'error', message: '角色卡无变量系统（无 tavern_helper schema）' };
    case 'call_failed':
      return { level: 'error', message: '副 AI 调用失败，变量未更新（请检查该模型是否可用）' };
    case 'no_patches':
      return { level: 'info', message: '副 AI 未解析出变量变化' };
    case 'no_change':
      return { level: 'info', message: '变量更新完成（无变化）' };
    default:
      // 未知 reason：显式报错，不谎报成功。
      return { level: 'error', message: `变量更新失败（未知原因：${reason}）` };
  }
}
