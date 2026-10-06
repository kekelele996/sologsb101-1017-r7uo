/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 版本演进：
 *   v1 → v2：Piece 增加 craft 索引并回填默认值
 *   v2 → v3：新增「退火工艺卡」表（cards，版本化留档）；Piece 增 glassKind；
 *            Anneal 增 cardVersionId / scheduleStatus / scheduleReason / locked；
 *            旧排位按作品壁厚套当时卡版，套不上留成只读
 * - 卡升版联动重算、按卡版本对账、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import type { AnnealCard, AnnealCardDraft } from '../types/card'
import { nowIso, uuid } from './id'
import { seedDatabase } from './seed'
import {
  bandOverlaps,
  buildDefaultCards,
  buildNewCard,
  buildRevision,
  checkSlotConflict,
  findCardVersion,
  glassKindOfPiece,
  makeFamilyKey,
  matchActiveCard,
  normalizeGlassKind,
} from './card'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>
  cards!: Table<AnnealCard, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt',
      batches: 'id, furnaceId, colorCode, meltDate',
      pieces: 'id, batchId, state, artist',
      steps: 'id, pieceId, [pieceId+seq], seq',
      anneals: 'id, pieceId, kilnSlot, state, inAt',
      inspects: 'id, pieceId, date, result',
    })

    // ---------- v2：Piece 增加 craft 索引并回填默认值，补齐其余索引与字段 ----------
    this.version(2)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        // craft 为 v2 新增索引
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：Piece 补齐 craft 字段（历史作品默认按吹制归类）
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
        })
        // 迁移 3：历史工序默认视为已执行完成，避免升级后被误判为待办
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''
        })
        // 迁移 4：退火记录补齐出炉时间与曲线段
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        // 迁移 5：检验记录补齐缺陷说明
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })
      })

    // ---------- v3：退火工艺卡版本化；旧排位按壁厚套当时卡版，套不上留只读 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name, glassKind',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg, cardVersionId, scheduleStatus',
        inspects: 'id, pieceId, date, result, inspector',
        // 工艺卡：按族取在用版（familyKey+status），按种类 / 版本过滤
        cards: 'id, familyKey, [familyKey+status], glassKind, status, version',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso()

        // 迁移 1：写入默认工艺卡（「当时那版」）
        const seedCards = buildDefaultCards(stamp, ROW_REVISION)
        await tx.table('cards').bulkAdd(seedCards)

        // 迁移 2：作品回填玻璃种类（按料液配方推断）
        const pieceRows: Array<Record<string, unknown>> = await tx.table('pieces').toArray()
        const batchRows: Array<Record<string, unknown>> = await tx.table('batches').toArray()
        const recipeOf = new Map<string, unknown>(batchRows.map((row) => [String(row.id), row.recipe]))
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          row.glassKind = inferKind(recipeOf.get(String(row.batchId)))
          row.revision = ROW_REVISION
          row.updatedAt = stamp
        })

        // 迁移 3：旧排位没记卡版本 —— 按作品玻璃种类 + 壁厚套当时在用版；
        //         套不上的留成只读（locked）并挂「待确认」，等排产员人工处理。
        const pieceIndex = new Map<string, Record<string, unknown>>(pieceRows.map((row) => [String(row.id), row]))
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
          row.cardVersionId = ''
          row.scheduleStatus = '待确认'
          row.scheduleReason = 'legacy-unmatched'
          row.locked = true
          row.revision = ROW_REVISION
          row.updatedAt = stamp

          const piece = pieceIndex.get(String(row.pieceId))
          if (piece === undefined) return
          const kind = inferKind(recipeOf.get(String(piece.batchId)))
          const wall = Number(piece.wallThicknessMm)
          const matched = seedCards.find(
            (card) => card.status === 'active' && card.glassKind === kind && wallMatch(card.wallMinMm, card.wallMaxMm, wall),
          )
          if (matched !== undefined) {
            row.cardVersionId = matched.id
            row.scheduleStatus = '已排'
            row.scheduleReason = 'none'
            row.locked = false
          }
        })
      })
  }
}

/** 迁移辅助：由配方值推断玻璃种类（封装一层，避免 upgrade 内依赖过多外部签名） */
function inferKind(recipe: unknown): import('../types/card').GlassKind {
  return normalizeGlassKind(
    typeof recipe === 'string' && /[钾铅]/.test(recipe) ? '钾铅玻璃' : '钠钙玻璃',
  )
}

/** 迁移辅助：壁厚命中区间 */
function wallMatch(min: number, max: number | null, wall: number): boolean {
  if (!Number.isFinite(wall)) return false
  if (wall < min) return false
  if (max !== null && wall > max) return false
  return true
}

export const db = new GlassBlowDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.furnaces.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await db.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putFurnace(row: Furnace): Promise<void> {
  await db.furnaces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除窑炉：级联清理该窑下的料液批次 */
export async function removeFurnace(id: string): Promise<void> {
  await db.transaction('rw', db.furnaces, db.batches, async () => {
    await db.batches.where('furnaceId').equals(id).delete()
    await db.furnaces.delete(id)
  })
}

/* ------------------------------ 料液批次 ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export async function putBatch(row: GlassBatch): Promise<void> {
  await db.batches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeBatch(id: string): Promise<void> {
  await db.batches.delete(id)
}

/** 取料：按剩余量扣减（不足时扣到 0 并返回实际扣减量） */
export async function consumeBatch(batchId: string, kg: number): Promise<number> {
  const batch = await db.batches.get(batchId)
  if (!batch) return 0
  const actual = Math.max(0, Math.min(batch.remainKg, kg))
  await db.batches.update(batchId, { remainKg: Math.round((batch.remainKg - actual) * 10) / 10, updatedAt: nowIso() })
  return actual
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await db.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await db.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除作品：级联清理工序、退火与检验记录 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.anneals, db.inspects, async () => {
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
    await db.pieces.delete(id)
  })
}

/**
 * 依工序与退火、检验记录推导并回写作品状态。
 * 规则：有检验记录 → 已检验；有已出炉退火 → 已退火；有工序记录 → 制作中；否则设计中。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).toArray(),
    db.anneals.where('pieceId').equals(pieceId).toArray(),
    db.inspects.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'
  if (inspects.length > 0) next = '已检验'

  if (next !== piece.state) {
    await db.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
  }
  return next
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await db.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await db.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putStep(row: Step): Promise<void> {
  await db.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeStep(id: string): Promise<void> {
  const step = await db.steps.get(id)
  if (!step) return
  await db.steps.delete(id)
  await syncPieceState(step.pieceId)
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用） */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.steps, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
    }
  })
}

/* ------------------------------ 退火工艺卡 ------------------------------ */

export async function listCards(): Promise<AnnealCard[]> {
  const rows = await db.cards.toArray()
  return rows.sort(
    (a, b) =>
      a.glassKind.localeCompare(b.glassKind, 'zh-Hans-CN') ||
      a.wallMinMm - b.wallMinMm ||
      b.version - a.version,
  )
}

export interface CardValidation {
  ok: boolean
  message: string
}

/** 校验卡族区间：同一玻璃种类壁厚区间不得与其他在用族重叠 */
export function validateCardBand(
  cards: AnnealCard[],
  draft: Pick<AnnealCardDraft, 'glassKind' | 'wallMinMm' | 'wallMaxMm'>,
  excludeFamilyKey = '',
): CardValidation {
  if (!(draft.wallMinMm > 0)) return { ok: false, message: '壁厚下限必须大于 0。' }
  if (draft.wallMaxMm !== null && draft.wallMaxMm <= draft.wallMinMm) {
    return { ok: false, message: '壁厚上限必须大于下限（留空表示无上界）。' }
  }
  const overlap = bandOverlaps(cards, draft.glassKind, draft.wallMinMm, draft.wallMaxMm, excludeFamilyKey)
  if (overlap !== null) {
    return {
      ok: false,
      message: `壁厚区间与同种类在用卡「${overlap.name} v${overlap.version}」重叠，请调整区间。`,
    }
  }
  return { ok: true, message: '' }
}

/** 校验三段参数：退火点一致、速率为正、保温时长为正 */
export function validateCardPhases(draft: AnnealCardDraft): CardValidation {
  const [heat, hold, cool] = draft.phases
  if (heat.rateCPerHour <= 0) return { ok: false, message: '升温速率必须大于 0。' }
  if (heat.endC !== hold.startC || hold.endC !== hold.startC) {
    return { ok: false, message: '升温终点与保温退火点必须一致。' }
  }
  if (cool.rateCPerHour <= 0) return { ok: false, message: '缓冷速率必须大于 0。' }
  if (cool.startC !== hold.endC) return { ok: false, message: '缓冷起点必须等于保温退火点。' }
  if (hold.holdHours <= 0) return { ok: false, message: '保温时长必须大于 0。' }
  return { ok: true, message: '' }
}

/** 新建卡族（首版） */
export async function createCard(draft: AnnealCardDraft): Promise<AnnealCard> {
  const cards = await listCards()
  const band = validateCardBand(cards, draft)
  if (!band.ok) throw new Error(band.message)
  const phases = validateCardPhases(draft)
  if (!phases.ok) throw new Error(phases.message)
  const stamp = nowIso()
  const card = buildNewCard(uuid('card'), makeFamilyKey(), draft, stamp, ROW_REVISION)
  await db.cards.put(card)
  return card
}

export interface PublishRevisionResult {
  card: AnnealCard
  /** 升版后重算撞窑位、退回待排的排位 */
  bounced: Anneal[]
}

/**
 * 调参升版：
 * 旧在用版留档（archived，只读），写入下一版 active；
 * 尚未进窑（待入窑且已排）的排位改挂新版并按新版重算时间窗，
 * 与他人窑位撞车的排位退回「待排」（不占窑位、清空预计出炉时间）；
 * 已进窑（退火中 / 已出炉）的排位照当初那版烧完，不动。
 */
export async function publishCardRevision(familyKey: string, draft: AnnealCardDraft): Promise<PublishRevisionResult> {
  return db.transaction('rw', db.cards, db.anneals, db.pieces, async () => {
    const cards = await db.cards.toArray()
    const previous = cards.find((row) => row.familyKey === familyKey && row.status === 'active')
    if (previous === undefined) throw new Error('该卡族没有在用版本，无法升版。')
    const phases = validateCardPhases(draft)
    if (!phases.ok) throw new Error(phases.message)

    const stamp = nowIso()
    await db.cards.update(previous.id, { status: 'archived' as const, updatedAt: stamp })
    const next = buildRevision(uuid('card'), previous, draft, stamp, ROW_REVISION)
    await db.cards.put(next)

    // 只重算还没进窑的排位
    const affected = await db.anneals
      .where('cardVersionId')
      .equals(previous.id)
      .toArray()
    const pieces = await db.pieces.toArray()
    const wallOf = (pieceId: string): number => pieces.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4
    const latestCards = [...cards.filter((row) => row.id !== previous.id), next]
    const cardOf = (id: string): AnnealCard | null => findCardVersion(latestCards, id)

    // 内存里同步每条排位的最新状态，避免先处理的排位在后续判重中用过时数据
    const currentRows = await db.anneals.toArray()
    const bounced: Anneal[] = []

    for (const row of affected) {
      if (row.locked || row.state !== '待入窑') continue // 已进窑照旧版；只读旧排位不动
      const candidate = { ...row, cardVersionId: next.id, scheduleStatus: '已排' as const }
      const clash = checkSlotConflict(
        // 已判撞位退回的不再占窑位
        currentRows.filter((item) => !bounced.some((parked) => parked.id === item.id)),
        candidate,
        { wallThicknessOf: wallOf, cardOf },
        row.id,
      )
      if (clash.conflict) {
        // 撞了别人：退回待排，搁置等排产员重新排
        const parked: Anneal = { ...row, cardVersionId: next.id, scheduleStatus: '待排', scheduleReason: 'none', outAt: '' }
        await db.anneals.update(row.id, {
          cardVersionId: next.id,
          scheduleStatus: '待排' as const,
          scheduleReason: 'none' as const,
          outAt: '',
          updatedAt: stamp,
        })
        bounced.push(parked)
        const index = currentRows.findIndex((item) => item.id === row.id)
        if (index >= 0) currentRows[index] = parked
      } else {
        await db.anneals.update(row.id, {
          cardVersionId: next.id,
          scheduleStatus: '已排' as const,
          scheduleReason: 'none' as const,
          outAt: '',
          updatedAt: stamp,
        })
        const index = currentRows.findIndex((item) => item.id === row.id)
        if (index >= 0) currentRows[index] = candidate
      }
    }
    return { card: next, bounced }
  })
}

/* -------------------------------- 退火 -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await db.anneals.get(id)
  if (!row) return
  await db.anneals.delete(id)
  await syncPieceState(row.pieceId)
}

/** 推进退火状态；「已出炉」时写回出炉时间并同步作品状态。只读旧排位禁止推进。 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<boolean> {
  const row = await db.anneals.get(annealId)
  if (!row || row.locked || row.scheduleStatus !== '已排') return false
  await db.anneals.update(annealId, { state: next, outAt: next === '已出炉' ? outAt : row.outAt, updatedAt: nowIso() })
  await syncPieceState(row.pieceId)
  return true
}

/* --------------------------- 待排 / 对账处理 --------------------------- */

export interface RecheckResult {
  ok: boolean
  message: string
}

/**
 * 待排排位重新提交：校验新版卡下窑位是否仍冲突，不冲突则恢复「已排」。
 */
export async function resubmitBounced(
  annealId: string,
  patch: Pick<Anneal, 'kilnSlot' | 'inAt' | 'cardVersionId'>,
): Promise<RecheckResult> {
  return db.transaction('rw', db.anneals, db.pieces, db.cards, async () => {
    const row = await db.anneals.get(annealId)
    if (!row) return { ok: false, message: '排位不存在或已被删除。' }
    if (row.scheduleStatus !== '待排') return { ok: false, message: '只有退回待排的排位需要重新提交。' }
    const [pieces, cards, all] = await Promise.all([db.pieces.toArray(), db.cards.toArray(), db.anneals.toArray()])
    const wallOf = (pieceId: string): number => pieces.find((item) => item.id === pieceId)?.wallThicknessMm ?? 4
    const cardOf = (id: string): AnnealCard | null => findCardVersion(cards, id)
    const candidate = {
      id: row.id,
      pieceId: row.pieceId,
      kilnSlot: patch.kilnSlot,
      inAt: patch.inAt,
      outAt: '',
      cardVersionId: patch.cardVersionId,
    }
    if (cardOf(patch.cardVersionId) === null) {
      return { ok: false, message: '所选卡版本不存在，请重新挑一张卡。' }
    }
    const clash = checkSlotConflict(all, candidate, { wallThicknessOf: wallOf, cardOf }, row.id)
    if (clash.conflict) return { ok: false, message: clash.message }
    await db.anneals.update(annealId, {
      kilnSlot: patch.kilnSlot,
      inAt: patch.inAt,
      cardVersionId: patch.cardVersionId,
      outAt: '',
      scheduleStatus: '已排' as const,
      scheduleReason: 'none' as const,
      state: '待入窑' as const,
      updatedAt: nowIso(),
    })
    return { ok: true, message: '排位已按新版卡重排，恢复为已排。' }
  })
}

/**
 * 对账搁置（待确认）的排位人工确认后改挂指定卡版本（通常是当前在用版）。
 * 只读的旧排位（locked）不允许在此处理，只能查看。
 */
export async function confirmSchedule(
  annealId: string,
  cardVersionId: string,
  patch?: Partial<Pick<Anneal, 'kilnSlot' | 'inAt'>>,
): Promise<RecheckResult> {
  return db.transaction('rw', db.anneals, db.pieces, db.cards, async () => {
    const row = await db.anneals.get(annealId)
    if (!row) return { ok: false, message: '排位不存在或已被删除。' }
    if (row.locked) return { ok: false, message: '该排位是升级时套不上卡的只读旧记录，不能修改。' }
    if (row.scheduleStatus !== '待确认') return { ok: false, message: '只有待确认的排位需要对账确认。' }
    const [pieces, cards, all] = await Promise.all([db.pieces.toArray(), db.cards.toArray(), db.anneals.toArray()])
    const wallOf = (pieceId: string): number => pieces.find((item) => item.id === pieceId)?.wallThicknessMm ?? 4
    const cardOf = (id: string): AnnealCard | null => findCardVersion(cards, id)
    if (cardOf(cardVersionId) === null) return { ok: false, message: '所选卡版本不存在。' }
    const kilnSlot = patch?.kilnSlot ?? row.kilnSlot
    const inAt = patch?.inAt ?? row.inAt
    const candidate = { id: row.id, pieceId: row.pieceId, kilnSlot, inAt, outAt: '', cardVersionId }
    const clash = checkSlotConflict(all, candidate, { wallThicknessOf: wallOf, cardOf }, row.id)
    if (clash.conflict) return { ok: false, message: clash.message }
    await db.anneals.update(annealId, {
      cardVersionId,
      kilnSlot,
      inAt,
      outAt: '',
      scheduleStatus: '已排' as const,
      scheduleReason: 'none' as const,
      state: '待入窑' as const,
      updatedAt: nowIso(),
    })
    return { ok: true, message: '对账完成，排位已改挂所选卡版本。' }
  })
}

/**
 * 按卡版本对账：
 * 非只读、非待排的排位若引用的卡版本找不到（卡被清理 / 旧档导入缺卡），挂「待确认」等人工处理。
 * 已正常排定 / 已进窑的排位不动。返回被搁置的排位。
 */
export async function reconcileSchedules(): Promise<Anneal[]> {
  return db.transaction('rw', db.anneals, db.cards, async () => {
    const [cards, rows] = await Promise.all([db.cards.toArray(), db.anneals.toArray()])
    const parked: Anneal[] = []
    for (const row of rows) {
      if (row.locked || row.scheduleStatus !== '已排') continue
      if (findCardVersion(cards, row.cardVersionId) !== null) continue
      await db.anneals.update(row.id, {
        scheduleStatus: '待确认' as const,
        scheduleReason: 'card-missing' as const,
        updatedAt: nowIso(),
      })
      parked.push({ ...row, scheduleStatus: '待确认', scheduleReason: 'card-missing' })
    }
    return parked
  })
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await db.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await db.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await db.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeInspect(id: string): Promise<void> {
  const row = await db.inspects.get(id)
  if (!row) return
  await db.inspects.delete(id)
  await syncPieceState(row.pieceId)
}

/* ------------------------ 旧档导入 / 缺卡补齐（heal） ------------------------ */

/**
 * 兼容导入 v1/v2 老快照：
 * 缺卡时补默认卡；Piece 缺 glassKind 按料液配方推断；
 * Anneal 缺 cardVersionId 时按作品壁厚套当时在用版，套不上留只读。
 */
export async function healLegacySnapshotData(data: {
  cards: AnnealCard[]
  pieces: Piece[]
  batches: GlassBatch[]
  anneals: Anneal[]
}): Promise<void> {
  const stamp = nowIso()
  const cards = data.cards.length > 0 ? data.cards : buildDefaultCards(stamp, ROW_REVISION)

  data.pieces.forEach((piece) => {
    piece.glassKind = normalizeGlassKind(piece.glassKind ?? glassKindOfPiece(piece.batchId, data.batches))
    piece.revision = ROW_REVISION
  })

  data.anneals.forEach((row) => {
    if (typeof row.cardVersionId === 'string' && row.cardVersionId !== '') {
      row.scheduleStatus = row.scheduleStatus ?? '已排'
      row.scheduleReason = row.scheduleReason ?? 'none'
      row.locked = row.locked ?? false
      return
    }
    const piece = data.pieces.find((item) => item.id === row.pieceId)
    const matched =
      piece === undefined
        ? null
        : matchActiveCard(cards, piece.glassKind, piece.wallThicknessMm)
    if (matched !== null) {
      row.cardVersionId = matched.id
      row.scheduleStatus = '已排'
      row.scheduleReason = 'none'
      row.locked = false
    } else {
      row.cardVersionId = ''
      row.scheduleStatus = '待确认'
      row.scheduleReason = 'legacy-unmatched'
      row.locked = true
    }
    if (typeof row.outAt !== 'string') row.outAt = ''
    row.revision = ROW_REVISION
  })

  data.cards = cards
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  anneals: Anneal[]
  inspects: Inspect[]
  cards: AnnealCard[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects, cards] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
    db.cards.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    furnaces,
    batches,
    pieces,
    steps,
    anneals,
    inspects,
    cards,
  }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const cards = snapshot.cards ?? []
  const pieces = snapshot.pieces.map((row) => ({ ...row }))
  const batches = snapshot.batches.map((row) => ({ ...row }))
  const anneals = snapshot.anneals.map((row) => ({ ...row })) as Anneal[]
  await healLegacySnapshotData({ cards: [...cards], pieces, batches, anneals })

  await db.transaction('rw', [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.cards], async () => {
    await Promise.all([
      db.furnaces.clear(),
      db.batches.clear(),
      db.pieces.clear(),
      db.steps.clear(),
      db.anneals.clear(),
      db.inspects.clear(),
      db.cards.clear(),
    ])
    await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.batches.bulkPut(batches.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.pieces.bulkPut(pieces)
    await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.anneals.bulkPut(anneals)
    await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.cards.bulkPut(cards)
  })
  // 导入后按卡版本对账：快照里若有排位引用了不存在的卡，搁置为待确认
  await reconcileSchedules()
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.cards],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.cards.clear(),
      ])
    },
  )
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects, cards] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.inspects.count(),
    db.cards.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects, cards }
}
