/**
 * 退火工艺卡状态管理（Pinia）
 * 维护全部卡版本（含留档）；新建卡族、调参升版（旧版留档、未进窑排位自动重算）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { AnnealCard, AnnealCardDraft, GlassKind } from '../types/card'
import {
  createCard,
  db,
  initDatabase,
  listCards,
  publishCardRevision,
} from '../utils/db'
import {
  activeOfFamily,
  cardFamilyName,
  familyVersions,
  matchActiveCard,
  wallBandText,
} from '../utils/card'
import type { Piece } from '../types/piece'

let subscribed = false

export const useCardStore = defineStore('card', () => {
  const cards = ref<AnnealCard[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')

  /** 在用卡（供排位挑卡） */
  const activeCards = computed<AnnealCard[]>(() =>
    cards.value
      .filter((card) => card.status === 'active')
      .sort(
        (a, b) =>
          a.glassKind.localeCompare(b.glassKind, 'zh-Hans-CN') ||
          a.wallMinMm - b.wallMinMm ||
          b.version - a.version,
      ),
  )

  /** 卡族分组（每组取在用版作为代表，含版本数） */
  const families = computed(() => {
    const map = new Map<string, { familyKey: string; active: AnnealCard | null; versions: AnnealCard[] }>()
    cards.value.forEach((card) => {
      const group = map.get(card.familyKey) ?? { familyKey: card.familyKey, active: null, versions: [] }
      group.versions.push(card)
      if (card.status === 'active') group.active = card
      map.set(card.familyKey, group)
    })
    return Array.from(map.values())
      .map((group) => ({ ...group, versions: familyVersions(cards.value, group.familyKey) }))
      .sort(
        (a, b) =>
          (a.active?.glassKind ?? '').localeCompare(b.active?.glassKind ?? '', 'zh-Hans-CN') ||
          (a.active?.wallMinMm ?? 0) - (b.active?.wallMinMm ?? 0),
      )
  })

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(() => db.cards.toArray()).subscribe({
          next: (rows) => {
            cards.value = rows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火工艺卡失败'
            loading.value = false
          },
        })
      } else {
        cards.value = await listCards()
        loading.value = false
        ready.value = true
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化工艺卡数据失败'
      loading.value = false
    }
  }

  function versionsOf(familyKey: string): AnnealCard[] {
    return familyVersions(cards.value, familyKey)
  }

  function activeCardOf(familyKey: string): AnnealCard | null {
    return activeOfFamily(cards.value, familyKey)
  }

  /** 按作品玻璃种类 + 壁厚挑在用卡 */
  function matchCard(piece: Pick<Piece, 'glassKind' | 'wallThicknessMm'>): AnnealCard | null {
    return matchActiveCard(cards.value, piece.glassKind, piece.wallThicknessMm)
  }

  function cardById(id: string): AnnealCard | null {
    return cards.value.find((card) => card.id === id) ?? null
  }

  /** 某作品的候选卡：同类在用卡优先，其余种类附后并标注 */
  function optionsForPiece(piece: Pick<Piece, 'glassKind' | 'wallThicknessMm'>): AnnealCard[] {
    const matched = matchCard(piece)
    const preferred = matched !== null ? [matched] : []
    const rest = activeCards.value.filter((card) => !preferred.some((item) => item.id === card.id))
    return [...preferred, ...rest]
  }

  async function createFamily(draft: AnnealCardDraft): Promise<AnnealCard | null> {
    try {
      const card = await createCard(draft)
      lastMessage.value = `已新建工艺卡族「${cardFamilyName(card.glassKind, card.wallMinMm, card.wallMaxMm)}」v${card.version}`
      return card
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '新建工艺卡失败'
      return null
    }
  }

  /**
   * 调参升版：旧版留档，未进窑排位自动按新版重算，撞窑位的退回待排。
   * 返回撞位退回的件数（0 表示全部重算成功）。
   */
  async function revise(familyKey: string, draft: AnnealCardDraft): Promise<{ card: AnnealCard | null; bouncedCount: number }> {
    try {
      const result = await publishCardRevision(familyKey, draft)
      lastMessage.value =
        result.bounced.length === 0
          ? `已发布 v${result.card.version}，未进窑排位均已按新版重算。`
          : `已发布 v${result.card.version}：${result.bounced.length} 条排位撞窑位，已退回待排。`
      return { card: result.card, bouncedCount: result.bounced.length }
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '工艺卡升版失败'
      return { card: null, bouncedCount: 0 }
    }
  }

  /** 卡区间文本（供页面直接使用） */
  function bandText(card: Pick<AnnealCard, 'wallMinMm' | 'wallMaxMm'>): string {
    return wallBandText(card.wallMinMm, card.wallMaxMm)
  }

  /** 玻璃种类筛选下的卡族 */
  function familiesOfKind(kind: GlassKind | 'all') {
    if (kind === 'all') return families.value
    return families.value.filter((group) => group.active?.glassKind === kind)
  }

  return {
    cards,
    loading,
    ready,
    error,
    lastMessage,
    activeCards,
    families,
    loadAll,
    versionsOf,
    activeCardOf,
    matchCard,
    cardById,
    optionsForPiece,
    createFamily,
    revise,
    bandText,
    familiesOfKind,
  }
})
