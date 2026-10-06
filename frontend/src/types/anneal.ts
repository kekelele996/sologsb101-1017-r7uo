/**
 * 退火排位（Anneal）
 * 窑务排产员先挑一张退火工艺卡，入窑/出炉时段按所选卡版本三段合计时长推算。
 * 卡升版后未进窑的排位按新版重算，撞窑位则退回待排；已进窑的冻结在原版本烧完。
 * 排位记录的卡版本与当前生效版本对不上账时，先置「待确认」等人工处理。
 */
import type { CurveSeg } from './card'

export type { CurveSeg }
export { CURVE_SEG_OPTIONS } from './card'

/** 窑内执行状态：待入窑 / 退火中 / 已出炉 */
export type AnnealState = '待入窑' | '退火中' | '已出炉'
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉']

/** 状态推进顺序 */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

/**
 * 排产状态（独立于窑内执行状态）：
 * - 待排：尚未排定（卡升版重算撞窑位后也退回此状态），等待重新排窑；
 * - 已排：已排定窑位与时段，尚未进窑；
 * - 待确认：卡版本对账不一致，先搁着等人工确认；
 * - 已进窑：已进窑（退火中 / 已出炉），冻结在排位时的卡版本，不参与重算。
 */
export type ScheduleState = '待排' | '已排' | '待确认' | '已进窑'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '待确认', '已进窑']

export interface Anneal {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 退火窑号 + 窑位，如 AN-01-A1；待排（退回）时清空 */
  kilnSlot: string
  /** 选用的工艺卡版本行 id（card 表主键）；老库升级套不上卡时为空串 */
  cardVersionId: string
  /** 排位时冻结的卡系稳定标识，用于按版本对账 */
  cardKey: string
  /** 排位时冻结的卡版本号 */
  cardVersion: number
  /** 曲线段（保留：标识当前/记录的三段进度；时长以卡版本为准） */
  curveSeg: CurveSeg
  /** 入窑时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  inAt: string
  /** 出炉时间 ISO 字符串；未出炉为空串 */
  outAt: string
  /** 窑内执行状态 */
  state: AnnealState
  /** 排产状态 */
  scheduleState: ScheduleState
  /** 老库升级遗留：无卡版本且套不上任何卡，只读，仅留档 */
  legacy: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑排位的表单草稿（卡由排产员挑选） */
export interface AnnealDraft {
  pieceId: string
  kilnSlot: string
  cardVersionId: string
  inAt: string
  outAt: string
  state: AnnealState
}
