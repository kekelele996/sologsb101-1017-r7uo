<script setup lang="ts">
/**
 * /cards 退火工艺卡（工艺技术组）
 * 按玻璃种类 + 壁厚区间立卡，定义三段升降温速率 / 目标温度 / 保温时长；
 * 每调一次另存一个新版本，旧版置 archived 留档；同一卡系仅一个 active 版供排产。
 * 发布新版会由 db 层连带重算未进窑排位（撞窑位退回待排，区间不覆盖置待确认）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useCardStore } from '@/stores/cardStore'
import {
  GLASS_TYPE_OPTIONS,
  GLASS_TYPE_TAG_TYPE,
  type AnnealCard,
  type AnnealCardDraft,
  type CurveSeg,
  type GlassType,
} from '@/types/card'
import { cardSegmentHoursMap, cardTotalHours, emptyCurve, formatHours } from '@/utils/thermal'

const store = useCardStore()

const dialogVisible = ref(false)
const historyVisible = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()
/** 正在升版的卡系；空串表示新建卡系 */
const editingCardKey = ref<string>('')
const historyGroup = ref<{ cardKey: string; active?: AnnealCard; versions: AnnealCard[] } | null>(null)

const SEG_LABELS: Record<CurveSeg, string> = { 升温: '升温段', 保温: '保温段', 缓冷: '缓冷段' }
const SEGS: CurveSeg[] = ['升温', '保温', '缓冷']

const form = reactive<AnnealCardDraft>({
  name: '',
  glassType: '钠钙玻璃',
  minMm: 0,
  maxMm: 5,
  curve: emptyCurve(),
  note: '',
})

const rules = computed<FormRules<AnnealCardDraft>>(() => ({
  name: [{ required: true, message: '请填写卡名', trigger: 'blur' }],
  glassType: [{ required: true, message: '请选择玻璃种类', trigger: 'change' }],
  minMm: [{ required: true, message: '请填写壁厚下限', trigger: 'blur' }],
  maxMm: [{ required: true, message: '请填写壁厚上限', trigger: 'blur' }],
}))

const durationMap = computed(() => {
  const seg = cardSegmentHoursMap({ curve: form.curve })
  return {
    升温: formatHours(seg.升温),
    保温: formatHours(seg.保温),
    缓冷: formatHours(seg.缓冷),
    total: formatHours(cardTotalHours({ curve: form.curve })),
  }
})

onMounted(() => {
  void store.loadAll()
})

/** 从某张卡把三段参数带入表单（新建首版 / 升版 / 查看后新建均复用） */
function fillFromCard(card: AnnealCard | undefined): void {
  if (card === undefined) {
    Object.assign(form, {
      name: '',
      glassType: '钠钙玻璃' as GlassType,
      minMm: 0,
      maxMm: 5,
      curve: emptyCurve(),
      note: '',
    })
    return
  }
  Object.assign(form, {
    name: card.name,
    glassType: card.glassType,
    minMm: card.minMm,
    maxMm: card.maxMm,
    curve: emptyCurve(JSON.parse(JSON.stringify(card.curve)) as AnnealCard['curve']),
    note: card.note,
  })
}

function openCreate(): void {
  editingCardKey.value = ''
  fillFromCard(undefined)
  dialogVisible.value = true
}

/** 基于某卡系当前生效版调参，另存新版本 */
function openNewVersion(group: { cardKey: string; active?: AnnealCard }): void {
  if (group.active === undefined) {
    ElMessage.warning('该卡系没有生效版，无法在此上升版。')
    return
  }
  editingCardKey.value = group.cardKey
  fillFromCard(group.active)
  dialogVisible.value = true
}

function openHistory(group: { cardKey: string; active?: AnnealCard; versions: AnnealCard[] }): void {
  historyGroup.value = group
  historyVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (form.minMm > form.maxMm) {
    ElMessage.error('壁厚下限不能大于上限。')
    return
  }
  submitting.value = true
  try {
    const card = await store.publish({ ...form, curve: JSON.parse(JSON.stringify(form.curve)) }, editingCardKey.value || undefined)
    if (card === null) {
      ElMessage.error(store.lastMessage)
      return
    }
    ElMessage.success(store.lastMessage)
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'glassType') store.setFilters({ glassType: value as GlassType | 'all' })
  if (key === 'scope') store.setFilters({ scope: value as 'active' | 'archived' | 'all' })
}

function durationOfCard(card: AnnealCard): string {
  return formatHours(cardTotalHours(card))
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="卡系数" :value="store.stats.groups" suffix="组" tone="primary" icon="Collection" />
      <StatBadge label="生效版本" :value="store.stats.active" suffix="张" tone="success" icon="CircleCheck" />
      <StatBadge label="留档旧版" :value="store.stats.archived" suffix="张" tone="info" icon="Files" />
      <StatBadge label="版本总数" :value="store.stats.total" suffix="张" tone="primary" icon="Histogram" />
    </div>

    <el-alert
      v-if="store.lastMessage !== ''"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      :title="store.lastMessage"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火工艺卡（按玻璃种类 × 壁厚区间）</span>
          <el-button type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>
            <span>新建工艺卡</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="store.filters.keyword"
        :fields="[
          { key: 'glassType', label: '玻璃种类', options: GLASS_TYPE_OPTIONS as unknown as string[] },
          { key: 'scope', label: '版本范围', options: ['生效卡', '已停用卡系', '全部'] },
        ]"
        :values="{ glassType: store.filters.glassType, scope: store.filters.scope }"
        :result-text="`命中 ${store.visibleGroups.length} / ${store.cardGroups.length} 个卡系`"
        @update:keyword="(value: string) => store.setFilters({ keyword: value })"
        @change="
          (key: string, value: string) => {
            if (key === 'scope') value = value === '生效卡' ? 'active' : value === '已停用卡系' ? 'archived' : 'all'
            handleFilterChange(key, value)
          }
        "
        @reset="store.resetFilters()"
      />

      <EmptyPanel
        v-if="store.ready && store.cardGroups.length === 0"
        title="还没有退火工艺卡"
        description="按玻璃种类与壁厚区间立卡，分别设定升温、保温、缓冷三段的速率、目标温度与保温时长；每次调整另存新版本，旧版自动留档。"
        action-text="建立第一张卡"
        @action="openCreate"
      />

      <div v-else v-loading="!store.ready" class="card-grid">
        <div v-for="group in store.visibleGroups" :key="group.cardKey" class="card-tile">
          <template v-if="group.active">
            <div class="tile-head">
              <el-tag :type="GLASS_TYPE_TAG_TYPE[group.active.glassType]" effect="dark" size="small">
                {{ group.active.glassType }}
              </el-tag>
              <el-tag type="success" effect="plain" size="small">生效 v{{ group.active.version }}</el-tag>
            </div>
            <div class="tile-name">{{ group.active.name }}</div>
            <div class="tile-range">壁厚 {{ group.active.minMm }}–{{ group.active.maxMm }} mm</div>
            <div class="tile-segments">
              <span>升温 {{ group.active.curve.升温.rateCPerHour }} ℃/h</span>
              <span>保温 {{ group.active.curve.保温.holdHours }} h@{{ group.active.curve.保温.endC }}℃</span>
              <span>缓冷 {{ group.active.curve.缓冷.rateCPerHour }} ℃/h</span>
            </div>
            <div class="tile-total">三段合计 {{ durationOfCard(group.active) }}</div>
            <div class="tile-note">{{ group.active.note || '无备注' }}</div>
            <div class="tile-actions">
              <el-button link type="primary" size="small" @click="openNewVersion(group)">调参另存新版</el-button>
              <el-button link type="info" size="small" @click="openHistory(group)">
                版本留档（{{ group.versions.length }}）
              </el-button>
            </div>
          </template>
          <template v-else>
            <div class="tile-head">
              <el-tag type="info" effect="plain" size="small">
                {{ group.versions[0].glassType }}
              </el-tag>
              <el-tag type="info" effect="plain" size="small">已停用卡系</el-tag>
            </div>
            <div class="tile-name">{{ group.versions[0].name }}</div>
            <div class="tile-range">壁厚 {{ group.versions[0].minMm }}–{{ group.versions[0].maxMm }} mm</div>
            <div class="tile-actions">
              <el-button link type="info" size="small" @click="openHistory(group)">查看留档（{{ group.versions.length }}）</el-button>
            </div>
          </template>
        </div>
      </div>
    </el-card>

    <!-- 新建 / 升版弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingCardKey === '' ? '新建退火工艺卡' : '调参并另存新版本'"
      width="780px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-row :gutter="12">
          <el-col :span="9">
            <el-form-item label="卡名" prop="name">
              <el-input v-model="form.name" placeholder="如：钠钙玻璃 · 薄壁" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="玻璃种类" prop="glassType">
              <el-select v-model="form.glassType" style="width: 100%" :disabled="editingCardKey !== ''">
                <el-option v-for="item in GLASS_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="7">
            <el-form-item label="壁厚区间" prop="minMm">
              <el-input-group>
                <el-input-number v-model="form.minMm" :min="0" :precision="1" :step="0.5" controls-position="right" style="width: 46%" />
                <span class="range-sep">–</span>
                <el-input-number v-model="form.maxMm" :min="0" :precision="1" :step="0.5" controls-position="right" style="width: 46%" />
              </el-input-group>
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider content-position="left">三段工艺参数</el-divider>

        <el-table :data="SEGS" border size="small">
          <el-table-column label="段" width="90">
            <template #default="{ row }">{{ SEG_LABELS[row as CurveSeg] }}</template>
          </el-table-column>
          <el-table-column label="起始温度 ℃" width="150">
            <template #default="{ row }">
              <el-input-number
                v-model="form.curve[row as CurveSeg].startC"
                :min="0"
                :max="1800"
                size="small"
                style="width: 100%"
              />
            </template>
          </el-table-column>
          <el-table-column label="目标温度 ℃" width="150">
            <template #default="{ row }">
              <el-input-number
                v-model="form.curve[row as CurveSeg].endC"
                :min="0"
                :max="1800"
                size="small"
                style="width: 100%"
              />
            </template>
          </el-table-column>
          <el-table-column label="升降温速率 ℃/h" width="170">
            <template #default="{ row }">
              <el-input-number
                v-model="form.curve[row as CurveSeg].rateCPerHour"
                :min="0"
                :max="1000"
                :step="5"
                :disabled="row === '保温'"
                size="small"
                style="width: 100%"
              />
            </template>
          </el-table-column>
          <el-table-column label="保温时长 h" width="140">
            <template #default="{ row }">
              <el-input-number
                v-model="form.curve[row as CurveSeg].holdHours"
                :min="0"
                :max="48"
                :step="0.1"
                :precision="2"
                :disabled="row !== '保温'"
                size="small"
                style="width: 100%"
              />
            </template>
          </el-table-column>
          <el-table-column label="本段耗时" min-width="110" align="center">
            <template #default="{ row }">{{ durationMap[row as CurveSeg] }}</template>
          </el-table-column>
        </el-table>

        <el-form-item label="调整说明" class="mt-12">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="说明本次调参依据；旧版本会自动留档。" />
        </el-form-item>

        <el-alert
          type="success"
          show-icon
          :closable="false"
          :title="`三段合计 ${durationMap.total}`"
          :description="
            editingCardKey === ''
              ? '发布后作为该卡系 v1 生效卡，排产时按玻璃种类与壁厚自动命中。'
              : '保存为新版本后旧版留档；尚未进窑的排位会按新版重算，撞窑位退回待排，已进窑的照旧版烧完。'
          "
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">
          {{ editingCardKey === '' ? '建立 v1 生效卡' : '另存为新版本' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 版本留档弹窗 -->
    <el-dialog v-model="historyVisible" title="卡版本留档" width="760px">
      <el-timeline v-if="historyGroup">
        <el-timeline-item
          v-for="card in historyGroup.versions"
          :key="card.id"
          :type="card.state === 'active' ? 'success' : 'info'"
          :hollow="card.state !== 'active'"
          :timestamp="`${card.state === 'active' ? '当前生效' : '已留档'} · ${card.createdAt.replace('T', ' ').slice(0, 16)}`"
        >
          <div class="history-title">
            {{ card.name }} · v{{ card.version }}
            <el-tag :type="card.state === 'active' ? 'success' : 'info'" size="small" effect="plain">
              {{ card.state === 'active' ? 'active' : 'archived' }}
            </el-tag>
          </div>
          <div class="history-body">
            壁厚 {{ card.minMm }}–{{ card.maxMm }} mm ｜ 升温 {{ card.curve.升温.startC }}→{{ card.curve.升温.endC }}℃
            @{{ card.curve.升温.rateCPerHour }}℃/h ｜ 保温 {{ card.curve.保温.holdHours }}h@{{ card.curve.保温.endC }}℃ ｜
            缓冷 {{ card.curve.缓冷.startC }}→{{ card.curve.缓冷.endC }}℃@{{ card.curve.缓冷.rateCPerHour }}℃/h ｜
            合计 {{ durationOfCard(card) }}
          </div>
          <div v-if="card.note" class="history-note">{{ card.note }}</div>
        </el-timeline-item>
      </el-timeline>
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

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.card-tile {
  border: 1px solid #e4e7ed;
  border-radius: 12px;
  padding: 14px 16px;
  background: #fafcff;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tile-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tile-name {
  font-size: 15px;
  font-weight: 700;
  color: #1d2b3a;
}

.tile-range {
  font-size: 13px;
  color: #5b6b7a;
}

.tile-segments {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: #5b6b7a;
}

.tile-total {
  font-size: 13px;
  font-weight: 600;
  color: #24405e;
}

.tile-note {
  font-size: 12px;
  color: #8b95a1;
  line-height: 1.5;
}

.tile-actions {
  margin-top: auto;
  padding-top: 8px;
  display: flex;
  gap: 8px;
}

.range-sep {
  margin: 0 4px;
  color: #8b95a1;
}

.history-title {
  font-weight: 600;
  color: #1d2b3a;
  display: flex;
  align-items: center;
  gap: 8px;
}

.history-body {
  font-size: 12px;
  color: #5b6b7a;
  line-height: 1.7;
  margin-top: 2px;
}

.history-note {
  font-size: 12px;
  color: #8b95a1;
  margin-top: 2px;
}

.mt-12 {
  margin-top: 12px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
