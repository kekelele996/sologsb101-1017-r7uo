/**
 * 热工计算工具
 * - 退火工艺卡三段时长换算（升温 / 保温 / 缓冷），全部以卡版本参数为准
 * - 按玻璃种类 + 壁厚挑卡、按卡版本对账
 * - 窑位占用判重（同一窑位时间窗重叠检测）
 * - 温度单位换算（℃ ↔ ℉）
 * - 工艺温度区间与设计尺寸校验
 *
 * 老库（无卡版本）记录回退到 LEGACY_CURVE 口径（即旧版写死参数），
 * 保证升级前已排的排位时长口径不变。
 */
import type { Anneal } from '../types/anneal'
import type { AnnealCard, CardCurve, CardSegment, CurveSeg, GlassType } from '../types/card'
import type { Craft } from '../types/piece'

/** 保留 1 位小数 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 保留 2 位小数 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 摄氏度 → 华氏度 */
export function cToF(c: number): number {
  return round1((c * 9) / 5 + 32)
}

/** 华氏度 → 摄氏度 */
export function fToC(f: number): number {
  return round1(((f - 32) * 5) / 9)
}

/* ------------------------- 老库回退曲线（旧写死口径） ------------------------- */

/** 老库无卡版本时的兜底曲线参数（与升级前写死的钠钙玻璃参数一致） */
export const LEGACY_CURVE: Record<CurveSeg, { startC: number; endC: number; rateCPerHour: number; holdHoursPer5mm: number; hint: string }> = {
  升温: { startC: 20, endC: 560, rateCPerHour: 120, holdHoursPer5mm: 0, hint: '从室温以 120 ℃/h 缓慢升温至 560 ℃ 退火点，避免热冲击。' },
  保温: { startC: 560, endC: 560, rateCPerHour: 0, holdHoursPer5mm: 1.2, hint: '在 560 ℃ 退火点保温，每 5 mm 壁厚保温 1.2 小时以消除内应力。' },
  缓冷: { startC: 560, endC: 60, rateCPerHour: 40, holdHoursPer5mm: 0, hint: '以 40 ℃/h 缓慢降温至 60 ℃ 以下再出窑，快速降温会造成裂纹。' },
}

/**
 * @deprecated 仅用于老库只读记录与升级前口径；新排产一律走工艺卡。
 * 保留导出供旧界面提示文案使用。
 */
export const ANNEAL_CURVE = LEGACY_CURVE

/* ------------------------------ 卡三段时长 ------------------------------ */

/** 单段时长（小时）：升降温按温差/速率；保温取卡面保温时长 */
export function cardSegmentHours(card: Pick<AnnealCard, 'curve'>, seg: CurveSeg): number {
  const segment: CardSegment = card.curve[seg]
  if (seg === '保温') return round1(Math.max(0, segment.holdHours))
  const delta = Math.abs(segment.endC - segment.startC)
  if (segment.rateCPerHour <= 0) return 0
  return round1(delta / segment.rateCPerHour)
}

/** 一张卡的完整退火时长（三段合计，小时） */
export function cardTotalHours(card: Pick<AnnealCard, 'curve'>): number {
  return round1(
    cardSegmentHours(card, '升温') + cardSegmentHours(card, '保温') + cardSegmentHours(card, '缓冷'),
  )
}

/** 三段时长明细（小时） */
export function cardSegmentHoursMap(card: Pick<AnnealCard, 'curve'>): Record<CurveSeg, number> {
  return {
    升温: cardSegmentHours(card, '升温'),
    保温: cardSegmentHours(card, '保温'),
    缓冷: cardSegmentHours(card, '缓冷'),
  }
}

/**
 * 老库口径段时长（按壁厚线性保温），仅供套不上卡的只读遗留排位使用。
 */
export function legacySegmentHours(seg: CurveSeg, wallThicknessMm: number): number {
  const curve = LEGACY_CURVE[seg]
  if (seg === '保温') {
    const thickness = Math.max(1, wallThicknessMm)
    return round1((thickness / 5) * curve.holdHoursPer5mm)
  }
  const delta = Math.abs(curve.endC - curve.startC)
  if (curve.rateCPerHour <= 0) return 0
  return round1(delta / curve.rateCPerHour)
}

/** 老库口径完整时长（按壁厚），仅遗留只读记录 / 无卡提示使用 */
export function legacyTotalHours(wallThicknessMm: number): number {
  return round1(
    legacySegmentHours('升温', wallThicknessMm) +
      legacySegmentHours('保温', wallThicknessMm) +
      legacySegmentHours('缓冷', wallThicknessMm),
  )
}

/* ------------------------------ 挑卡 / 对账 ------------------------------ */

/** 壁厚是否落在卡区间（含端点） */
export function cardCoversThickness(card: Pick<AnnealCard, 'minMm' | 'maxMm'>, thicknessMm: number): boolean {
  return thicknessMm >= card.minMm && thicknessMm <= card.maxMm
}

/** 从若干卡里挑出指定玻璃种类 + 壁厚命中的卡（不区分版本/状态） */
export function matchCards(
  cards: AnnealCard[],
  glassType: GlassType,
  thicknessMm: number,
): AnnealCard[] {
  return cards
    .filter((card) => card.glassType === glassType && cardCoversThickness(card, thicknessMm))
    .sort((a, b) => b.version - a.version)
}

/** 当前生效（active）卡列表 */
export function activeCards(cards: AnnealCard[]): AnnealCard[] {
  return cards.filter((card) => card.state === 'active')
}

/**
 * 为作品挑当前应使用的生效卡：玻璃种类 + 壁厚命中，版本号最高者。
 * 没有命中返回 null（排产时提示缺卡，需工艺技术组建卡）。
 */
export function pickActiveCard(
  cards: AnnealCard[],
  glassType: GlassType,
  thicknessMm: number,
): AnnealCard | null {
  const hit = matchCards(activeCards(cards), glassType, thicknessMm)[0]
  return hit ?? null
}

/** 老库升级：按壁厚在指定玻璃种类的「当时那版（v1，active）」里套卡 */
export function pickLegacyCard(
  cards: AnnealCard[],
  glassType: GlassType,
  thicknessMm: number,
): AnnealCard | null {
  const hit = activeCards(cards)
    .filter((card) => card.glassType === glassType && card.version === 1 && cardCoversThickness(card, thicknessMm))
    .sort((a, b) => b.version - a.version)[0]
  return hit ?? null
}

/**
 * 卡版本对账：排位冻结的卡版本是否仍是该卡系当前生效版本。
 * - 找不到卡系或生效版本：视为对不上（待确认）；
 * - 冻结版本 !== 当前生效版本：对不上（待确认）。
 */
export function isCardVersionCurrent(anneal: Pick<Anneal, 'cardKey' | 'cardVersion' | 'legacy'>, cards: AnnealCard[]): boolean {
  if (anneal.legacy) return false
  const current = activeCards(cards).find((card) => card.cardKey === anneal.cardKey)
  if (current === undefined) return false
  return current.version === anneal.cardVersion
}

/** 把卡系标识拼出来（同玻璃种类 + 壁厚档的稳定 key） */
export function buildCardKey(glassType: GlassType, minMm: number, maxMm: number): string {
  return `${glassType}::${round2(minMm)}-${round2(maxMm)}mm`
}

/** 生成一张空白三段曲线（供建卡表单初始化） */
export function emptyCurve(seed?: Partial<CardCurve>): CardCurve {
  return {
    升温: { startC: 20, endC: 560, rateCPerHour: 120, holdHours: 0, ...seed?.升温 },
    保温: { startC: 560, endC: 560, rateCPerHour: 0, holdHours: 1.2, ...seed?.保温 },
    缓冷: { startC: 560, endC: 60, rateCPerHour: 40, holdHours: 0, ...seed?.缓冷 },
  }
}

/** 把小时数格式化为「x 小时 y 分钟」 */
export function formatHours(hours: number): string {
  const total = Math.max(0, Math.round(hours * 60))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} 分钟`
  if (m === 0) return `${h} 小时`
  return `${h} 小时 ${m} 分钟`
}

/** 解析 ISO / datetime-local 字符串为时间戳；非法返回 NaN */
export function parseAt(value: string): number {
  if (value === '') return Number.NaN
  const stamp = new Date(value).getTime()
  return Number.isNaN(stamp) ? Number.NaN : stamp
}

/** 入窑时间 + 时长（小时）→ 预计出炉时间戳 */
export function addHours(at: string, hours: number): number {
  return parseAt(at) + hours * 3600 * 1000
}

/**
 * 时间窗：[入窑, 出炉]；未出炉时以入窑 + 卡版本三段合计时长作为临时出炉时间。
 * hoursOf 由调用方提供（按该排位冻结的卡版本取时长；遗留记录走老口径）。
 */
export function annealWindow(
  row: Pick<Anneal, 'inAt' | 'outAt'>,
  totalHours: number,
): [number, number] {
  const start = parseAt(row.inAt)
  if (Number.isNaN(start)) return [Number.NaN, Number.NaN]
  const end = parseAt(row.outAt)
  if (!Number.isNaN(end) && end > start) return [start, end]
  return [start, start + totalHours * 3600 * 1000]
}

/** 两个时间窗是否重叠 */
export function windowsOverlap(a: [number, number], b: [number, number]): boolean {
  if (Number.isNaN(a[0]) || Number.isNaN(b[0])) return false
  return a[0] < b[1] && b[0] < a[1]
}

export interface SlotConflict {
  conflict: boolean
  /** 冲突的既有退火记录 */
  withPieceId: string
  withAnnealId: string
  message: string
}

/**
 * 窑位占用判重：同一窑位、时间窗重叠即为冲突。
 * 仅与「占着窑位」的排位比较（待排 / 待确认的不占窑位）。
 * totalHoursOf 由调用方按各排位冻结的卡版本提供时长。
 * excludeAnnealId 用于编辑场景排除自身。
 */
export function checkSlotConflict(
  existing: Anneal[],
  candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'pieceId'>,
  totalHoursOf: (anneal: Pick<Anneal, 'pieceId'> & Partial<Pick<Anneal, 'cardVersionId'>>) => number,
  excludeAnnealId = '',
): SlotConflict {
  const ownWindow = annealWindow(candidate, totalHoursOf(candidate))

  for (const row of existing) {
    if (row.id === excludeAnnealId) continue
    if (row.kilnSlot === '' || row.kilnSlot !== candidate.kilnSlot) continue
    // 待排 / 待确认的排位不占窑位，不参与冲突
    if (row.scheduleState === '待排' || row.scheduleState === '待确认') continue
    const otherWindow = annealWindow(row, totalHoursOf(row))
    if (windowsOverlap(ownWindow, otherWindow)) {
      return {
        conflict: true,
        withPieceId: row.pieceId,
        withAnnealId: row.id,
        message: `窑位 ${candidate.kilnSlot} 在该时间窗内已被占用（${row.inAt} 起的排位），请更换窑位或调整入窑时间。`,
      }
    }
  }
  return { conflict: false, withPieceId: '', withAnnealId: '', message: '' }
}

/** 生成某台退火窑的窑位列表 */
export function kilnSlots(kilnCode: string): string[] {
  const rows = ['A', 'B', 'C']
  const cols = [1, 2, 3]
  const list: string[] = []
  rows.forEach((row) => {
    cols.forEach((col) => {
      list.push(`${kilnCode}-${row}${col}`)
    })
  })
  return list
}

/** 工艺对应的适宜成型温度区间（℃） */
export const CRAFT_TEMP_RANGE: Record<Craft, { min: number; max: number; hint: string }> = {
  吹制: { min: 900, max: 1200, hint: '吹制需在 900–1200 ℃ 的高温区间快速完成，温度过低玻璃会硬化。' },
  铸造: { min: 800, max: 1150, hint: '铸造（窑铸）在 800–1150 ℃ 区间浇注，随后随窑缓冷。' },
  热塑: { min: 700, max: 1000, hint: '热塑（灯工）在 700–1000 ℃ 区间塑形，注意反复回火避免炸裂。' },
}

export interface TempCheck {
  ok: boolean
  message: string
}

/** 工序温度合理性校验：不得超窑炉上限，且应落在工艺区间附近 */
export function checkStepTemp(tempC: number, maxTempC: number, craft: Craft): TempCheck {
  const range = CRAFT_TEMP_RANGE[craft]
  if (tempC > maxTempC) {
    return { ok: false, message: `工序温度 ${tempC} ℃ 超过所选窑炉上限 ${maxTempC} ℃，无法执行。` }
  }
  if (tempC < range.min - 120 || tempC > range.max + 120) {
    return {
      ok: false,
      message: `工序温度 ${tempC} ℃ 明显偏离「${craft}」的适宜区间 ${range.min}–${range.max} ℃。${range.hint}`,
    }
  }
  return { ok: true, message: `工序温度 ${tempC} ℃ 落在「${craft}」的合理区间内。` }
}

/** 设计尺寸比例校验：壁厚与高度需匹配 */
export function checkDesign(heightMm: number, wallThicknessMm: number): TempCheck {
  if (heightMm <= 0) return { ok: false, message: '设计高度必须大于 0。' }
  if (wallThicknessMm <= 0) return { ok: false, message: '壁厚必须大于 0。' }
  if (wallThicknessMm >= heightMm / 8) {
    return { ok: false, message: `壁厚 ${wallThicknessMm} mm 相对设计高度 ${heightMm} mm 偏厚，成型与退火难度都会显著上升。` }
  }
  if (wallThicknessMm < 1.5) {
    return { ok: false, message: `壁厚 ${wallThicknessMm} mm 过薄（建议 ≥ 1.5 mm），退火时极易变形。` }
  }
  return { ok: true, message: `设计尺寸比例合理：高 ${heightMm} mm / 壁厚 ${wallThicknessMm} mm。` }
}

/** 料液剩余量阈值（kg），低于该值提示补料 */
export const LOW_REMAIN_KG = 60

/** 是否低于补料阈值 */
export function isLowRemain(remainKg: number): boolean {
  return remainKg < LOW_REMAIN_KG
}
