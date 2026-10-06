/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 结构版本：
 *   v1：初版；
 *   v2：Piece 增加 craft 索引并回填默认值；
 *   v3：新增「退火工艺卡」表，批次加玻璃种类，排位绑定卡版本并补排产状态；
 *       老排位按作品壁厚套「当时那版（v1）」卡，套不上的置 legacy 只读。
 * - 卡升版后未进窑排位按新版重算（撞窑位退回待排），已进窑冻结原版本；
 *   提供按卡版本对账（对不上的待入窑排位置「待确认」）。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal, ScheduleState } from '../types/anneal'
import type { AnnealCard, AnnealCardDraft } from '../types/card'
import { DEFAULT_GLASS_TYPE } from '../types/card'
import type { Inspect } from '../types/inspect'
import { nowIso } from './id'
import { seedDatabase } from './seed'
import { buildDefaultCards } from './defaultCards'
import {
  activeCards,
  buildCardKey,
  cardCoversThickness,
  cardTotalHours,
  checkSlotConflict,
  legacyTotalHours,
  pickLegacyCard,
} from './thermal'

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
  annealCards!: Table<AnnealCard, string>

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
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
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
            row.revision = 2
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
        })
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''
        })
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })
      })

    // ---------- v3：退火工艺卡 + 批次玻璃种类 + 排位卡版本 / 排产状态 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, glassType, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, scheduleState, inAt, curveSeg, cardVersionId, cardKey',
        inspects: 'id, pieceId, date, result, inspector',
        // 工艺卡：[cardKey+version] 唯一版本号；state 区分生效 / 留档 / 草稿
        annealCards: 'id, cardKey, [cardKey+version], glassType, state, version',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso()
        const cardsTable = tx.table<AnnealCard, string>('annealCards')

        // 迁移 1：老库没有工艺卡 → 灌入内置「当时那版（v1）」基准卡
        if ((await cardsTable.count()) === 0) {
          await cardsTable.bulkAdd(buildDefaultCards(stamp, ROW_REVISION))
        }
        const cards = await cardsTable.toArray()

        // 迁移 2：批次补玻璃种类（老库一律按钠钙玻璃兜底）
        await tx.table<GlassBatch, string>('batches').toCollection().modify((row) => {
          const glass = row.glassType as unknown
          if (typeof glass !== 'string' || glass === '') row.glassType = DEFAULT_GLASS_TYPE
          row.revision = ROW_REVISION
        })
        const batches = await tx.table<GlassBatch, string>('batches').toArray()
        const batchGlass = new Map(batches.map((row) => [row.id, row.glassType]))

        // 迁移 3：作品壁厚表（套卡用）
        const pieces = await tx.table<Piece, string>('pieces').toArray()
        const pieceOf = new Map(pieces.map((row) => [row.id, row]))

        // 迁移 4：老排位补卡版本 / 排产状态；按壁厚套当时那版，套不上留只读
        await tx.table<Anneal, string>('anneals').toCollection().modify((row) => {
          if (typeof row.cardVersionId !== 'string') row.cardVersionId = ''
          if (typeof row.cardKey !== 'string') row.cardKey = ''
          if (typeof row.cardVersion !== 'number') row.cardVersion = 0
          if (typeof row.legacy !== 'boolean') row.legacy = false
          if (typeof row.scheduleState !== 'string') {
            row.scheduleState = row.state === '待入窑' ? '已排' : '已进窑'
          }

          // 仅给还没绑卡的老排位尝试补绑（已绑的保持冻结版本不动）
          if (row.cardVersionId === '' && !row.legacy) {
            const piece = pieceOf.get(row.pieceId)
            const glassType = piece ? (batchGlass.get(piece.batchId) ?? DEFAULT_GLASS_TYPE) : DEFAULT_GLASS_TYPE
            const hit = piece ? pickLegacyCard(cards, glassType, piece.wallThicknessMm) : null
            if (hit !== null) {
              row.cardVersionId = hit.id
              row.cardKey = hit.cardKey
              row.cardVersion = hit.version
              row.legacy = false
            } else {
              // 套不上卡：留档只读
              row.legacy = true
              row.scheduleState = row.state === '待入窑' ? '待排' : '已进窑'
            }
          }
          row.revision = ROW_REVISION
        })
      })
  }
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
  const rows = await db.annealCards.toArray()
  return rows.sort(
    (a, b) =>
      a.glassType.localeCompare(b.glassType, 'zh-Hans-CN') ||
      a.minMm - b.minMm ||
      b.version - a.version,
  )
}

export async function listCardVersions(cardKey: string): Promise<AnnealCard[]> {
  const rows = await db.annealCards.where('cardKey').equals(cardKey).toArray()
  return rows.sort((a, b) => b.version - a.version)
}

export async function putCard(row: AnnealCard): Promise<void> {
  await db.annealCards.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 同玻璃种类下壁厚区间是否与其它生效卡重叠（同卡系除外） */
async function assertNoOverlap(input: {
  cardKey?: string
  glassType: AnnealCard['glassType']
  minMm: number
  maxMm: number
}): Promise<void> {
  if (!(input.minMm <= input.maxMm)) {
    throw new Error('壁厚区间下限不能大于上限。')
  }
  if (input.minMm < 0) throw new Error('壁厚区间下限不能为负。')
  const overlap = activeCards(await db.annealCards.toArray()).find(
    (card) =>
      card.glassType === input.glassType &&
      card.cardKey !== input.cardKey &&
      input.minMm <= card.maxMm &&
      card.minMm <= input.maxMm,
  )
  if (overlap !== undefined) {
    throw new Error(
      `壁厚区间与已生效卡「${overlap.name} v${overlap.version}（${overlap.minMm}–${overlap.maxMm} mm）」重叠，同一玻璃种类的卡区间不能交叉。`,
    )
  }
}

export interface PublishResult {
  card: AnnealCard
  /** 本次升版连带重算的排位条数 */
  recalculated: number
  /** 重算时撞窑位退回待排的条数 */
  bounced: number
  /** 区间已不覆盖、置待确认的条数 */
  unresolved: number
}

/**
 * 发布工艺卡版本（事务）：
 * - cardKey 为空：建立新卡系 v1；
 * - cardKey 已有：把旧生效版置 archived，另存 version+1 新版本为 active；
 * - 发布后对该卡系「未进窑」排位按新版重算（撞窑位退回待排）。
 */
export async function publishCardVersion(input: AnnealCardDraft & { cardKey?: string }): Promise<PublishResult> {
  return db.transaction('rw', db.annealCards, db.anneals, db.pieces, db.batches, async () => {
    await assertNoOverlap({
      cardKey: input.cardKey,
      glassType: input.glassType,
      minMm: input.minMm,
      maxMm: input.maxMm,
    })

    const stamp = nowIso()
    let cardKey = input.cardKey ?? ''
    let version = 1

    if (cardKey !== '') {
      const versions = await db.annealCards.where('cardKey').equals(cardKey).toArray()
      if (versions.length === 0) throw new Error('要升版的卡系不存在，无法另存新版本。')
      version = versions.reduce((max, row) => Math.max(max, row.version), 0) + 1
      // cardKey 是跨版本稳定标识：即使本版调整了壁厚区间或玻璃种类也不随之迁移，
      // 旧卡系排位仍按同一 cardKey 参与重算 / 对账。
      for (const old of versions) {
        if (old.state === 'active') {
          await db.annealCards.update(old.id, { state: 'archived', updatedAt: stamp })
        }
      }
    } else {
      cardKey = buildCardKey(input.glassType, input.minMm, input.maxMm)
    }

    const card: AnnealCard = {
      id: `card-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      cardKey,
      name: input.name.trim() || '未命名退火工艺卡',
      glassType: input.glassType,
      minMm: input.minMm,
      maxMm: input.maxMm,
      version,
      state: 'active',
      curve: input.curve,
      note: input.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await db.annealCards.put(card)

    const stats = await recomputeSchedulesForCardKey(card.cardKey, card.id)
    return { card, ...stats }
  })
}

/** 排位时长解析：按其冻结的卡版本；套不上卡的遗留记录走老口径（按壁厚） */
function hoursResolver(
  cards: AnnealCard[],
  pieces: Piece[],
): (anneal: Pick<Anneal, 'pieceId'> & Partial<Pick<Anneal, 'cardVersionId'>>) => number {
  const cardById = new Map(cards.map((card) => [card.id, card]))
  const pieceById = new Map(pieces.map((piece) => [piece.id, piece]))
  return (anneal) => {
    const card = cardById.get(anneal.cardVersionId ?? '')
    if (card !== undefined) return cardTotalHours(card)
    const thickness = pieceById.get(anneal.pieceId)?.wallThicknessMm ?? 4
    return legacyTotalHours(thickness)
  }
}

/**
 * 按新版重算某卡系下「未进窑」的排位（事务内部调用）。
 * - 新版区间已不覆盖 → 置「待确认」等人工处理。
 * 已进窑（退火中 / 已出炉）的排位冻结原版本，不重算。
 */
async function recomputeSchedulesForCardKey(
  cardKey: string,
  activeCardId: string
): Promise<{ recalculated: number; bounced: number; unresolved: number }> {
  const [card, cards, pieces, batches, anneals] = await Promise.all([
    db.annealCards.get(activeCardId),
    db.annealCards.toArray(),
    db.pieces.toArray(),
    db.batches.toArray(),
    db.anneals.toArray(),
  ])
  if (card === undefined) return { recalculated: 0, bounced: 0, unresolved: 0 }

  const pieceById = new Map(pieces.map((piece) => [piece.id, piece]))
  const batchGlass = new Map(batches.map((batch) => [batch.id, batch.glassType]))
  const hoursOf = hoursResolver(cards, pieces)

  let recalculated = 0
  let bounced = 0
  let unresolved = 0

  for (const row of anneals) {
    if (row.legacy) continue
    if (row.cardKey !== cardKey) continue
    // 已进窑照当初那版烧完，不重算
    if (row.state !== '待入窑' || row.scheduleState === '已进窑') continue

    const piece = pieceById.get(row.pieceId)
    const glassType = piece ? (batchGlass.get(piece.batchId) ?? DEFAULT_GLASS_TYPE) : DEFAULT_GLASS_TYPE
    const covered =
      piece !== undefined &&
      card.glassType === glassType &&
      cardCoversThickness(card, piece.wallThicknessMm)

    recalculated += 1

    if (!covered) {
      // 新版已不覆盖该件：搁着等确认，不自动改窑位
      await db.anneals.update(row.id, { scheduleState: '待确认' as ScheduleState, updatedAt: nowIso() })
      unresolved += 1
      continue
    }

    if (row.kilnSlot === '' || row.scheduleState === '待排') {
      // 本就待排：仅重绑版本，继续待排等人工排窑位
      await db.anneals.update(row.id, {
        cardVersionId: card.id,
        cardVersion: card.version,
        scheduleState: '待排' as ScheduleState,
        updatedAt: nowIso(),
      })
      continue
    }

    // 候选排位自身按「新版」时长取窗；其它排位仍按各自冻结版本取窗。
    // 不能用候选行在库里还没更新的旧 cardVersionId，否则窗口没拉长会漏判撞窑。
    const newCardHours = cardTotalHours(card)
    const conflict = checkSlotConflict(
      anneals,
      { id: row.id, kilnSlot: row.kilnSlot, inAt: row.inAt, outAt: row.outAt, pieceId: row.pieceId },
      (item) => ('id' in item && (item as Anneal).id === row.id ? newCardHours : hoursOf(item)),
      row.id,
    )
    if (conflict.conflict) {
      // 撞了别人：退回待排，窑位与时段占位释放
      await db.anneals.update(row.id, {
        cardVersionId: card.id,
        cardVersion: card.version,
        kilnSlot: '',
        scheduleState: '待排' as ScheduleState,
        updatedAt: nowIso(),
      })
      bounced += 1
    } else {
      await db.anneals.update(row.id, {
        cardVersionId: card.id,
        cardVersion: card.version,
        scheduleState: '已排' as ScheduleState,
        updatedAt: nowIso(),
      })
    }
  }

  return { recalculated, bounced, unresolved }
}

/**
 * 按卡版本对账（事务）：未进窑排位若冻结版本 ≠ 卡系当前生效版本，置「待确认」。
 * 已进窑 / 已出炉的排位按规矩烧完旧版，不算异常。
 * 返回对不上账的排位条数。
 */
export async function reconcileSchedules(): Promise<number> {
  return db.transaction('rw', db.annealCards, db.anneals, async () => {
    const [cards, anneals] = await Promise.all([db.annealCards.toArray(), db.anneals.toArray()])
    const currentOf = new Map(activeCards(cards).map((card) => [card.cardKey, card]))
    let flagged = 0
    for (const row of anneals) {
      if (row.legacy) continue
      if (row.state !== '待入窑') continue // 已进窑的冻结旧版，不拦
      const current = currentOf.get(row.cardKey)
      const mismatch = current === undefined || current.version !== row.cardVersion
      if (mismatch && row.scheduleState !== '待确认') {
        await db.anneals.update(row.id, { scheduleState: '待确认' as ScheduleState, updatedAt: nowIso() })
        flagged += 1
      }
    }
    return flagged
  })
}

/**
 * 处理一条「待确认」排位：按当前生效卡重算一次。
 * 仍无覆盖卡 → 保持待确认；撞窑位 → 退回待排；否则重绑新版置已排。
 */
export async function resolveSchedule(annealId: string): Promise<ScheduleState | null> {
  return db.transaction('rw', db.annealCards, db.anneals, db.pieces, db.batches, async () => {
    const row = await db.anneals.get(annealId)
    if (row === undefined) return null
    const [cards, pieces, batches, anneals] = await Promise.all([
      db.annealCards.toArray(),
      db.pieces.toArray(),
      db.batches.toArray(),
      db.anneals.toArray(),
    ])
    const piece = pieces.find((item) => item.id === row.pieceId)
    const glassType = piece ? (batches.find((b) => b.id === piece.batchId)?.glassType ?? DEFAULT_GLASS_TYPE) : DEFAULT_GLASS_TYPE
    const current = activeCards(cards).find((card) => card.cardKey === row.cardKey)
    if (current === undefined || piece === undefined || current.glassType !== glassType || !cardCoversThickness(current, piece.wallThicknessMm)) {
      return row.scheduleState
    }
    const hoursOf = hoursResolver(cards, pieces)
    const currentHours = cardTotalHours(current)
    if (row.kilnSlot !== '') {
      const conflict = checkSlotConflict(
        anneals,
        { id: row.id, kilnSlot: row.kilnSlot, inAt: row.inAt, outAt: row.outAt, pieceId: row.pieceId },
        (item) => ('id' in item && (item as Anneal).id === row.id ? currentHours : hoursOf(item)),
        row.id,
      )
      if (conflict.conflict) {
        await db.anneals.update(row.id, {
          cardVersionId: current.id,
          cardVersion: current.version,
          kilnSlot: '',
          scheduleState: '待排',
          updatedAt: nowIso(),
        })
        return '待排'
      }
    }
    const nextState: ScheduleState = row.kilnSlot === '' ? '待排' : '已排'
    await db.anneals.update(row.id, {
      cardVersionId: current.id,
      cardVersion: current.version,
      scheduleState: nextState,
      updatedAt: nowIso(),
    })
    return nextState
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

/** 手工退回待排（释放窑位占位） */
export async function returnToQueue(annealId: string): Promise<void> {
  const row = await db.anneals.get(annealId)
  if (!row || row.legacy || row.state !== '待入窑') return
  await db.anneals.update(annealId, { kilnSlot: '', scheduleState: '待排', updatedAt: nowIso() })
}

/** 推进退火状态；进窑即冻结卡版本，「已出炉」时写回出炉时间并同步作品状态 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  const row = await db.anneals.get(annealId)
  if (!row) return
  // 老库升级套不上卡的遗留排位只读留档，不允许推进
  if (row.legacy) return
  const patch: Partial<Anneal> = {
    state: next,
    outAt: next === '已出炉' ? outAt : row.outAt,
    updatedAt: nowIso(),
  }
  // 待入窑 → 退火中：进窑，排产状态冻结
  if (next === '退火中') patch.scheduleState = '已进窑'
  await db.anneals.update(annealId, patch)
  await syncPieceState(row.pieceId)
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
  annealCards: AnnealCard[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects, annealCards] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
    db.annealCards.toArray(),
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
    annealCards,
  }
}

/** 归一化旧版（v2 及以前）快照里缺字段的批次 / 排位，避免导入后行结构残缺 */
function normalizeSnapshot(snapshot: DatabaseSnapshot): DatabaseSnapshot {
  const stamp = nowIso()
  const batches = (snapshot.batches ?? []).map((row) => ({
    ...row,
    glassType: row.glassType ?? DEFAULT_GLASS_TYPE,
  }))
  const anneals = (snapshot.anneals ?? []).map((row) => {
    const legacy = typeof row.cardVersionId === 'string' && row.cardVersionId !== '' ? row.legacy === true : true
    return {
      ...row,
      cardVersionId: row.cardVersionId ?? '',
      cardKey: row.cardKey ?? '',
      cardVersion: row.cardVersion ?? 0,
      scheduleState: row.scheduleState ?? (row.state === '待入窑' ? '待排' : '已进窑'),
      legacy,
    }
  })
  return {
    ...snapshot,
    batches,
    anneals,
    annealCards: snapshot.annealCards ?? buildDefaultCards(stamp, ROW_REVISION),
  }
}

export async function importSnapshot(raw: DatabaseSnapshot): Promise<void> {
  const snapshot = normalizeSnapshot(raw)
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.annealCards],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.annealCards.clear(),
      ])
      await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.annealCards.bulkPut(snapshot.annealCards.map((row) => ({ ...row, revision: ROW_REVISION })))
    },
  )
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.annealCards],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.annealCards.clear(),
      ])
    },
  )
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects, annealCards] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.inspects.count(),
    db.annealCards.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects, annealCards }
}
