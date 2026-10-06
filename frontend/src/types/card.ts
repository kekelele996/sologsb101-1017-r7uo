/**
 * 退火工艺卡（AnnealCard）
 * 工艺技术组按「玻璃种类 + 壁厚区间」立卡：定义升温 / 保温 / 缓冷三段的
 * 升降温速率、目标温度与保温时长。每调整一次另存一个新版本，旧版留档只读，
 * 同一卡系（cardKey）仅一个版本为 active 供排产使用。
 */

/** 玻璃种类（按料性归类，区别于作品的成型工艺 craft） */
export type GlassType = '钠钙玻璃' | '钾铅玻璃' | '硼硅玻璃'

export const GLASS_TYPE_OPTIONS: GlassType[] = ['钠钙玻璃', '钾铅玻璃', '硼硅玻璃']

/** 老库没有玻璃种类记录时的兜底归类 */
export const DEFAULT_GLASS_TYPE: GlassType = '钠钙玻璃'

/** 曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'
export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']

/** 单段工艺参数 */
export interface CardSegment {
  /** 段起始温度（℃） */
  startC: number
  /** 段目标温度（℃）；保温段为退火点 */
  endC: number
  /** 升降温速率（℃/小时）；保温段为 0 */
  rateCPerHour: number
  /** 保温时长（小时）；升降温段为 0 */
  holdHours: number
}

/** 三段工艺参数（顺序固定：升温 → 保温 → 缓冷） */
export type CardCurve = Record<CurveSeg, CardSegment>

/** 版本状态：active 为当前生效版（每卡系唯一）；archived 为留档旧版；draft 为草稿 */
export type CardVersionState = 'active' | 'archived' | 'draft'

/**
 * 退火工艺卡（一个版本一行）。
 * cardKey 为同一卡系（同玻璃种类 + 同壁厚档）跨版本的稳定标识；id 为本版本行主键。
 */
export interface AnnealCard {
  id: string
  /** 卡系稳定标识（同卡系所有版本一致） */
  cardKey: string
  /** 卡系名称，如「钠钙玻璃 · 薄壁」 */
  name: string
  /** 玻璃种类 */
  glassType: GlassType
  /** 壁厚区间下限（mm，含） */
  minMm: number
  /** 壁厚区间上限（mm，含） */
  maxMm: number
  /** 版本号，从 1 起逐次 +1 */
  version: number
  /** 版本状态 */
  state: CardVersionState
  /** 三段工艺参数 */
  curve: CardCurve
  /** 备注 / 调整说明 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建卡系（首版）/ 另存新版本的表单草稿 */
export interface AnnealCardDraft {
  name: string
  glassType: GlassType
  minMm: number
  maxMm: number
  curve: CardCurve
  note: string
}

/** 玻璃种类展示色 */
export const GLASS_TYPE_TAG_TYPE: Record<GlassType, 'primary' | 'warning' | 'success'> = {
  钠钙玻璃: 'primary',
  钾铅玻璃: 'warning',
  硼硅玻璃: 'success',
}
