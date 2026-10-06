<script setup lang="ts">
/**
 * /annealing 退火窑位排产
 * 排产员先挑一张退火工艺卡，入窑时段按所选卡版本三段合计时长推算；
 * 卡升版后未进窑排位自动按新版重算（撞窑位退回待排），已进窑冻结原版本；
 * 卡版本对不上账的未进窑排位置「待确认」；老库套不上卡的排位只读留档。
 * 窑位时间窗冲突时禁用提交。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import {
  ANNEAL_STATE_OPTIONS,
  SCHEDULE_STATE_OPTIONS,
  type Anneal,
  type AnnealDraft,
  type AnnealState,
  type ScheduleState,
} from '@/types/anneal'
import { cardSegmentHoursMap, cardTotalHours, formatHours } from '@/utils/thermal'
import { GLASS_TYPE_TAG_TYPE } from '@/types/card'
import { nowLocalInput } from '@/utils/id'

const annealStore = useAnnealStore()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<AnnealDraft>({
  pieceId: '',
  kilnSlot: '',
  cardVersionId: '',
  inAt: nowLocalInput(),
  outAt: '',
  state: '待入窑',
})

const rules: FormRules<AnnealDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  kilnSlot: [{ required: true, message: '请选择窑位', trigger: 'change' }],
  cardVersionId: [{ required: true, message: '请选择退火工艺卡', trigger: 'change' }],
  inAt: [{ required: true, message: '请选择入窑时间', trigger: 'change' }],
}

const pieceName = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
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

/** 当前作品的玻璃种类与壁厚 */
const formPiece = computed(() => pieceStore.pieces.find((row) => row.id === form.pieceId))
const formGlassType = computed(() => (form.pieceId ? annealStore.glassTypeOfPiece(form.pieceId) : null))

/** 该作品可选的生效卡（玻璃种类 + 壁厚命中） */
const cardOptions = computed(() =>
  annealStore.cards
    .filter((card) => card.state === 'active')
    .filter((card) => {
      const piece = formPiece.value
      if (piece === undefined) return false
      return card.glassType === annealStore.glassTypeOfPiece(piece.id) && piece.wallThicknessMm >= card.minMm && piece.wallThicknessMm <= card.maxMm
    })
    .sort((a, b) => b.version - a.version)
)

/** 适用生效卡之外、但编辑旧排位时需要展示的留档版本（同玻璃种类 + 壁厚命中） */
const archivedCardOptions = computed(() => {
  const activeIds = new Set(cardOptions.value.map((card) => card.id))
  return annealStore.cards
    .filter((card) => card.state !== 'active' && !activeIds.has(card.id))
    .filter((card) => {
      const piece = formPiece.value
      if (piece === undefined) return false
      return card.glassType === annealStore.glassTypeOfPiece(piece.id) && piece.wallThicknessMm >= card.minMm && piece.wallThicknessMm <= card.maxMm
    })
    .sort((a, b) => b.version - a.version)
})

const formCard = computed(() => annealStore.cards.find((card) => card.id === form.cardVersionId))

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

/** 按卡推算的预计出炉时间与三段时长 */
const expectedOutText = computed(() => {
  const stamp = annealStore.expectedOutAt(form.cardVersionId, form.inAt)
  if (Number.isNaN(stamp)) return '—'
  const d = new Date(stamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

const formDuration = computed(() => {
  const card = formCard.value
  if (card === undefined) return { total: '—', heat: '—', hold: '—', cool: '—' }
  const seg = cardSegmentHoursMap(card)
  return {
    total: formatHours(cardTotalHours(card)),
    heat: formatHours(seg.升温),
    hold: formatHours(seg.保温),
    cool: formatHours(seg.缓冷),
  }
})

const stats = computed(() => ({
  total: annealStore.stats.total,
  queue: annealStore.stats.queue,
  scheduled: annealStore.stats.scheduled,
  pending: annealStore.stats.pending,
  firing: annealStore.stats.firing,
  done: annealStore.stats.done,
}))

onMounted(() => {
  void annealStore.loadAll()
  void pieceStore.loadAll()
  void furnaceStore.loadAll()
})

function pickSuggestedCard(): void {
  if (form.pieceId === '') return
  const suggested = annealStore.suggestedCard(form.pieceId)
  form.cardVersionId = suggested?.id ?? cardOptions.value[0]?.id ?? ''
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    pieceId: pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? '',
    kilnSlot: slotOptions.value[0] ?? 'AN-01-A1',
    cardVersionId: '',
    inAt: nowLocalInput(),
    outAt: '',
    state: '待入窑' as AnnealState,
  })
  pickSuggestedCard()
  dialogVisible.value = true
}

function openEdit(row: Anneal): void {
  if (row.legacy || row.state !== '待入窑') return
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    kilnSlot: row.kilnSlot,
    cardVersionId: row.cardVersionId,
    inAt: row.inAt,
    outAt: row.outAt,
    state: row.state,
  })
  // 原卡若已不在适用生效卡中：优先保留它本身（留档卡也在下方分组可见），否则回落生效卡
  const allShown = [...cardOptions.value, ...archivedCardOptions.value]
  if (form.cardVersionId === '' || !allShown.some((card) => card.id === form.cardVersionId)) {
    pickSuggestedCard()
  }
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (formCard.value === undefined) {
    ElMessage.error('请选择一张适用于该作品玻璃种类与壁厚的生效工艺卡')
    return
  }
  if (conflict.value.conflict) {
    ElMessage.error(conflict.value.message)
    return
  }
  submitting.value = true
  try {
    if (editingId.value === null) {
      const row = await annealStore.createAnneal({ ...form, outAt: '', state: '待入窑' })
      if (row === null) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(`已按「${formCard.value.name} v${formCard.value.version}」排定窑位 ${row.kilnSlot}`)
    } else {
      const ok = await annealStore.updateAnneal(editingId.value, { ...form, state: '待入窑' })
      if (!ok) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success('退火排位已更新')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Anneal): Promise<void> {
  if (row.legacy) return
  try {
    await ElMessageBox.confirm(`确认删除窑位 ${row.kilnSlot || '（待排）'} 的退火排位？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await annealStore.deleteAnneal(row.id)
  ElMessage.success('退火排位已删除')
}

async function handleAdvance(row: Anneal): Promise<void> {
  const next = await annealStore.advance(row.id)
  if (next === null) {
    ElMessage.info('该排位不可推进（已出炉 / 待排待确认 / 遗留只读）')
    return
  }
  ElMessage.success(annealStore.lastMessage)
}

async function handleSendBack(row: Anneal): Promise<void> {
  await annealStore.sendBackToQueue(row.id)
  ElMessage.success(annealStore.lastMessage)
}

async function handleResolve(row: Anneal): Promise<void> {
  const next = await annealStore.resolve(row.id)
  if (next === null) return
  ElMessage.success(annealStore.lastMessage)
}

async function handleReconcile(): Promise<void> {
  await annealStore.reconcile()
  ElMessage.success(annealStore.lastMessage)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'scheduleState') annealStore.setFilters({ scheduleState: value as ScheduleState | 'all' })
  if (key === 'state') annealStore.setFilters({ state: value as AnnealState | 'all' })
  if (key === 'kilnCode') annealStore.setFilters({ kilnCode: value })
}

function scheduleTagType(state: ScheduleState): 'info' | 'primary' | 'warning' | 'success' {
  return state === '待排' ? 'info' : state === '已排' ? 'primary' : state === '待确认' ? 'warning' : 'success'
}

function cardDisplay(row: Anneal): { name: string; outdated: boolean } {
  const card = annealStore.cardOfAnneal(row)
  if (row.legacy) return { name: '遗留只读 · 无卡版本', outdated: true }
  if (card === undefined) return { name: `卡版本缺失（v${row.cardVersion}）`, outdated: true }
  return { name: `${card.name} · v${row.cardVersion}`, outdated: !annealStore.isCurrent(row) }
}

function expectedOutOfRow(row: Anneal): string {
  if (row.outAt !== '') return row.outAt.replace('T', ' ')
  const card = annealStore.cardOfAnneal(row)
  if (card === undefined) return '—'
  const stamp = new Date(row.inAt).getTime() + cardTotalHours(card) * 3600 * 1000
  const d = new Date(stamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="排位总数" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="待排" :value="stats.queue" suffix="条" tone="info" icon="DataLine" />
      <StatBadge label="已排待进窑" :value="stats.scheduled" suffix="条" tone="primary" icon="TrendCharts" />
      <StatBadge label="待确认" :value="stats.pending" suffix="条" tone="warning" icon="Warning" />
      <StatBadge label="退火中" :value="stats.firing" suffix="条" tone="warning" icon="Sunny" />
      <StatBadge label="已出炉" :value="stats.done" suffix="条" tone="success" icon="PieChart" />
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
      v-if="annealStore.lastMessage !== ''"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      :title="annealStore.lastMessage"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火窑位排产（按工艺卡版本推算时段）</span>
          <el-space wrap>
            <el-button @click="handleReconcile">
              <el-icon><Connection /></el-icon>
              <span>按卡版本对账</span>
            </el-button>
            <el-button
              type="primary"
              @click="openCreate"
              :disabled="pieceStore.pieces.length === 0 || slotOptions.length === 0"
            >
              <el-icon><Plus /></el-icon>
              <span>挑卡排窑位</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="annealStore.filters.keyword"
        :fields="[
          { key: 'scheduleState', label: '排产状态', options: SCHEDULE_STATE_OPTIONS as unknown as string[] },
          { key: 'state', label: '窑内状态', options: ANNEAL_STATE_OPTIONS as unknown as string[] },
          { key: 'kilnCode', label: '退火窑', options: annealStore.kilnCodes },
        ]"
        :values="{
          scheduleState: annealStore.filters.scheduleState,
          state: annealStore.filters.state,
          kilnCode: annealStore.filters.kilnCode,
        }"
        :result-text="`命中 ${annealStore.visibleAnneals.length} / ${annealStore.anneals.length} 条`"
        @update:keyword="(value: string) => annealStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="annealStore.resetFilters()"
      />

      <EmptyPanel
        v-if="annealStore.ready && annealStore.anneals.length === 0"
        title="还没有退火排位"
        description="先在「工艺卡」里确认玻璃种类与壁厚对应的生效卡，再为作品挑卡排窑位；入窑/出炉时段按所选卡版本三段合计时长推算。"
        action-text="排第一个窑位"
        @action="openCreate"
      />

      <el-table v-else v-loading="!annealStore.ready" :data="annealStore.visibleAnneals" row-key="id" stripe>
        <el-table-column label="作品" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceName[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <span class="cell-sub">
                壁厚 {{ annealStore.pieceOf(row.pieceId)?.wallThicknessMm ?? '—' }} mm ·
                <el-tag
                  v-if="annealStore.glassTypeOfPiece(row.pieceId)"
                  size="small"
                  effect="plain"
                  :type="GLASS_TYPE_TAG_TYPE[annealStore.glassTypeOfPiece(row.pieceId)]"
                >
                  {{ annealStore.glassTypeOfPiece(row.pieceId) }}
                </el-tag>
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="退火工艺卡" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">{{ cardDisplay(row).name }}</span>
              <el-tag v-if="cardDisplay(row).outdated" size="small" type="warning" effect="plain">
                {{ row.legacy ? '只读留档' : '版本待对账' }}
              </el-tag>
              <el-tag v-else size="small" type="success" effect="plain">当前生效版</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="窑位" width="110">
          <template #default="{ row }">
            <span v-if="row.kilnSlot === ''" class="cell-sub">待排</span>
            <span v-else>{{ row.kilnSlot }}</span>
          </template>
        </el-table-column>
        <el-table-column label="总时长" width="110" align="right">
          <template #default="{ row }">{{ annealStore.durationTextOf(row) }}</template>
        </el-table-column>
        <el-table-column label="入窑" width="150">
          <template #default="{ row }">{{ row.inAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="预计/实际出炉" width="160">
          <template #default="{ row }">
            <span :class="{ 'cell-sub': row.outAt === '' }">{{ expectedOutOfRow(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="窑内状态" width="100">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.state === '已出炉' ? 'success' : row.state === '退火中' ? 'warning' : 'info'"
              effect="dark"
            >
              {{ row.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="排产状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="scheduleTagType(row.scheduleState)">{{ row.scheduleState }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="270" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              :disabled="row.legacy || (row.scheduleState !== '已排' && row.scheduleState !== '已进窑')"
              @click="handleAdvance(row)"
            >
              推进状态
            </el-button>
            <el-button
              v-if="row.scheduleState === '待确认'"
              link
              type="warning"
              size="small"
              :disabled="row.legacy || row.state !== '待入窑'"
              @click="handleResolve(row)"
            >
              按新版对齐
            </el-button>
            <el-button
              v-else
              link
              type="info"
              size="small"
              :disabled="row.legacy || row.state !== '待入窑' || row.scheduleState === '待排'"
              @click="handleSendBack(row)"
            >
              退回待排
            </el-button>
            <el-button link type="primary" size="small" :disabled="row.legacy || row.state !== '待入窑'" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="row.legacy" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">窑位占用表（待排 / 待确认不占位）</span>
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
            <div class="slot-detail">
              {{ row.pieceName }} · {{ row.cardName }} · {{ row.state }}
            </div>
          </template>
          <div v-if="annealStore.occupancy.filter((item) => item.kilnSlot === slot).length === 0" class="slot-detail is-free">
            空闲
          </div>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '挑卡排退火窑位' : '编辑退火排位'" width="720px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="作品" prop="pieceId">
              <el-select v-model="form.pieceId" filterable style="width: 100%" @change="pickSuggestedCard">
                <el-option
                  v-for="item in pieceStore.pieces"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.name} · ${item.craft} · 壁厚 ${item.wallThicknessMm} mm`"
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
        <el-row :gutter="12">
          <el-col :span="14">
            <el-form-item label="退火工艺卡" prop="cardVersionId">
              <el-select v-model="form.cardVersionId" style="width: 100%" placeholder="按玻璃种类与壁厚筛选生效卡">
                <el-option-group label="当前生效">
                  <el-option
                    v-for="card in cardOptions"
                    :key="card.id"
                    :value="card.id"
                    :label="`${card.name} v${card.version}（${card.minMm}–${card.maxMm} mm · 合计 ${formatHours(cardTotalHours(card))}）`"
                  />
                </el-option-group>
                <el-option-group v-if="archivedCardOptions.length > 0" label="留档旧版（仅供查看/沿用）">
                  <el-option
                    v-for="card in archivedCardOptions"
                    :key="card.id"
                    :value="card.id"
                    :label="`${card.name} v${card.version}（留档）`"
                  />
                </el-option-group>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="10">
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
        </el-row>

        <el-alert
          v-if="formPiece && formGlassType"
          type="info"
          :closable="false"
          class="mb-10"
          :title="`作品料性：${formGlassType} · 壁厚 ${formPiece.wallThicknessMm} mm${cardOptions.length === 0 ? '（当前没有覆盖该壁厚的生效卡，请先到工艺卡页立卡）' : ''}`"
        />

        <el-alert
          v-if="formCard"
          type="success"
          show-icon
          :closable="false"
          :title="`按「${formCard.name} v${formCard.version}」推算：升温 ${formDuration.heat} / 保温 ${formDuration.hold} / 缓冷 ${formDuration.cool}，合计 ${formDuration.total}`"
          :description="`预计出炉时间：${expectedOutText}（进窑后冻结此卡版本，卡后续升版不影响本窑）`"
        />
        <el-alert
          v-if="conflict.conflict"
          type="error"
          show-icon
          :closable="false"
          title="窑位冲突，无法提交"
          :description="conflict.message"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="conflict.conflict || !form.cardVersionId"
          @click="handleSubmit"
        >
          保存
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

.cell-strong {
  font-weight: 600;
  color: #1d2b3a;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
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

.slot-detail.is-free {
  color: #a8b0b8;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}

.mb-10 {
  margin-bottom: 10px;
}
</style>
