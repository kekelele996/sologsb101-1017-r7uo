<script setup lang="ts">
/**
 * /annealing 退火窑位分配与曲线编排
 * 排窑位先挑一张退火工艺卡（按作品玻璃种类 + 壁厚默认选中在用版），时段照该卡版本推算；
 * 窑位冲突时禁用提交；卡升版后撞位的排位退回待排、对账不通过的待确认，在此处理；
 * 只读旧排位禁止改动；出炉即回写作品状态为「已退火」。
 * 消费模型：Anneal、Piece、Furnace、AnnealCard；复用组件：<FilterBar>、<StatBadge>、<StageTag>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useCardStore } from '@/stores/cardStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { ANNEAL_STATE_OPTIONS, CURVE_SEG_OPTIONS, type Anneal, type AnnealDraft, type AnnealState, type CurveSeg } from '@/types/anneal'
import { SCHEDULE_STATUS_OPTIONS, SCHEDULE_REASON_TEXT, type AnnealCard, type ScheduleReason, type ScheduleStatus } from '@/types/card'
import { cardPhaseHours, cardTotalHours, cardVersionLabel, formatHours, wallBandText } from '@/utils/card'
import { nowLocalInput } from '@/utils/id'

const annealStore = useAnnealStore()
const cardStore = useCardStore()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

/** 待排重排 / 待确认对账弹窗 */
const reviewVisible = ref(false)
const reviewMode = ref<'bounced' | 'pending'>('bounced')
const reviewingId = ref<string | null>(null)
const reviewForm = reactive<{ cardVersionId: string; kilnSlot: string; inAt: string }>({
  cardVersionId: '',
  kilnSlot: '',
  inAt: '',
})

const form = reactive<AnnealDraft>({
  pieceId: '',
  kilnSlot: '',
  curveSeg: '缓冷' as CurveSeg,
  cardVersionId: '',
  inAt: nowLocalInput(),
  outAt: '',
  state: '待入窑',
})

const rules: FormRules<AnnealDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  kilnSlot: [{ required: true, message: '请选择窑位', trigger: 'change' }],
  curveSeg: [{ required: true, message: '请选择曲线段', trigger: 'change' }],
  cardVersionId: [{ required: true, message: '请挑一张退火工艺卡', trigger: 'change' }],
  inAt: [{ required: true, message: '请选择入窑时间', trigger: 'change' }],
  state: [{ required: true, message: '请选择退火状态', trigger: 'change' }],
}

const pieceName = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.glassKind} · ${row.craft}`]))
)

const pieceById = computed<Record<string, (typeof pieceStore.pieces)[number]>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, row]))
)

const slotOptions = computed<string[]>(() => {
  const codes = furnaceStore.annealingFurnaces.map((row) => row.code)
  if (codes.length === 0) return annealStore.allSlots
  const list: string[] = []
  codes.forEach((code) => {
    for (let index = 0; index < 9; index += 1) {
      const row = String.fromCharCode(65 + Math.floor(index / 3))
      list.push(`${code}-${row}${(index % 3) + 1}`)
    }
  })
  return list
})

/** 当前作品可挑的卡：同类匹配的在用版排首位 */
const cardOptions = computed<AnnealCard[]>(() => {
  const piece = pieceById.value[form.pieceId]
  if (piece === undefined) return cardStore.activeCards
  return cardStore.optionsForPiece(piece)
})

const selectedCard = computed<AnnealCard | null>(() => cardStore.cardById(form.cardVersionId))

/** 当前表单的窑位冲突检测结果，冲突时禁用提交 */
const conflict = computed(() =>
  annealStore.conflictOf({
    id: editingId.value ?? '',
    kilnSlot: form.kilnSlot,
    inAt: form.inAt,
    outAt: form.outAt,
    cardVersionId: form.cardVersionId,
    pieceId: form.pieceId,
  })
)

const formDuration = computed(() => {
  const piece = pieceById.value[form.pieceId]
  const thickness = piece?.wallThicknessMm ?? 4
  const card = selectedCard.value
  if (card === null) {
    return { segment: '—', total: '—', hint: '请先挑一张退火工艺卡。', cardLabel: '' }
  }
  return {
    segment: formatHours(cardPhaseHours(card, form.curveSeg, thickness)),
    total: formatHours(cardTotalHours(card, thickness)),
    hint: card.phases.find((item) => item.phase === form.curveSeg)?.hint ?? '',
    cardLabel: cardVersionLabel(card),
  }
})

/** 选中作品时自动带出匹配的在用卡 */
function syncDefaultCard(): void {
  const piece = pieceById.value[form.pieceId]
  if (piece === undefined) {
    form.cardVersionId = ''
    return
  }
  const matched = cardStore.matchCard(piece)
  form.cardVersionId = matched?.id ?? cardStore.activeCards[0]?.id ?? ''
}

const stats = computed(() => ({
  total: annealStore.anneals.length,
  waiting: annealStore.anneals.filter((row) => row.state === '待入窑' && row.scheduleStatus === '已排').length,
  firing: annealStore.anneals.filter((row) => row.state === '退火中').length,
  done: annealStore.anneals.filter((row) => row.state === '已出炉').length,
  bounced: annealStore.bouncedRows.length,
  pending: annealStore.pendingRows.length,
}))

onMounted(() => {
  void annealStore.loadAll()
  void pieceStore.loadAll()
  void furnaceStore.loadAll()
  void cardStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  const firstPiece = pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? ''
  Object.assign(form, {
    pieceId: firstPiece,
    kilnSlot: slotOptions.value[0] ?? 'AN-01-A1',
    curveSeg: '缓冷' as CurveSeg,
    inAt: nowLocalInput(),
    outAt: '',
    state: '待入窑' as AnnealState,
  })
  syncDefaultCard()
  dialogVisible.value = true
}

function openEdit(row: Anneal): void {
  if (row.locked) {
    ElMessage.warning('这是升级时套不上卡版本的只读旧排位，不能编辑。')
    return
  }
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    kilnSlot: row.kilnSlot,
    curveSeg: row.curveSeg,
    cardVersionId: row.cardVersionId,
    inAt: row.inAt,
    outAt: row.outAt,
    state: row.state,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (conflict.value.conflict) {
    ElMessage.error(conflict.value.message)
    return
  }
  submitting.value = true
  try {
    if (editingId.value === null) {
      const row = await annealStore.createAnneal({ ...form })
      if (row === null) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(`已分配窑位 ${row.kilnSlot}`)
    } else {
      const ok = await annealStore.updateAnneal(editingId.value, { ...form })
      if (!ok) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success('退火编排已更新')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Anneal): Promise<void> {
  if (row.locked) {
    ElMessage.warning('只读旧排位不能删除。')
    return
  }
  try {
    await ElMessageBox.confirm(`确认删除窑位 ${row.kilnSlot} 的退火记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  const ok = await annealStore.deleteAnneal(row.id)
  if (ok) ElMessage.success('退火记录已删除')
  else ElMessage.error(annealStore.lastMessage)
}

async function handleAdvance(row: Anneal): Promise<void> {
  const next = await annealStore.advance(row.id)
  if (next === null) {
    ElMessage.info(annealStore.lastMessage || '该记录已处于「已出炉」状态')
    return
  }
  ElMessage.success(annealStore.lastMessage)
}

/* --------------------------- 待排重排 / 待确认对账 --------------------------- */

const reviewConflict = computed(() => {
  if (reviewingId.value === null) return { conflict: false, message: '' }
  return annealStore.conflictOf({
    id: reviewingId.value,
    kilnSlot: reviewForm.kilnSlot,
    inAt: reviewForm.inAt,
    outAt: '',
    cardVersionId: reviewForm.cardVersionId,
    pieceId: annealStore.anneals.find((row) => row.id === reviewingId.value)?.pieceId ?? '',
  })
})

const reviewCardOptions = computed<AnnealCard[]>(() => {
  const row = annealStore.anneals.find((item) => item.id === reviewingId.value)
  const piece = row === undefined ? undefined : pieceById.value[row.pieceId]
  if (piece === undefined) return cardStore.activeCards
  return cardStore.optionsForPiece(piece)
})

function openReview(row: Anneal): void {
  reviewingId.value = row.id
  reviewMode.value = row.scheduleStatus === '待排' ? 'bounced' : 'pending'
  const piece = pieceById.value[row.pieceId]
  const matched = piece === undefined ? null : cardStore.matchCard(piece)
  reviewForm.cardVersionId = row.cardVersionId !== '' && cardStore.cardById(row.cardVersionId) !== null
    ? row.cardVersionId
    : matched?.id ?? cardStore.activeCards[0]?.id ?? ''
  reviewForm.kilnSlot = row.kilnSlot
  reviewForm.inAt = row.inAt
  reviewVisible.value = true
}

async function handleReviewSubmit(): Promise<void> {
  if (reviewingId.value === null) return
  if (cardStore.cardById(reviewForm.cardVersionId) === null) {
    ElMessage.error('请挑一张有效的退火工艺卡版本。')
    return
  }
  if (reviewConflict.value.conflict) {
    ElMessage.error(reviewConflict.value.message)
    return
  }
  if (reviewMode.value === 'bounced') {
    const ok = await annealStore.resubmit(reviewingId.value, { ...reviewForm })
    if (!ok) {
      ElMessage.error(annealStore.lastMessage)
      return
    }
  } else {
    const ok = await annealStore.confirm(reviewingId.value, reviewForm.cardVersionId, {
      kilnSlot: reviewForm.kilnSlot,
      inAt: reviewForm.inAt,
    })
    if (!ok) {
      ElMessage.error(annealStore.lastMessage)
      return
    }
  }
  ElMessage.success(annealStore.lastMessage)
  reviewVisible.value = false
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'state') annealStore.setFilters({ state: value as AnnealState | 'all' })
  if (key === 'scheduleStatus') annealStore.setFilters({ scheduleStatus: value as ScheduleStatus | 'all' })
  if (key === 'curveSeg') annealStore.setFilters({ curveSeg: value as CurveSeg | 'all' })
  if (key === 'kilnCode') annealStore.setFilters({ kilnCode: value })
}

async function handleReconcile(): Promise<void> {
  const count = await annealStore.reconcile()
  ElMessage[count === 0 ? 'success' : 'warning'](annealStore.lastMessage)
}

function scheduleTagType(status: ScheduleStatus): 'success' | 'warning' | 'danger' {
  return status === '已排' ? 'success' : status === '待排' ? 'warning' : 'danger'
}

function reasonText(reason: ScheduleReason): string {
  return SCHEDULE_REASON_TEXT[reason]
}

function rowDuration(row: Anneal): { text: string; missing: boolean } {
  return annealStore.durationOfRow(row)
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="退火记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="待入窑" :value="stats.waiting" suffix="条" tone="info" icon="DataLine" />
      <StatBadge label="退火中" :value="stats.firing" suffix="条" tone="warning" icon="TrendCharts" />
      <StatBadge label="已出炉" :value="stats.done" suffix="条" tone="success" icon="PieChart" />
      <StatBadge label="退回待排" :value="stats.bounced" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="待确认" :value="stats.pending" suffix="条" tone="warning" icon="QuestionFilled" />
      <StatBadge
        label="窑位占用率"
        :value="`${annealStore.occupancyRate}%`"
        :percent="annealStore.occupancyRate"
        tone="primary"
        icon="PieChart"
        :hint="`已占用 ${annealStore.occupiedSlotCount} / ${annealStore.allSlots.length} 个窑位`"
      />
    </div>

    <el-alert
      v-if="annealStore.bouncedRows.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`${stats.bounced} 条排位在工艺卡升版后撞了别人窑位，已退回待排，请改窑位 / 改时段后重新提交。`"
    />
    <el-alert
      v-if="annealStore.pendingRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      title="有排位按卡版本对账不通过（引用卡版本缺失），已搁置待确认，先挂一张有效卡再继续。"
    />
    <el-alert
      v-if="annealStore.lockedRows.length > 0"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`${annealStore.lockedRows.length} 条升级前的旧排位按壁厚套不上当时卡版，已留成只读。`"
      description="只读排位只参与对账展示，不占窑位、不能推进或编辑；如需启用，请先到工艺卡页为该玻璃种类补齐壁厚区间。"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火窑位分配与曲线编排</span>
          <el-space wrap>
            <el-button @click="handleReconcile">
              <el-icon><Connection /></el-icon>
              <span>按卡版本对账</span>
            </el-button>
            <el-button
              type="primary"
              @click="openCreate"
              :disabled="pieceStore.pieces.length === 0 || slotOptions.length === 0 || cardStore.activeCards.length === 0"
            >
              <el-icon><Plus /></el-icon>
              <span>分配窑位</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <el-alert
        v-if="cardStore.activeCards.length === 0"
        type="warning"
        show-icon
        :closable="false"
        class="mb-14"
        title="还没有在用的退火工艺卡"
        description="排窑位前先到「退火工艺卡」页按玻璃种类与壁厚区间建卡。"
      />

      <FilterBar
        :keyword="annealStore.filters.keyword"
        :fields="[
          { key: 'state', label: '退火状态', options: ANNEAL_STATE_OPTIONS as unknown as string[] },
          { key: 'scheduleStatus', label: '排位状态', options: SCHEDULE_STATUS_OPTIONS as unknown as string[] },
          { key: 'curveSeg', label: '曲线段', options: CURVE_SEG_OPTIONS as unknown as string[] },
          { key: 'kilnCode', label: '退火窑', options: annealStore.kilnCodes },
        ]"
        :values="{
          state: annealStore.filters.state,
          scheduleStatus: annealStore.filters.scheduleStatus,
          curveSeg: annealStore.filters.curveSeg,
          kilnCode: annealStore.filters.kilnCode,
        }"
        :result-text="`命中 ${annealStore.visibleAnneals.length} / ${annealStore.anneals.length} 条`"
        @update:keyword="(value: string) => annealStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="annealStore.resetFilters()"
      />

      <EmptyPanel
        v-if="annealStore.ready && annealStore.anneals.length === 0"
        title="还没有退火编排"
        description="为已完成全部工序的作品挑一张退火工艺卡并分配窑位；同一窑位时间窗按卡版本推算，重叠时禁止提交。"
        action-text="分配第一个窑位"
        @action="openCreate"
      />

      <el-table v-else v-loading="!annealStore.ready" :data="annealStore.visibleAnneals" row-key="id" stripe>
        <el-table-column label="作品" min-width="210">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceName[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <span class="cell-sub">
                壁厚 {{ annealStore.wallThicknessOf(row.pieceId) }} mm · 全流程 {{ rowDuration(row).text }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="工艺卡版本" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-tag size="small" :type="annealStore.cardOfAnneal(row) === null ? 'danger' : 'info'">
                {{ cardVersionLabel(annealStore.cardOfAnneal(row)) }}
              </el-tag>
              <span v-if="row.cardVersionId !== '' && annealStore.cardOfAnneal(row)?.status === 'archived'" class="cell-sub">
                留档旧版 · 照当初那版烧
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="kilnSlot" label="窑位" width="120" />
        <el-table-column label="曲线段" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.curveSeg === '升温' ? 'warning' : row.curveSeg === '保温' ? 'primary' : 'success'">
              {{ row.curveSeg }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="入窑时间" width="150">
          <template #default="{ row }">{{ row.inAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="预计/实际出炉" width="160">
          <template #default="{ row }">
            <span v-if="row.outAt !== ''">{{ row.outAt.replace('T', ' ') }}</span>
            <span v-else-if="rowDuration(row).missing" class="cell-warn">卡缺失，无法推算</span>
            <span v-else class="cell-sub">
              {{ new Date(annealStore.expectedOutAt(row)).toLocaleString('zh-CN', { hour12: false }) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="退火状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.state === '已出炉' ? 'success' : row.state === '退火中' ? 'warning' : 'info'" effect="dark">
              {{ row.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="排位状态" width="170">
          <template #default="{ row }">
            <el-space direction="vertical" :size="2">
              <el-tag size="small" :type="scheduleTagType(row.scheduleStatus)">
                {{ row.locked ? '只读旧排位' : row.scheduleStatus }}
              </el-tag>
              <span v-if="row.scheduleReason !== 'none'" class="cell-sub">{{ reasonText(row.scheduleReason) }}</span>
            </el-space>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.scheduleStatus === '待排' || row.scheduleStatus === '待确认'"
              link
              type="warning"
              size="small"
              @click="openReview(row)"
            >
              {{ row.scheduleStatus === '待排' ? '重新排位' : '对账确认' }}
            </el-button>
            <el-button
              v-else
              link
              type="primary"
              size="small"
              :disabled="row.locked || row.state === '已出炉' || row.state === '退火中'"
              @click="handleAdvance(row)"
            >
              推进状态
            </el-button>
            <el-button link type="primary" size="small" :disabled="row.locked" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="row.locked" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">窑位占用表（待排 / 待确认 / 只读排位不占窑位）</span>
      </template>
      <div class="slot-grid">
        <div
          v-for="slot in annealStore.allSlots"
          :key="slot"
          class="slot-cell"
          :class="{ 'is-occupied': annealStore.occupancy.some((row) => row.kilnSlot === slot && row.occupied) }"
        >
          <div class="slot-name">{{ slot }}</div>
          <template v-for="row in annealStore.occupancy.filter((item) => item.kilnSlot === slot)" :key="row.annealId">
            <div class="slot-detail" :class="{ 'is-parked': !row.occupied }">
              {{ row.pieceName }} · {{ row.curveSeg }} · {{ row.locked ? '只读' : row.scheduleStatus }} · {{ row.state }}
            </div>
          </template>
          <div v-if="annealStore.occupancy.filter((item) => item.kilnSlot === slot).length === 0" class="slot-detail is-free">
            空闲
          </div>
        </div>
      </div>
    </el-card>

    <!-- 新建 / 编辑排位 -->
    <el-dialog v-model="dialogVisible" :title="editingId === null ? '分配退火窑位' : '编辑退火编排'" width="720px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="作品" prop="pieceId">
              <el-select
                v-model="form.pieceId"
                filterable
                style="width: 100%"
                :disabled="editingId !== null"
                @change="syncDefaultCard"
              >
                <el-option
                  v-for="item in pieceStore.pieces"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.name} · ${item.glassKind} · ${item.craft} · 壁厚 ${item.wallThicknessMm} mm`"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="退火窑位" prop="kilnSlot">
              <el-select v-model="form.kilnSlot" filterable style="width: 100%">
                <el-option v-for="slot in slotOptions" :key="slot" :value="slot" :label="slot" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="退火工艺卡" prop="cardVersionId">
          <el-select v-model="form.cardVersionId" style="width: 100%" placeholder="先挑一张卡（默认选中壁厚匹配的在用版）">
            <el-option
              v-for="card in cardOptions"
              :key="card.id"
              :value="card.id"
              :label="`${cardVersionLabel(card)} · ${card.glassKind} · ${wallBandText(card.wallMinMm, card.wallMaxMm)}`"
            >
              <span>{{ card.name }} v{{ card.version }}</span>
              <span class="cell-sub" style="float: right">
                {{ card.glassKind }} · {{ wallBandText(card.wallMinMm, card.wallMaxMm) }}
              </span>
            </el-option>
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="6">
            <el-form-item label="曲线段" prop="curveSeg">
              <el-select v-model="form.curveSeg" style="width: 100%">
                <el-option v-for="item in CURVE_SEG_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="9">
            <el-form-item label="入窑时间" prop="inAt">
              <el-date-picker
                v-model="form.inAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="9">
            <el-form-item label="出炉时间">
              <el-date-picker
                v-model="form.outAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                placeholder="留空则按卡版本推算"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="退火状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in ANNEAL_STATE_OPTIONS" :key="item" :value="item" :label="item" />
          </el-select>
        </el-form-item>

        <el-alert
          v-if="form.cardVersionId !== '' && selectedCard !== null"
          :type="conflict.conflict ? 'error' : 'success'"
          show-icon
          :closable="false"
          :title="conflict.conflict ? '窑位冲突，无法提交' : `窑位可用 · ${formDuration.cardLabel}`"
          :description="
            conflict.conflict
              ? conflict.message
              : `当前曲线段「${form.curveSeg}」理论时长 ${formDuration.segment}，该作品按卡全流程退火 ${formDuration.total}。${formDuration.hint}`
          "
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="conflict.conflict" @click="handleSubmit">
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- 待排重排 / 待确认对账 -->
    <el-dialog
      v-model="reviewVisible"
      :title="reviewMode === 'bounced' ? '退回待排：按新版卡重新排位' : '对账确认：改挂有效卡版本'"
      width="620px"
    >
      <el-form label-width="120px">
        <el-form-item label="退火工艺卡">
          <el-select v-model="reviewForm.cardVersionId" style="width: 100%">
            <el-option
              v-for="card in reviewCardOptions"
              :key="card.id"
              :value="card.id"
              :label="`${cardVersionLabel(card)} · ${wallBandText(card.wallMinMm, card.wallMaxMm)}`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="退火窑位">
          <el-select v-model="reviewForm.kilnSlot" filterable style="width: 100%">
            <el-option v-for="slot in slotOptions" :key="slot" :value="slot" :label="slot" />
          </el-select>
        </el-form-item>
        <el-form-item label="入窑时间">
          <el-date-picker
            v-model="reviewForm.inAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            format="YYYY-MM-DD HH:mm"
            style="width: 100%"
          />
        </el-form-item>
        <el-alert
          :type="reviewConflict.conflict ? 'error' : 'success'"
          show-icon
          :closable="false"
          :title="reviewConflict.conflict ? '该窑位时段仍与他人冲突' : '窑位时段可用'"
          :description="reviewConflict.conflict ? reviewConflict.message : '提交后排位恢复为「已排 · 待入窑」。'"
        />
      </el-form>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button type="primary" :disabled="reviewConflict.conflict" @click="handleReviewSubmit">
          {{ reviewMode === 'bounced' ? '重新提交排位' : '确认对账' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  font-size: 12px;
  color: #c0392b;
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
}

.slot-cell {
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafcff;
}

.slot-cell.is-occupied {
  border-color: #f0b27a;
  background: #fff8f1;
}

.slot-name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}

.slot-detail {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #5b6b7a;
}

.slot-detail.is-parked {
  color: #b8860b;
}

.slot-detail.is-free {
  color: #a8b0b8;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
