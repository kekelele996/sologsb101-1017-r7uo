/**
 * 退火工艺卡领域逻辑（纯函数，不触碰数据库）
 * - 默认工艺卡（升老库时作为「当时那版」）
 * - 按玻璃种类 + 壁厚匹配在用卡 / 指定版本
 * - 三段时长与整段退火时长换算（以卡版本为唯一依据）
 * - 时间窗推算、窑位占用判重（待排 / 待确认的排位不占窑位）
 * - 壁厚区间重叠校验、旧库玻璃种类推断
 */
import type { Anneal } from '../types/anneal'
import type { AnnealCard, AnnealCardDraft, AnnealPhase, CardPhase, GlassKind } from '../types/card'
import type { GlassBatch } from '../types/batch'
import { GLASS_KIND_OPTIONS } from '../types/card'
import { round1, parseAt } from './thermal'

/** 保留 1 位小数的小时换算与时间格式仍复用 thermal 工具 */
export { formatHours, parseAt } from './thermal'

/** 三段固定顺序 */
export const PHASE_ORDER: AnnealPhase[] = ['升温', '保温', '缓冷']

/** 壁厚无上界时的兜底值 */
export const WALL_MAX_OPEN = 9999

/* ------------------------------ 默认工艺卡 ------------------------------ */

/**
 * 默认退火工艺卡：工艺技术组建卡之前，库里唯一的一套参数。
 * 老库升级时把它们作为「当时那版」写入，旧排位按作品壁厚去套。
 * 钠钙玻璃分薄 / 常规 / 厚三档；钾铅玻璃只建一档（常规档），
 * 刻意让历史钾铅厚壁作品套不上，以演示「留成只读」。
 */
export interface DefaultCardSpec {
  id: string
  glassKind: GlassKind
  wallMinMm: number
  wallMaxMm: number | null
  version: number
  remark: string
  phases: Omit<CardPhase, 'phase'>[]
}

function phase(partial: Omit<CardPhase, 'phase'>, name: AnnealPhase): CardPhase {
  return { phase: name, ...partial }
}

/** 默认卡固定 id，升级与全新播种共用，保证旧排位永远能「按当时那版」对账 */
export const DEFAULT_CARD_IDS = {
  sodaThin: 'card-soda-thin-v1',
  sodaRegular: 'card-soda-regular-v1',
  sodaThick: 'card-soda-thick-v1',
  leadRegular: 'card-lead-regular-v1',
} as const

export const DEFAULT_CARD_SPECS: DefaultCardSpec[] = [
  {
    id: DEFAULT_CARD_IDS.sodaThin,
    glassKind: '钠钙玻璃',
    wallMinMm: 0,
    wallMaxMm: 4,
    version: 1,
    remark: '钠钙薄壁件：升温可略快，保温从短。',
    phases: [
      { startC: 20, endC: 560, rateCPerHour: 150, holdHours: 0, hint: '薄壁件以 150 ℃/h 升温至 560 ℃ 退火点。' },
      { startC: 560, endC: 560, rateCPerHour: 0, holdHours: 0.8, hint: '薄壁件 560 ℃ 保温 0.8 小时消除应力。' },
      { startC: 560, endC: 60, rateCPerHour: 50, holdHours: 0, hint: '薄壁件以 50 ℃/h 缓冷至 60 ℃ 以下。' },
    ],
  },
  {
    id: DEFAULT_CARD_IDS.sodaRegular,
    glassKind: '钠钙玻璃',
    wallMinMm: 4,
    wallMaxMm: 8,
    version: 1,
    remark: '钠钙常规壁厚：沿用工作室历史默认曲线。',
    phases: [
      { startC: 20, endC: 560, rateCPerHour: 120, holdHours: 0, hint: '以 120 ℃/h 缓慢升温至 560 ℃ 退火点，避免热冲击。' },
      { startC: 560, endC: 560, rateCPerHour: 0, holdHours: 1.2, hint: '560 ℃ 保温 1.2 小时（按壁厚线性折算）以消除内应力。' },
      { startC: 560, endC: 60, rateCPerHour: 40, holdHours: 0, hint: '以 40 ℃/h 缓慢降温至 60 ℃ 以下再出窑。' },
    ],
  },
  {
    id: DEFAULT_CARD_IDS.sodaThick,
    glassKind: '钠钙玻璃',
    wallMinMm: 8,
    wallMaxMm: null,
    version: 1,
    remark: '钠钙厚壁件：放慢升降温，加长保温。',
    phases: [
      { startC: 20, endC: 560, rateCPerHour: 90, holdHours: 0, hint: '厚壁件以 90 ℃/h 缓慢升温，减小内外温差。' },
      { startC: 560, endC: 560, rateCPerHour: 0, holdHours: 1.6, hint: '厚壁件 560 ℃ 保温 1.6 小时，应力释放更充分。' },
      { startC: 560, endC: 60, rateCPerHour: 30, holdHours: 0, hint: '厚壁件以 30 ℃/h 极慢缓冷，防止炸裂。' },
    ],
  },
  {
    id: DEFAULT_CARD_IDS.leadRegular,
    glassKind: '钾铅玻璃',
    wallMinMm: 0,
    wallMaxMm: 5,
    version: 1,
    remark: '钾铅玻璃退火点偏低、保温从短；厚壁档待工艺技术组补卡。',
    phases: [
      { startC: 20, endC: 480, rateCPerHour: 100, holdHours: 0, hint: '钾铅玻璃以 100 ℃/h 升温至 480 ℃ 退火点。' },
      { startC: 480, endC: 480, rateCPerHour: 0, holdHours: 0.9, hint: '480 ℃ 保温 0.9 小时。' },
      { startC: 480, endC: 60, rateCPerHour: 35, holdHours: 0, hint: '以 35 ℃/h 缓冷至 60 ℃ 以下。' },
    ],
  },
]

/** 把默认卡规格展开成完整三段参数 */
function buildPhases(specPhases: Omit<CardPhase, 'phase'>[]): CardPhase[] {
  return PHASE_ORDER.map((name, index) => phase(specPhases[index], name))
}

/** 生成某族默认卡（固定 id / familyKey / version=1） */
export function buildDefaultCard(spec: DefaultCardSpec, stamp: string, rowRevision: number): AnnealCard {
  return {
    id: spec.id,
    familyKey: spec.id.replace(/-v\d+$/, ''),
    name: cardFamilyName(spec.glassKind, spec.wallMinMm, spec.wallMaxMm),
    glassKind: spec.glassKind,
    wallMinMm: spec.wallMinMm,
    wallMaxMm: spec.wallMaxMm,
    version: spec.version,
    status: 'active',
    supersedesId: '',
    remark: spec.remark,
    phases: buildPhases(spec.phases),
    createdAt: stamp,
    updatedAt: stamp,
    revision: rowRevision,
  }
}

/** 全部默认卡 */
export function buildDefaultCards(stamp: string, rowRevision: number): AnnealCard[] {
  return DEFAULT_CARD_SPECS.map((spec) => buildDefaultCard(spec, stamp, rowRevision))
}

/* ------------------------------ 卡族与匹配 ------------------------------ */

/** 壁厚区间文本 */
export function wallBandText(min: number, max: number | null): string {
  return max === null ? `≥ ${min} mm` : `${min}–${max} mm`
}

/** 卡族名：玻璃种类 · 壁厚区间 */
export function cardFamilyName(glassKind: GlassKind, min: number, max: number | null): string {
  return `${glassKind} · ${wallBandText(min, max)}`
}

/** 壁厚是否落在卡的区间内（下限含，上限也含） */
export function cardCoversWall(card: Pick<AnnealCard, 'wallMinMm' | 'wallMaxMm'>, wallMm: number): boolean {
  if (wallMm < card.wallMinMm) return false
  if (card.wallMaxMm !== null && wallMm > card.wallMaxMm) return false
  return true
}

/**
 * 按玻璃种类 + 壁厚匹配在用卡。
 * 命中多张时取区间最窄（最贴合）的一张；都不命中返回 null。
 */
export function matchActiveCard(cards: AnnealCard[], glassKind: GlassKind, wallMm: number): AnnealCard | null {
  const hits = cards.filter((card) => card.status === 'active' && card.glassKind === glassKind && cardCoversWall(card, wallMm))
  if (hits.length === 0) return null
  return hits.sort((a, b) => {
    const widthA = (a.wallMaxMm ?? WALL_MAX_OPEN) - a.wallMinMm
    const widthB = (b.wallMaxMm ?? WALL_MAX_OPEN) - b.wallMinMm
    return widthA - widthB
  })[0]
}

/** 按 id 找指定版本（含留档旧版，供已进窑排位按当初那版对账） */
export function findCardVersion(cards: AnnealCard[], cardVersionId: string): AnnealCard | null {
  return cards.find((card) => card.id === cardVersionId) ?? null
}

/** 取某卡族的全部版本，版本号倒序 */
export function familyVersions(cards: AnnealCard[], familyKey: string): AnnealCard[] {
  return cards.filter((card) => card.familyKey === familyKey).sort((a, b) => b.version - a.version)
}

/** 某族在用版本（无则 null） */
export function activeOfFamily(cards: AnnealCard[], familyKey: string): AnnealCard | null {
  return cards.find((card) => card.familyKey === familyKey && card.status === 'active') ?? null
}

/* ------------------------------ 区间校验 ------------------------------ */

/** 同玻璃种类的壁厚区间是否重叠（排除自身族） */
export function bandOverlaps(
  cards: AnnealCard[],
  glassKind: GlassKind,
  min: number,
  max: number | null,
  excludeFamilyKey = '',
): AnnealCard | null {
  const upper = max ?? WALL_MAX_OPEN
  const hit = cards.find((card) => {
    if (card.status !== 'active' || card.glassKind !== glassKind) return false
    if (card.familyKey === excludeFamilyKey) return false
    const otherMax = card.wallMaxMm ?? WALL_MAX_OPEN
    return min <= otherMax && card.wallMinMm <= upper
  })
  return hit ?? null
}

/* ------------------------------ 时长换算 ------------------------------ */

export function phaseOf(card: AnnealCard, name: AnnealPhase): CardPhase {
  const found = card.phases.find((item) => item.phase === name)
  if (found !== undefined) return found
  // 兜底：数据异常时退化为空段，避免页面崩
  return { phase: name, startC: 0, endC: 0, rateCPerHour: 0, holdHours: 0, hint: '' }
}

/** 单段时长（小时）：升降温按温差/速率，保温时长按壁厚线性折算（基准为 5mm） */
export function cardPhaseHours(card: AnnealCard, name: AnnealPhase, wallThicknessMm: number): number {
  const seg = phaseOf(card, name)
  if (name === '保温') {
    const thickness = Math.max(1, wallThicknessMm)
    return round1((thickness / 5) * seg.holdHours)
  }
  const delta = Math.abs(seg.endC - seg.startC)
  if (seg.rateCPerHour <= 0) return 0
  return round1(delta / seg.rateCPerHour)
}

/** 三段合计的整段退火时长（小时） */
export function cardTotalHours(card: AnnealCard, wallThicknessMm: number): number {
  return round1(
    cardPhaseHours(card, '升温', wallThicknessMm) +
      cardPhaseHours(card, '保温', wallThicknessMm) +
      cardPhaseHours(card, '缓冷', wallThicknessMm),
  )
}

/* ------------------------------ 时间窗与判重 ------------------------------ */

/** 排位解析所需上下文：壁厚与卡版本都通过回调提供 */
export interface AnnealContext {
  wallThicknessOf: (pieceId: string) => number
  cardOf: (cardVersionId: string) => AnnealCard | null
}

export interface AnnealWindowRow {
  inAt: string
  outAt: string
  cardVersionId: string
  pieceId: string
}

/**
 * 时间窗 [入窑, 出炉]：
 * 已出炉用实际 outAt；未出炉按所引卡版本的整段时长推算预计出炉时间。
 * 卡版本缺失（对账不通过）时返回 NaN 窗，交由对账逻辑搁置，不参与判重。
 */
export function cardAnnealWindow(row: AnnealWindowRow, ctx: AnnealContext): [number, number] {
  const start = parseAt(row.inAt)
  if (Number.isNaN(start)) return [Number.NaN, Number.NaN]
  const end = parseAt(row.outAt)
  if (!Number.isNaN(end) && end > start) return [start, end]
  const card = ctx.cardOf(row.cardVersionId)
  if (card === null) return [Number.NaN, Number.NaN]
  const hours = cardTotalHours(card, ctx.wallThicknessOf(row.pieceId))
  return [start, start + hours * 3600 * 1000]
}

/** 两个时间窗是否重叠 */
export function windowsOverlap(a: [number, number], b: [number, number]): boolean {
  if (Number.isNaN(a[0]) || Number.isNaN(b[0])) return false
  return a[0] < b[1] && b[0] < a[1]
}

export interface SlotConflict {
  conflict: boolean
  withPieceId: string
  withAnnealId: string
  message: string
}

/**
 * 窑位占用判重：同一窑位、时间窗重叠即冲突。
 * 待排（升版撞位退回）与待确认（对账搁置）的排位不占窑位；只读旧排位也不占。
 */
export function checkSlotConflict(
  existing: Anneal[],
  candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'cardVersionId' | 'pieceId'>,
  ctx: AnnealContext,
  excludeAnnealId = '',
): SlotConflict {
  const ownWindow = cardAnnealWindow(candidate, ctx)
  for (const row of existing) {
    if (row.id === excludeAnnealId) continue
    if (row.kilnSlot !== candidate.kilnSlot) continue
    if (row.scheduleStatus !== '已排' || row.locked) continue
    const otherWindow = cardAnnealWindow(row, ctx)
    if (windowsOverlap(ownWindow, otherWindow)) {
      return {
        conflict: true,
        withPieceId: row.pieceId,
        withAnnealId: row.id,
        message: `窑位 ${candidate.kilnSlot} 在该时间窗内已被占用（${row.inAt} 起，卡版本 v${cardVersionLabel(
          ctx.cardOf(row.cardVersionId),
        )}），请更换窑位或调整时间。`,
      }
    }
  }
  return { conflict: false, withPieceId: '', withAnnealId: '', message: '' }
}

/** 卡版本展示文本：vN · 卡名；找不到时显示「卡已缺失」 */
export function cardVersionLabel(card: AnnealCard | null): string {
  return card === null ? '卡已缺失' : `v${card.version} ${card.name}`
}

/* ------------------------------ 旧库推断 ------------------------------ */

/**
 * 旧库没有玻璃种类字段，按料液配方推断：
 * 配方里出现「钾」「铅」判为钾铅玻璃，其余一律按钠钙玻璃（工作室历史默认料）。
 */
export function inferGlassKind(recipe: string | undefined): GlassKind {
  if (recipe !== undefined && /[钾铅]/.test(recipe)) return '钾铅玻璃'
  return '钠钙玻璃'
}

/** 由料液批次表推断作品玻璃种类 */
export function glassKindOfPiece(
  pieceBatchId: string,
  batches: Pick<GlassBatch, 'id' | 'recipe'>[],
): GlassKind {
  return inferGlassKind(batches.find((batch) => batch.id === pieceBatchId)?.recipe)
}

/** 校验玻璃种类入参（表单 / 导入兜底） */
export function normalizeGlassKind(value: unknown): GlassKind {
  return GLASS_KIND_OPTIONS.includes(value as GlassKind) ? (value as GlassKind) : '钠钙玻璃'
}

/** 生成卡族 key */
export function makeFamilyKey(): string {
  return `cardfam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 由草稿生成新卡族首版（id 由调用方给） */
export function buildNewCard(
  id: string,
  familyKey: string,
  draft: AnnealCardDraft,
  stamp: string,
  rowRevision: number,
): AnnealCard {
  return {
    id,
    familyKey,
    name: cardFamilyName(draft.glassKind, draft.wallMinMm, draft.wallMaxMm),
    glassKind: draft.glassKind,
    wallMinMm: draft.wallMinMm,
    wallMaxMm: draft.wallMaxMm,
    version: 1,
    status: 'active',
    supersedesId: '',
    remark: draft.remark.trim(),
    phases: PHASE_ORDER.map((name, index) => {
      const seg = draft.phases[index]
      return {
        phase: name,
        startC: seg.startC,
        endC: seg.endC,
        rateCPerHour: seg.rateCPerHour,
        holdHours: seg.holdHours,
        hint: seg.hint,
      }
    }),
    createdAt: stamp,
    updatedAt: stamp,
    revision: rowRevision,
  }
}

/** 由在用版本 + 草稿生成下一版（新 id，旧版由调用方归档） */
export function buildRevision(
  newId: string,
  previous: AnnealCard,
  draft: AnnealCardDraft,
  stamp: string,
  rowRevision: number,
): AnnealCard {
  return {
    ...buildNewCard(newId, previous.familyKey, draft, stamp, rowRevision),
    name: previous.name,
    glassKind: previous.glassKind,
    wallMinMm: previous.wallMinMm,
    wallMaxMm: previous.wallMaxMm,
    version: previous.version + 1,
    supersedesId: previous.id,
  }
}
