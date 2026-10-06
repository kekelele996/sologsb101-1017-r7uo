/**
 * 退火（Anneal）
 * 窑位分配与曲线段编排；窑位时间窗冲突时禁用提交，出炉即回写作品状态。
 * 排位引用一张退火工艺卡版本（cardVersionId），时间窗按该版参数推算。
 */
import type { ScheduleReason, ScheduleStatus } from './card'

/** 退火曲线段：升温 / 保温 / 缓冷（记录作品当前处于哪一段，仅作展示与历史兼容） */
export type CurveSeg = '升温' | '保温' | '缓冷'

/** 退火状态：待入窑 / 退火中 / 已出炉 */
export type AnnealState = '待入窑' | '退火中' | '已出炉'

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉']

/** 状态推进顺序 */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

export interface Anneal {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 退火窑号 + 窑位，如 AN-01-A1 */
  kilnSlot: string
  /** 曲线段（当前所处段，仅展示；整段时长以卡版本为准） */
  curveSeg: CurveSeg
  /** 引用的退火工艺卡版本 id（AnnealCard.id）；旧数据升级套不上时为空串并置只读 */
  cardVersionId: string
  /** 入窑时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  inAt: string
  /** 出炉时间 ISO 字符串；未出炉为空串 */
  outAt: string
  /** 退火状态 */
  state: AnnealState
  /** 排位状态：已排 / 待排（升版撞窑位退回）/ 待确认（对账不通过） */
  scheduleStatus: ScheduleStatus
  /** 待确认原因；正常排位为 none */
  scheduleReason: ScheduleReason
  /** 旧库升级套不上卡版本的排位留成只读，禁止一切改动 */
  locked: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑退火的表单草稿 */
export interface AnnealDraft {
  pieceId: string
  kilnSlot: string
  curveSeg: CurveSeg
  cardVersionId: string
  inAt: string
  outAt: string
  state: AnnealState
}
