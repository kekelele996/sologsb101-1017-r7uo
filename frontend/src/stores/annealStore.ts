/**
 * 退火窑位排位状态管理（Pinia）
 * 排产员先挑一张退火工艺卡，入窑时段按所选卡版本三段合计时长推算；
 * 卡升版后未进窑排位由 db 层按新版重算（撞窑位退回待排），已进窑冻结原版本；
 * 卡版本对不上账的未进窑排位置「待确认」。老库套不上卡的排位 legacy 只读。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, ScheduleState } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { AnnealCard, GlassType } from '../types/card'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import {
  ROW_REVISION,
  advanceAnnealState,
  db,
  initDatabase,
  putAnneal,
  reconcileSchedules,
  removeAnneal,
  resolveSchedule,
  returnToQueue,
} from '../utils/db'
import {
  cardTotalHours,
  checkSlotConflict,
  formatHours,
  isCardVersionCurrent,
  kilnSlots,
  legacyTotalHours,
  pickActiveCard,
  type SlotConflict,
} from '../utils/thermal'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  scheduleState: ScheduleState | 'all'
  state: AnnealState | 'all'
  kilnCode: string | 'all'
}

/** 窑位占用行 */
export interface SlotOccupancy {
  kilnSlot: string
  annealId: string
  pieceId: string
  pieceName: string
  cardName: string
  inAt: string
  outAt: string
  state: AnnealState
  /** 该窑位当前是否被未出炉记录占用 */
  occupied: boolean
}

const EMPTY_FILTERS: AnnealFilters = { keyword: '', scheduleState: 'all', state: 'all', kilnCode: 'all' }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const batches = ref<GlassBatch[]>([])
  const cards = ref<AnnealCard[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const pieceById = computed<Map<string, Piece>>(() => new Map(pieces.value.map((row) => [row.id, row])))
  const batchById = computed<Map<string, GlassBatch>>(() => new Map(batches.value.map((row) => [row.id, row])))
  const cardById = computed<Map<string, AnnealCard>>(() => new Map(cards.value.map((row) => [row.id, row])))

  function pieceOf(pieceId: string): Piece | undefined {
    return pieceById.value.get(pieceId)
  }

  function glassTypeOfPiece(pieceId: string): GlassType {
    const piece = pieceOf(pieceId)
    if (piece === undefined) return '钠钙玻璃'
    return batchById.value.get(piece.batchId)?.glassType ?? '钠钙玻璃'
  }

  /** 排位绑定的卡版本（legacy 或卡缺失时为 undefined） */
  function cardOfAnneal(anneal: Pick<Anneal, 'cardVersionId'>): AnnealCard | undefined {
    return cardById.value.get(anneal.cardVersionId)
  }

  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    anneals.value.forEach((row) => {
      if (row.kilnSlot === '') return
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  /** 排位时长：按其冻结的卡版本；遗留/缺卡记录走老口径（按壁厚） */
  function hoursOf(
    anneal: Pick<Anneal, 'pieceId'> & Partial<Pick<Anneal, 'cardVersionId'>>,
  ): number {
    const card = cardById.value.get(anneal.cardVersionId ?? '')
    if (card !== undefined) return cardTotalHours(card)
    return legacyTotalHours(pieceOf(anneal.pieceId)?.wallThicknessMm ?? 4)
  }

  /** 某件作品当前应使用的生效卡（玻璃种类 + 壁厚自动匹配） */
  function suggestedCard(pieceId: string): AnnealCard | null {
    const piece = pieceOf(pieceId)
    if (piece === undefined) return null
    return pickActiveCard(cards.value, glassTypeOfPiece(pieceId), piece.wallThicknessMm)
  }

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表（待排 / 待确认不占位） */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .filter((row) => row.scheduleState === '已排' || row.scheduleState === '已进窑')
      .map((row) => {
        const piece = pieceOf(row.pieceId)
        const card = cardOfAnneal(row)
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: piece?.name ?? '（作品已删除）',
          cardName: card === undefined ? (row.legacy ? '遗留只读（无卡）' : '卡版本缺失') : `${card.name} v${row.cardVersion}`,
          inAt: row.inAt,
          outAt: row.outAt,
          state: row.state,
          occupied: row.state !== '已出炉',
        }
      })
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt)),
  )

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.scheduleState !== 'all' && row.scheduleState !== filters.scheduleState) return false
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (keyword === '') return true
      const piece = pieceOf(row.pieceId)
      const card = cardOfAnneal(row)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        (card?.name ?? '').toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  const stats = computed(() => ({
    total: anneals.value.length,
    queue: anneals.value.filter((row) => row.scheduleState === '待排').length,
    scheduled: anneals.value.filter((row) => row.scheduleState === '已排').length,
    pending: anneals.value.filter((row) => row.scheduleState === '待确认').length,
    firing: anneals.value.filter((row) => row.state === '退火中').length,
    done: anneals.value.filter((row) => row.state === '已出炉').length,
    legacy: anneals.value.filter((row) => row.legacy).length,
  }))

  /** 窑位冲突检测（编辑时排除自身）；时长按候选/既有的卡版本取 */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'pieceId' | 'cardVersionId'>,
  ): SlotConflict {
    const resolvable: Anneal[] = anneals.value
    return checkSlotConflict(resolvable, candidate, (item) => hoursOf(item), candidate.id)
  }

  /** 某张卡 + 入窑时间的预计出炉时间戳；未选卡返回 NaN */
  function expectedOutAt(cardVersionId: string, inAt: string): number {
    const card = cardById.value.get(cardVersionId)
    if (card === undefined) return Number.NaN
    const start = new Date(inAt).getTime()
    if (Number.isNaN(start)) return Number.NaN
    return start + cardTotalHours(card) * 3600 * 1000
  }

  /** 排位时长文本（按卡；遗留走老口径） */
  function durationTextOf(anneal: Pick<Anneal, 'pieceId' | 'cardVersionId'>): string {
    return formatHours(hoursOf(anneal))
  }

  /** 排位版本是否与当前生效卡对得上账 */
  function isCurrent(anneal: Anneal): boolean {
    return isCardVersionCurrent(anneal, cards.value)
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, pieceRows, batchRows, cardRows] = await Promise.all([
            db.anneals.toArray(),
            db.pieces.toArray(),
            db.batches.toArray(),
            db.annealCards.toArray(),
          ])
          return { annealRows, pieceRows, batchRows, cardRows }
        }).subscribe({
          next: ({ annealRows, pieceRows, batchRows, cardRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            batches.value = batchRows
            cards.value = cardRows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  /** 新建排位：挑卡 → 冻结卡版本 → 时段按卡推算 → 冲突禁提交 */
  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    const card = cardById.value.get(draft.cardVersionId)
    if (card === undefined) {
      lastMessage.value = '请先选择一张退火工艺卡再排窑位。'
      return null
    }
    const candidate = {
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      cardVersionId: draft.cardVersionId,
      pieceId: draft.pieceId,
    }
    const conflict = checkSlotConflict(anneals.value, candidate, (item) => hoursOf(item))
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return null
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      cardVersionId: card.id,
      cardKey: card.cardKey,
      cardVersion: card.version,
      curveSeg: '缓冷',
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: '待入窑',
      // 排定窑位即为已排（待确认/待排由重算或手工退回产生）
      scheduleState: '已排',
      legacy: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = `已按「${card.name} v${card.version}」排定窑位 ${row.kilnSlot}，预计出炉时段按该卡三段合计 ${formatHours(
      cardTotalHours(card),
    )} 推算。`
    return row
  }

  /** 仅允许编辑未进窑、非遗留的排位 */
  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined || existing.legacy || existing.state !== '待入窑') return false
    const card = cardById.value.get(draft.cardVersionId)
    if (card === undefined) {
      lastMessage.value = '请选择一张有效的退火工艺卡。'
      return false
    }
    const candidate = {
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      cardVersionId: draft.cardVersionId,
      pieceId: draft.pieceId,
    }
    const conflict = checkSlotConflict(anneals.value, candidate, (item) => hoursOf(item), annealId)
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return false
    }
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      cardVersionId: card.id,
      cardKey: card.cardKey,
      cardVersion: card.version,
      inAt: draft.inAt,
      outAt: draft.outAt,
      scheduleState: draft.kilnSlot === '' ? '待排' : '已排',
    })
    revision.value += 1
    lastMessage.value = '退火排位已更新并按所选卡版本重算时段'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火排位已删除'
  }

  /** 推进退火状态；进窑即冻结卡版本，出炉写回时间 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined || existing.legacy) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    const next = ANNEAL_STATE_FLOW[index + 1]
    if (next === '退火中' && existing.scheduleState !== '已排' && existing.scheduleState !== '已进窑') {
      lastMessage.value = '该排位尚未排定（待排 / 待确认），不能进窑。'
      return null
    }
    await advanceAnnealState(annealId, next, nowLocalInput())
    revision.value += 1
    lastMessage.value =
      next === '已出炉'
        ? '已登记出炉，按进窑时冻结的卡版本烧完，作品状态回写为「已退火」'
        : `已进窑，卡版本 v${existing.cardVersion} 冻结，卡后续升版不影响本窑`
    return next
  }

  /** 手工退回待排（释放窑位） */
  async function sendBackToQueue(annealId: string): Promise<void> {
    await returnToQueue(annealId)
    revision.value += 1
    lastMessage.value = '已退回待排，窑位占位已释放'
  }

  /** 处理待确认排位：按当前生效卡重算（撞窑位则退回待排） */
  async function resolve(annealId: string): Promise<ScheduleState | null> {
    const next = await resolveSchedule(annealId)
    revision.value += 1
    if (next === '待确认') lastMessage.value = '当前仍无适用的生效卡覆盖该件壁厚，保持待确认，请先补卡。'
    else if (next === '待排') lastMessage.value = '已按新版重算但窑位冲突，退回待排重新排窑。'
    else lastMessage.value = '已按当前生效卡版本对齐。'
    return next
  }

  /** 全量按卡版本对账 */
  async function reconcile(): Promise<number> {
    const flagged = await reconcileSchedules()
    revision.value += 1
    lastMessage.value = flagged > 0 ? `对账完成：${flagged} 条未进窑排位版本对不上，已置待确认。` : '对账完成：未进窑排位均与生效卡版本一致。'
    return flagged
  }

  return {
    anneals,
    pieces,
    batches,
    cards,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    stats,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    visibleAnneals,
    pieceOf,
    glassTypeOfPiece,
    cardOfAnneal,
    suggestedCard,
    hoursOf,
    conflictOf,
    expectedOutAt,
    durationTextOf,
    isCurrent,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
    sendBackToQueue,
    resolve,
    reconcile,
  }
})
