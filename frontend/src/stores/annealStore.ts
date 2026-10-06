/**
 * 退火窑位与排位状态管理（Pinia）
 * 维护窑位占用表；排位挂退火工艺卡版本，时间窗按该版推算。
 * 窑位冲突时禁止提交；卡升版撞位的排位退回待排；对账不通过的排位待确认；
 * 只读旧排位（升级套不上卡）禁止任何改动；出炉即回写作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { AnnealCard, ScheduleStatus } from '../types/card'
import { SCHEDULE_STATUS_OPTIONS } from '../types/card'
import type { Piece } from '../types/piece'
import {
  ROW_REVISION,
  advanceAnnealState,
  confirmSchedule,
  db,
  initDatabase,
  putAnneal,
  reconcileSchedules,
  removeAnneal,
  resubmitBounced,
} from '../utils/db'
import {
  cardAnnealWindow,
  cardPhaseHours,
  cardTotalHours,
  checkSlotConflict,
  formatHours,
  type AnnealContext,
  type SlotConflict,
} from '../utils/card'
import { kilnSlots } from '../utils/thermal'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  scheduleStatus: ScheduleStatus | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
}

/** 窑位占用行 */
export interface SlotOccupancy {
  kilnSlot: string
  annealId: string
  pieceId: string
  pieceName: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  scheduleStatus: ScheduleStatus
  locked: boolean
  /** 该窑位当前是否被有效（已排且未出炉）记录占用 */
  occupied: boolean
}

const EMPTY_FILTERS: AnnealFilters = {
  keyword: '',
  state: 'all',
  scheduleStatus: 'all',
  curveSeg: 'all',
  kilnCode: 'all',
}

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const cards = ref<AnnealCard[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    anneals.value.forEach((row) => {
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  /** 按版本 id 取卡（含留档旧版） */
  function cardOf(cardVersionId: string): AnnealCard | null {
    return cards.value.find((card) => card.id === cardVersionId) ?? null
  }

  const annealContext = computed<AnnealContext>(() => ({ wallThicknessOf, cardOf }))

  /** 某排位引用的卡版本（可能为已留档旧版或 null） */
  function cardOfAnneal(row: Anneal): AnnealCard | null {
    return cardOf(row.cardVersionId)
  }

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表（待排 / 待确认 / 只读的排位展示但不占窑位） */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .map((row) => {
        const piece = pieces.value.find((item) => item.id === row.pieceId)
        const occupies = row.scheduleStatus === '已排' && !row.locked && row.state !== '已出炉'
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: piece?.name ?? '（作品已删除）',
          curveSeg: row.curveSeg,
          inAt: row.inAt,
          outAt: row.outAt,
          state: row.state,
          scheduleStatus: row.scheduleStatus,
          locked: row.locked,
          occupied: occupies,
        }
      })
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt)),
  )

  const occupiedSlotCount = computed<number>(
    () => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size,
  )
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  /** 退回待排（卡升版撞位） */
  const bouncedRows = computed<Anneal[]>(() => anneals.value.filter((row) => row.scheduleStatus === '待排'))
  /** 对账不通过、搁置待确认 */
  const pendingRows = computed<Anneal[]>(() => anneals.value.filter((row) => row.scheduleStatus === '待确认'))
  /** 升级套不上卡、留成只读的旧排位 */
  const lockedRows = computed<Anneal[]>(() => anneals.value.filter((row) => row.locked))

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.scheduleStatus !== 'all' && row.scheduleStatus !== filters.scheduleStatus) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  /** 窑位冲突检测（编辑时排除自身） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'cardVersionId' | 'pieceId'>,
  ): SlotConflict {
    return checkSlotConflict(anneals.value, candidate, annealContext.value, candidate.id)
  }

  /** 某排位按其所挂卡版本的三段时长汇总；卡缺失时返回空值由页面提示 */
  function durationOfRow(row: Anneal): { hours: number; text: string; missing: boolean } {
    const card = cardOf(row.cardVersionId)
    if (card === null) return { hours: 0, text: '卡版本缺失', missing: true }
    const thickness = wallThicknessOf(row.pieceId)
    const hours = cardTotalHours(card, thickness)
    return { hours, text: formatHours(hours), missing: false }
  }

  /** 给页面用：按指定卡版本 + 壁厚算三段 */
  function phaseHours(card: AnnealCard, pieceId: string, seg: CurveSeg): number {
    return cardPhaseHours(card, seg, wallThicknessOf(pieceId))
  }

  /** 排位的预计出炉时间戳（按卡版本推算）；不可算返回 NaN */
  function expectedOutAt(row: Anneal): number {
    return cardAnnealWindow(row, annealContext.value)[1]
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, pieceRows, cardRows] = await Promise.all([
            db.anneals.toArray(),
            db.pieces.toArray(),
            db.cards.toArray(),
          ])
          return { annealRows, pieceRows, cardRows }
        }).subscribe({
          next: ({ annealRows, pieceRows, cardRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
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

  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    if (cardOf(draft.cardVersionId) === null) {
      lastMessage.value = '请先挑一张退火工艺卡再排位。'
      return null
    }
    const conflict = conflictOf({
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      cardVersionId: draft.cardVersionId,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return null
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      cardVersionId: draft.cardVersionId,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      scheduleStatus: '已排',
      scheduleReason: 'none',
      locked: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    const card = cardOf(draft.cardVersionId)
    lastMessage.value =
      card === null
        ? `已分配窑位 ${row.kilnSlot}`
        : `已分配窑位 ${row.kilnSlot}，按 ${card.name} v${card.version} 全流程 ${formatHours(
            cardTotalHours(card, wallThicknessOf(row.pieceId)),
          )}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    if (existing.locked) {
      lastMessage.value = '这是升级时套不上卡版本的只读旧排位，不能编辑。'
      return false
    }
    if (cardOf(draft.cardVersionId) === null) {
      lastMessage.value = '所选卡版本不存在，请重新挑卡。'
      return false
    }
    const conflict = conflictOf({
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      cardVersionId: draft.cardVersionId,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return false
    }
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      cardVersionId: draft.cardVersionId,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      // 人工重新编辑即视为重新排定，清掉待排 / 待确认
      scheduleStatus: '已排',
      scheduleReason: 'none',
    })
    revision.value += 1
    lastMessage.value = '退火编排已更新'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    if (existing.locked) {
      lastMessage.value = '只读旧排位不能删除，如需处理请先在工艺卡页补齐壁厚区间。'
      return false
    }
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
    return true
  }

  /** 推进退火状态；「已出炉」写回出炉时间并同步作品状态 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    const ok = await advanceAnnealState(annealId, ANNEAL_STATE_FLOW[index + 1], nowLocalInput())
    if (!ok) {
      lastMessage.value = '该排位未处于已排状态（待排 / 待确认 / 只读），不能推进进窑。'
      return null
    }
    revision.value += 1
    const next = ANNEAL_STATE_FLOW[index + 1]
    lastMessage.value =
      next === '已出炉' ? '已登记出炉，作品状态已回写为「已退火」' : `退火状态已推进为「${next}」`
    return next
  }

  /** 待排排位按新版卡重新提交（可调窑位 / 入窑时间 / 卡版本） */
  async function resubmit(
    annealId: string,
    patch: { kilnSlot: string; inAt: string; cardVersionId: string },
  ): Promise<boolean> {
    const result = await resubmitBounced(annealId, patch)
    lastMessage.value = result.message
    revision.value += 1
    return result.ok
  }

  /** 待确认排位人工对账后改挂卡版本 */
  async function confirm(
    annealId: string,
    cardVersionId: string,
    patch?: { kilnSlot?: string; inAt?: string },
  ): Promise<boolean> {
    const result = await confirmSchedule(annealId, cardVersionId, patch)
    lastMessage.value = result.message
    revision.value += 1
    return result.ok
  }

  /** 全量按卡版本对账：引用卡缺失的已排排位搁置为待确认，返回搁置条数 */
  async function reconcile(): Promise<number> {
    const parked = await reconcileSchedules()
    revision.value += 1
    lastMessage.value =
      parked.length === 0 ? '对账完成：全部排位的卡版本均有效。' : `对账完成：${parked.length} 条排位卡版本缺失，已搁置待确认。`
    return parked.length
  }

  return {
    anneals,
    pieces,
    cards,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    scheduleStatusOptions: SCHEDULE_STATUS_OPTIONS,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    bouncedRows,
    pendingRows,
    lockedRows,
    visibleAnneals,
    wallThicknessOf,
    cardOf,
    cardOfAnneal,
    conflictOf,
    durationOfRow,
    phaseHours,
    expectedOutAt,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
    resubmit,
    confirm,
    reconcile,
  }
})
