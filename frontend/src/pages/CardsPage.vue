<script setup lang="ts">
/**
 * /cards 退火工艺卡（工艺技术组维护）
 * 按玻璃种类 + 壁厚区间定义三段升降温速度与保温时长；
 * 每调一次存成一个新版本，旧版自动留档只读；升版会联动重算未进窑排位。
 * 消费模型：AnnealCard、Anneal、Piece；复用组件：<StatBadge>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useCardStore } from '@/stores/cardStore'
import { useAnnealStore } from '@/stores/annealStore'
import {
  ANNEAL_PHASE_OPTIONS,
  GLASS_KIND_OPTIONS,
  type AnnealCard,
  type AnnealCardDraft,
  type AnnealPhase,
  type CardPhase,
  type GlassKind,
} from '@/types/card'
import { validateCardBand, validateCardPhases } from '@/utils/db'
import { cardFamilyName, cardPhaseHours, formatHours, wallBandText } from '@/utils/card'

const cardStore = useCardStore()
const annealStore = useAnnealStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingFamilyKey = ref<string | null>(null)
const editingPrevious = ref<AnnealCard | null>(null)
const showHistoryFor = ref<string | null>(null)
const formRef = ref<FormInstance>()
const kindFilter = ref<GlassKind | 'all'>('all')

interface PhaseForm {
  rateCPerHour: number
  holdHours: number
}

const form = reactive<{
  name: string
  glassKind: GlassKind
  wallMinMm: number
  wallMaxMm: number | null
  openEnded: boolean
  remark: string
  phases: Record<AnnealPhase, PhaseForm>
  annealPointC: number
  heatStartC: number
  coolEndC: number
}>({
  name: '',
  glassKind: '钠钙玻璃',
  wallMinMm: 0,
  wallMaxMm: 8,
  openEnded: false,
  remark: '',
  annealPointC: 560,
  heatStartC: 20,
  coolEndC: 60,
  phases: {
    升温: { rateCPerHour: 120, holdHours: 0 },
    保温: { rateCPerHour: 0, holdHours: 1.2 },
    缓冷: { rateCPerHour: 40, holdHours: 0 },
  },
})

const rules = computed<FormRules>(() => ({
  glassKind: [{ required: true, message: '请选择玻璃种类', trigger: 'change' }],
  wallMinMm: [{ required: true, message: '请填写壁厚下限', trigger: 'blur' }],
  remark: [],
}))

const stats = computed(() => ({
  families: cardStore.families.length,
  active: cardStore.activeCards.length,
  archived: cardStore.cards.filter((card) => card.status === 'archived').length,
  kinds: new Set(cardStore.cards.map((card) => card.glassKind)).size,
}))

const visibleFamilies = computed(() => cardStore.familiesOfKind(kindFilter.value))

function phaseListFromForm(): CardPhase[] {
  const point = form.annealPointC
  return ANNEAL_PHASE_OPTIONS.map((name) => {
    if (name === '升温') {
      return {
        phase: name,
        startC: form.heatStartC,
        endC: point,
        rateCPerHour: form.phases.升温.rateCPerHour,
        holdHours: 0,
        hint: `以 ${form.phases.升温.rateCPerHour} ℃/h 从 ${form.heatStartC} ℃ 升温至 ${point} ℃。`,
      }
    }
    if (name === '保温') {
      return {
        phase: name,
        startC: point,
        endC: point,
        rateCPerHour: 0,
        holdHours: form.phases.保温.holdHours,
        hint: `${point} ℃ 保温，每 5 mm 壁厚 ${form.phases.保温.holdHours} 小时。`,
      }
    }
    return {
      phase: name,
      startC: point,
      endC: form.coolEndC,
      rateCPerHour: form.phases.缓冷.rateCPerHour,
      holdHours: 0,
      hint: `以 ${form.phases.缓冷.rateCPerHour} ℃/h 缓冷至 ${form.coolEndC} ℃。`,
    }
  })
}

const draftFromForm = computed<AnnealCardDraft>(() => ({
  name: cardFamilyName(form.glassKind, form.wallMinMm, form.openEnded ? null : form.wallMaxMm),
  glassKind: form.glassKind,
  wallMinMm: form.wallMinMm,
  wallMaxMm: form.openEnded ? null : form.wallMaxMm,
  remark: form.remark,
  phases: phaseListFromForm(),
}))

const bandCheck = computed(() =>
  validateCardBand(cardStore.cards, draftFromForm.value, editingFamilyKey.value ?? ''),
)
const phaseCheck = computed(() => validateCardPhases(draftFromForm.value))

/** 预览：以 5mm 壁厚折算三段时长 */
const preview = computed(() => {
  const tempCard: AnnealCard = {
    id: 'preview',
    familyKey: 'preview',
    name: draftFromForm.value.name,
    glassKind: draftFromForm.value.glassKind,
    wallMinMm: draftFromForm.value.wallMinMm,
    wallMaxMm: draftFromForm.value.wallMaxMm,
    version: editingPrevious.value ? editingPrevious.value.version + 1 : 1,
    status: 'active',
    supersedesId: '',
    remark: '',
    phases: draftFromForm.value.phases,
    createdAt: '',
    updatedAt: '',
    revision: 0,
  }
  const samples = [3, 5, 8]
  return samples.map((wall) => ({
    wall,
    heat: formatHours(cardPhaseHours(tempCard, '升温', wall)),
    hold: formatHours(cardPhaseHours(tempCard, '保温', wall)),
    cool: formatHours(cardPhaseHours(tempCard, '缓冷', wall)),
    total: formatHours(
      cardPhaseHours(tempCard, '升温', wall) +
        cardPhaseHours(tempCard, '保温', wall) +
        cardPhaseHours(tempCard, '缓冷', wall),
    ),
  }))
})

onMounted(() => {
  void cardStore.loadAll()
  void annealStore.loadAll()
})

function openCreate(): void {
  editingFamilyKey.value = null
  editingPrevious.value = null
  Object.assign(form, {
    glassKind: '钠钙玻璃' as GlassKind,
    wallMinMm: 0,
    wallMaxMm: 8,
    openEnded: false,
    remark: '',
    annealPointC: 560,
    heatStartC: 20,
    coolEndC: 60,
    phases: {
      升温: { rateCPerHour: 120, holdHours: 0 },
      保温: { rateCPerHour: 0, holdHours: 1.2 },
      缓冷: { rateCPerHour: 40, holdHours: 0 },
    },
  })
  dialogVisible.value = true
}

/** 调参：以在用版参数预填，保存时生成下一版 */
function openRevise(group: { familyKey: string; active: AnnealCard | null }): void {
  const active = group.active
  if (active === null) {
    ElMessage.warning('该卡族没有在用版本，无法升版。')
    return
  }
  editingFamilyKey.value = group.familyKey
  editingPrevious.value = active
  const heat = active.phases.find((item) => item.phase === '升温')
  const hold = active.phases.find((item) => item.phase === '保温')
  const cool = active.phases.find((item) => item.phase === '缓冷')
  Object.assign(form, {
    glassKind: active.glassKind,
    wallMinMm: active.wallMinMm,
    wallMaxMm: active.wallMaxMm,
    openEnded: active.wallMaxMm === null,
    remark: active.remark,
    annealPointC: hold?.startC ?? 560,
    heatStartC: heat?.startC ?? 20,
    coolEndC: cool?.endC ?? 60,
    phases: {
      升温: { rateCPerHour: heat?.rateCPerHour ?? 120, holdHours: 0 },
      保温: { rateCPerHour: 0, holdHours: hold?.holdHours ?? 1.2 },
      缓冷: { rateCPerHour: cool?.rateCPerHour ?? 40, holdHours: 0 },
    },
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (!bandCheck.value.ok) {
    ElMessage.error(bandCheck.value.message)
    return
  }
  if (!phaseCheck.value.ok) {
    ElMessage.error(phaseCheck.value.message)
    return
  }
  submitting.value = true
  try {
    if (editingFamilyKey.value === null) {
      const card = await cardStore.createFamily({ ...draftFromForm.value })
      if (card === null) {
        ElMessage.error(cardStore.lastMessage)
        return
      }
      ElMessage.success(cardStore.lastMessage)
    } else {
      const result = await cardStore.revise(editingFamilyKey.value, { ...draftFromForm.value })
      if (result.card === null) {
        ElMessage.error(cardStore.lastMessage)
        return
      }
      ElMessage[result.bouncedCount > 0 ? 'warning' : 'success'](cardStore.lastMessage)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleReviseConfirm(group: { familyKey: string; active: AnnealCard | null }): Promise<void> {
  const active = group.active
  if (active === null) return
  try {
    await ElMessageBox.confirm(
      `调参保存后会生成「${active.name}」的新版本：旧版留档只读；尚未进窑的排位按新版重算，撞窑位的退回待排；已进窑的照当初那版烧完。`,
      '确认升版',
      { type: 'warning', confirmButtonText: '继续调参', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  openRevise(group)
}

function phaseText(card: AnnealCard, wall: number): string {
  return `升温 ${formatHours(cardPhaseHours(card, '升温', wall))} / 保温 ${formatHours(
    cardPhaseHours(card, '保温', wall),
  )} / 缓冷 ${formatHours(cardPhaseHours(card, '缓冷', wall))}`
}

function cardParams(card: AnnealCard) {
  const heat = card.phases.find((item) => item.phase === '升温')
  const hold = card.phases.find((item) => item.phase === '保温')
  const cool = card.phases.find((item) => item.phase === '缓冷')
  return {
    point: hold?.startC ?? 0,
    heatRate: heat?.rateCPerHour ?? 0,
    holdHours: hold?.holdHours ?? 0,
    coolRate: cool?.rateCPerHour ?? 0,
  }
}

const historyFamily = computed(() =>
  showHistoryFor.value === null ? null : cardStore.versionsOf(showHistoryFor.value),
)
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="卡族" :value="stats.families" suffix="族" tone="primary" icon="Collection" />
      <StatBadge label="在用版本" :value="stats.active" suffix="张" tone="success" icon="DocumentChecked" />
      <StatBadge label="留档旧版" :value="stats.archived" suffix="张" tone="info" icon="Files" />
      <StatBadge label="玻璃种类" :value="stats.kinds" suffix="类" tone="warning" icon="Coffee" />
      <StatBadge label="退回待排" :value="annealStore.bouncedRows.length" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="待确认" :value="annealStore.pendingRows.length" suffix="条" tone="warning" icon="QuestionFilled" />
    </div>

    <el-alert
      v-if="annealStore.bouncedRows.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${annealStore.bouncedRows.length} 条排位在卡升版后撞窑位，已退回待排，请到退火编排页重新排位。`"
    />
    <el-alert
      v-if="annealStore.pendingRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${annealStore.pendingRows.length} 条排位按卡版本对账不通过，已搁置待确认。`"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火工艺卡（按玻璃种类 · 壁厚区间）</span>
          <el-space wrap>
            <el-radio-group v-model="kindFilter" size="small">
              <el-radio-button label="all">全部</el-radio-button>
              <el-radio-button v-for="kind in GLASS_KIND_OPTIONS" :key="kind" :label="kind">{{ kind }}</el-radio-button>
            </el-radio-group>
            <el-button type="primary" @click="openCreate">
              <el-icon><Plus /></el-icon>
              <span>新建卡族</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <EmptyPanel
        v-if="cardStore.ready && cardStore.families.length === 0"
        title="还没有退火工艺卡"
        description="按玻璃种类与壁厚区间建立三段（升温 / 保温 / 缓冷）的升降温速度与保温时长；每次调参都会存成新版本，旧版自动留档。"
        action-text="建立第一张卡"
        @action="openCreate"
      />

      <el-table v-else v-loading="!cardStore.ready" :data="visibleFamilies" row-key="familyKey" stripe>
        <el-table-column label="卡族 / 壁厚区间" min-width="220">
          <template #default="{ row }">
            <div class="cell-stack" v-if="row.active">
              <b>{{ row.active.name }}</b>
              <span class="cell-sub">{{ wallBandText(row.active.wallMinMm, row.active.wallMaxMm) }} · 共 {{ row.versions.length }} 个版本</span>
            </div>
            <span v-else class="cell-sub">该族已无在用版本</span>
          </template>
        </el-table-column>
        <el-table-column label="退火点" width="100" align="right">
          <template #default="{ row }">
            <span v-if="row.active">{{ cardParams(row.active).point }} ℃</span>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="升温速率" width="110" align="right">
          <template #default="{ row }">
            <span v-if="row.active">{{ cardParams(row.active).heatRate }} ℃/h</span>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="保温时长" width="150" align="right">
          <template #default="{ row }">
            <span v-if="row.active">{{ cardParams(row.active).holdHours }} h / 5mm</span>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="缓冷速率" width="110" align="right">
          <template #default="{ row }">
            <span v-if="row.active">{{ cardParams(row.active).coolRate }} ℃/h</span>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="5mm 三段时长" min-width="240">
          <template #default="{ row }">
            <span v-if="row.active" class="cell-sub">{{ phaseText(row.active, 5) }}</span>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.active" size="small" type="success" effect="dark">在用 v{{ row.active.version }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="row.active === null" @click="handleReviseConfirm(row)">
              调参升版
            </el-button>
            <el-button link type="info" size="small" @click="showHistoryFor = row.familyKey">版本留档</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建 / 升版弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingPrevious === null ? '新建退火工艺卡族' : `调参升版：${editingPrevious.name}（当前 v${editingPrevious.version}）`"
      width="760px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="130px">
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="玻璃种类" prop="glassKind">
              <el-select v-model="form.glassKind" style="width: 100%" :disabled="editingPrevious !== null">
                <el-option v-for="kind in GLASS_KIND_OPTIONS" :key="kind" :value="kind" :label="kind" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="壁厚下限(mm)" prop="wallMinMm">
              <el-input-number v-model="form.wallMinMm" :min="0" :max="200" :step="0.5" :precision="1" style="width: 100%" :disabled="editingPrevious !== null" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="壁厚上限(mm)">
              <el-space>
                <el-input-number v-model="form.wallMaxMm" :min="0.1" :max="200" :step="0.5" :precision="1" :disabled="form.openEnded || editingPrevious !== null" />
                <el-checkbox v-model="form.openEnded" :disabled="editingPrevious !== null">无上界</el-checkbox>
              </el-space>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="退火点(℃)">
              <el-input-number v-model="form.annealPointC" :min="200" :max="900" :step="5" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="升温起点(℃)">
              <el-input-number v-model="form.heatStartC" :min="0" :max="200" :step="5" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="缓冷终点(℃)">
              <el-input-number v-model="form.coolEndC" :min="20" :max="300" :step="5" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="升温速率(℃/h)">
              <el-input-number v-model="form.phases.升温.rateCPerHour" :min="1" :max="500" :step="5" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="保温(h/5mm)">
              <el-input-number v-model="form.phases.保温.holdHours" :min="0.1" :max="12" :step="0.1" :precision="1" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="缓冷速率(℃/h)">
              <el-input-number v-model="form.phases.缓冷.rateCPerHour" :min="1" :max="300" :step="5" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="如：厚壁件放慢升降温 / 本版依据 10 月应力测试调整" />
        </el-form-item>

        <el-alert
          :type="bandCheck.ok ? phaseCheck.ok ? 'success' : 'warning' : 'error'"
          show-icon
          :closable="false"
          :title="bandCheck.ok ? phaseCheck.ok ? '参数校验通过' : phaseCheck.message : bandCheck.message"
          :description="
            editingPrevious === null
              ? '新卡族首版保存后即可在退火排位中挑选。'
              : `保存后生成 v${(editingPrevious.version ?? 0) + 1}：旧版留档；未进窑排位按新版重算，撞窑位退回待排；已进窑照旧版烧完。`
          "
        />

        <div class="preview-box">
          <div class="preview-title">整段退火时长预览（保温按壁厚线性折算）</div>
          <el-table :data="preview" size="small" border>
            <el-table-column prop="wall" label="壁厚" width="90">
              <template #default="{ row }">{{ row.wall }} mm</template>
            </el-table-column>
            <el-table-column prop="heat" label="升温" />
            <el-table-column prop="hold" label="保温" />
            <el-table-column prop="cool" label="缓冷" />
            <el-table-column prop="total" label="合计" />
          </el-table>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">
          {{ editingPrevious === null ? '建卡' : '保存为新版本' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 版本留档抽屉 -->
    <el-drawer
      :model-value="showHistoryFor !== null"
      title="版本留档（旧版只读，已进窑排位按其对账）"
      size="640px"
      @update:model-value="(value: boolean) => { if (!value) showHistoryFor = null }"
    >
      <el-timeline v-if="historyFamily !== null">
        <el-timeline-item
          v-for="card in historyFamily"
          :key="card.id"
          :type="card.status === 'active' ? 'success' : 'info'"
          :hollow="card.status === 'archived'"
          :timestamp="card.status === 'active' ? `在用 · v${card.version}` : `留档 · v${card.version}`"
        >
          <div class="version-card">
            <div class="cell-sub">{{ card.glassKind }} · {{ wallBandText(card.wallMinMm, card.wallMaxMm) }}</div>
            <div>
              退火点 {{ cardParams(card).point }} ℃ · 升温 {{ cardParams(card).heatRate }} ℃/h ·
              保温 {{ cardParams(card).holdHours }} h/5mm · 缓冷 {{ cardParams(card).coolRate }} ℃/h
            </div>
            <div class="cell-sub">5mm：{{ phaseText(card, 5) }}</div>
            <div v-if="card.remark !== ''" class="cell-sub">备注：{{ card.remark }}</div>
            <div v-if="card.supersedesId !== ''" class="cell-sub">由上一版调参生成</div>
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-drawer>
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

.preview-box {
  margin-top: 14px;
}

.preview-title {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
  margin-bottom: 6px;
}

.version-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  line-height: 1.6;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
