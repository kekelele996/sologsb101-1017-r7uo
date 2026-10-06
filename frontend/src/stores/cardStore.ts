/**
 * 退火工艺卡状态管理（Pinia）
 * 工艺技术组按玻璃种类 + 壁厚区间立卡、调整三段参数；
 * 每调一次另存新版本（旧版置 archived 留档），发布后连带重算未进窑排位。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { AnnealCard, AnnealCardDraft, GlassType } from '../types/card'
import { GLASS_TYPE_OPTIONS } from '../types/card'
import { db, initDatabase, listCards, publishCardVersion } from '../utils/db'
import { activeCards, cardTotalHours, formatHours } from '../utils/thermal'

/** 卡筛选条件 */
export interface CardFilters {
  keyword: string
  glassType: GlassType | 'all'
  scope: 'active' | 'archived' | 'all'
}

const EMPTY_FILTERS: CardFilters = { keyword: '', glassType: 'all', scope: 'active' }

let subscribed = false

export const useCardStore = defineStore('annealCard', () => {
  const cards = ref<AnnealCard[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<CardFilters>({ ...EMPTY_FILTERS })

  /** 当前生效卡（每卡系唯一 active） */
  const activeCardList = computed<AnnealCard[]>(() => activeCards(cards.value))

  const cardById = computed<Map<string, AnnealCard>>(() => new Map(cards.value.map((card) => [card.id, card])))

  /** 卡系列表（以生效版为代表） */
  const cardGroups = computed(() => {
    const groups = new Map<string, { cardKey: string; active?: AnnealCard; versions: AnnealCard[] }>()
    cards.value.forEach((card) => {
      const group = groups.get(card.cardKey) ?? { cardKey: card.cardKey, versions: [] }
      group.versions.push(card)
      if (card.state === 'active') group.active = card
      groups.set(card.cardKey, group)
    })
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        versions: group.versions.sort((a, b) => b.version - a.version),
      }))
      .sort(
        (a, b) =>
          (a.active?.glassType ?? a.versions[0]?.glassType ?? '').localeCompare(
            b.active?.glassType ?? b.versions[0]?.glassType ?? '',
            'zh-Hans-CN',
          ) || (a.active?.minMm ?? 0) - (b.active?.minMm ?? 0),
      )
  })

  const visibleGroups = computed(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return cardGroups.value.filter((group) => {
      const rep = group.active ?? group.versions[0]
      if (rep === undefined) return false
      if (filters.glassType !== 'all' && rep.glassType !== filters.glassType) return false
      if (filters.scope === 'active' && group.active === undefined) return false
      if (filters.scope === 'archived' && group.active !== undefined) return false
      if (keyword === '') return true
      return (
        rep.name.toLowerCase().includes(keyword) ||
        rep.glassType.toLowerCase().includes(keyword) ||
        rep.note.toLowerCase().includes(keyword)
      )
    })
  })

  const stats = computed(() => ({
    total: cards.value.length,
    groups: cardGroups.value.length,
    active: activeCardList.value.length,
    archived: cards.value.filter((card) => card.state === 'archived').length,
  }))

  function getCard(id: string): AnnealCard | undefined {
    return cardById.value.get(id)
  }

  /** 卡的三段合计时长文本 */
  function durationText(card: AnnealCard): string {
    return formatHours(cardTotalHours(card))
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(() => db.annealCards.toArray()).subscribe({
          next: (rows) => {
            cards.value = rows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取工艺卡失败'
            loading.value = false
          },
        })
      }
      cards.value = await listCards()
      ready.value = true
      loading.value = false
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<CardFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  /**
   * 发布卡：cardKey 为空建立新卡系 v1；否则基于该卡系另存新版本。
   * 旧 active 版自动留档；未进窑排位按新版重算。
   */
  async function publish(draft: AnnealCardDraft, cardKey?: string): Promise<AnnealCard | null> {
    try {
      const result = await publishCardVersion(cardKey === undefined ? draft : { ...draft, cardKey })
      revision.value += 1
      lastMessage.value =
        result.card.version === 1
          ? `已建立工艺卡「${result.card.name} v1」`
          : `已发布「${result.card.name} v${result.card.version}」，旧版已留档；重算 ${result.recalculated} 条未进窑排位` +
            (result.bounced > 0 ? `，其中 ${result.bounced} 条撞窑位退回待排` : '') +
            (result.unresolved > 0 ? `，${result.unresolved} 条区间不再覆盖已置待确认` : '')
      return result.card
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '发布工艺卡失败'
      return null
    }
  }

  return {
    cards,
    loading,
    ready,
    error,
    lastMessage,
    revision,
    filters,
    glassTypeOptions: GLASS_TYPE_OPTIONS,
    activeCardList,
    cardGroups,
    visibleGroups,
    stats,
    getCard,
    durationText,
    loadAll,
    setFilters,
    resetFilters,
    publish,
  }
})
