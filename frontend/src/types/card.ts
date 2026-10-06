/**
 * 退火工艺卡（AnnealCard）
 * 按「玻璃种类 + 壁厚区间」定义三段（升温 / 保温 / 缓冷）的升降温速度与保温时长。
 * 每调一次存成一个新版本：同卡族只有一张在用（active），旧版留档（archived，只读）。
 * 排位按所选卡版本推算时间窗；卡升版后未进窑的排位按新版重算。
 */

/** 玻璃种类：工艺技术组按种类另立退火工艺卡 */
export type GlassKind = '钠钙玻璃' | '钾铅玻璃'

export const GLASS_KIND_OPTIONS: GlassKind[] = ['钠钙玻璃', '钾铅玻璃']

/** 工艺卡状态：在用 / 留档 */
export type CardStatus = 'active' | 'archived'

/** 退火三段键名 */
export type AnnealPhase = '升温' | '保温' | '缓冷'

export const ANNEAL_PHASE_OPTIONS: AnnealPhase[] = ['升温', '保温', '缓冷']

/** 单段工艺参数 */
export interface CardPhase {
  phase: AnnealPhase
  /** 起始温度（℃） */
  startC: number
  /** 结束温度（℃）；保温段起止温度相同（退火点） */
  endC: number
  /** 升降温速率（℃/小时）；保温段为 0 */
  rateCPerHour: number
  /** 保温段时长（小时）；升温 / 缓冷段为 0 */
  holdHours: number
  hint: string
}

export interface AnnealCard {
  id: string
  /** 卡族标识：同一玻璃种类同一壁厚区间共用一个 familyKey，升版沿用 */
  familyKey: string
  /** 卡名（卡族名，如「钠钙玻璃 · 4–8 mm」） */
  name: string
  /** 玻璃种类 */
  glassKind: GlassKind
  /** 壁厚区间下限（含，mm） */
  wallMinMm: number
  /** 壁厚区间上限（mm）；为 null 表示无上界 */
  wallMaxMm: number | null
  /** 版本号，从 1 起，每次调参 +1 */
  version: number
  /** 在用 / 留档 */
  status: CardStatus
  /** 升版时记录来源版本 id；首版为空串 */
  supersedesId: string
  remark: string
  /** 三段参数 */
  phases: CardPhase[]
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建卡族 / 升版的表单草稿 */
export interface AnnealCardDraft {
  name: string
  glassKind: GlassKind
  wallMinMm: number
  wallMaxMm: number | null
  remark: string
  phases: CardPhase[]
}

/** 排位状态：卡升版重算后撞窑位的排位退回「待排」；对不上卡版本的排位「待确认」 */
export type ScheduleStatus = '已排' | '待排' | '待确认'

export const SCHEDULE_STATUS_OPTIONS: ScheduleStatus[] = ['已排', '待排', '待确认']

/** 待确认原因 */
export type ScheduleReason = 'none' | 'card-missing' | 'legacy-unmatched'

export const SCHEDULE_REASON_TEXT: Record<ScheduleReason, string> = {
  none: '',
  'card-missing': '排位引用的卡版本已不存在，按卡版本对账不通过，请确认后改挂在用卡。',
  'legacy-unmatched': '升级前的旧排位，按作品壁厚套当时卡版未能命中，已留成只读。',
}
