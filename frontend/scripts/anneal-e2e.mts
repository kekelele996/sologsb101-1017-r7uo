/**
 * 端到端业务验证（内存 IndexedDB）：
 * A. v2 老库 → v3 升级：旧排位按壁厚套当时那版，套不上留只读；批次补玻璃种类
 * B. 卡升版：未进窑排位按新版重算，撞窑位退回待排，已进窑冻结旧版
 * C. 对账：版本对不上的未进窑排位置待确认
 */
import './fake-db'
import Dexie from 'dexie'
import {
  db,
  publishCardVersion,
  advanceAnnealState,
  reconcileSchedules,
  resolveSchedule,
  ROW_REVISION,
  listCards,
} from '../src/utils/db'
import type { Anneal } from '../src/types/anneal'
import type { Piece } from '../src/types/piece'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('  ✓', msg)
  } else {
    failures += 1
    console.error('  ✗', msg)
  }
}

/* ----------------------- 1) 先建一个 v2 老库 ----------------------- */

interface V2Piece {
  id: string
  batchId: string
  state: string
  artist: string
  craft: string
  name: string
  designHeightMm: number
  wallThicknessMm: number
  createdAt: string
  updatedAt: string
  revision: number
}
interface V2Batch {
  id: string
  furnaceId: string
  colorCode: string
  recipe: string
  meltDate: string
  tempC: number
  remainKg: number
  createdAt: string
  updatedAt: string
  revision: number
}
interface V2Anneal {
  id: string
  pieceId: string
  kilnSlot: string
  curveSeg: string
  inAt: string
  outAt: string
  state: string
  createdAt: string
  updatedAt: string
  revision: number
}

async function buildV2Database(): Promise<void> {
  await db.close()
  // 删除 v3 已声明的结构，用独立 Dexie 建 v2
  const old = new Dexie('gbglassblow')
  old.version(1).stores({
    furnaces: 'id, code, type, state, fuelType, createdAt',
    batches: 'id, furnaceId, colorCode, meltDate',
    pieces: 'id, batchId, state, artist',
    steps: 'id, pieceId, [pieceId+seq], seq',
    anneals: 'id, pieceId, kilnSlot, state, inAt',
    inspects: 'id, pieceId, date, result',
  })
  old.version(2).stores({
    furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
    batches: 'id, furnaceId, colorCode, meltDate, remainKg',
    pieces: 'id, batchId, state, artist, craft, name',
    steps: 'id, pieceId, [pieceId+seq], seq, state, name',
    anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
    inspects: 'id, pieceId, date, result, inspector',
  })
  const stamp = '2026-09-01T00:00:00.000Z'
  await old.table<V2Batch, string>('batches').bulkPut([
    { id: 'b1', furnaceId: 'f1', colorCode: 'G-1', recipe: '钠钙', meltDate: '2026-09-01', tempC: 1100, remainKg: 100, createdAt: stamp, updatedAt: stamp, revision: 2 },
  ])
  // p1 壁厚 3mm（钠钙薄壁可套）；p2 壁厚 300mm（超界，套不上 → 只读）
  await old.table<V2Piece, string>('pieces').bulkPut([
    { id: 'p1', batchId: 'b1', state: '制作中', artist: '甲', craft: '吹制', name: '薄壁件', designHeightMm: 100, wallThicknessMm: 3, createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'p2', batchId: 'b1', state: '制作中', artist: '乙', craft: '吹制', name: '超厚件', designHeightMm: 400, wallThicknessMm: 300, createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'p3', batchId: 'b1', state: '制作中', artist: '丙', craft: '吹制', name: '进窑件', designHeightMm: 120, wallThicknessMm: 4, createdAt: stamp, updatedAt: stamp, revision: 2 },
  ])
  await old.table<V2Anneal, string>('anneals').bulkPut([
    { id: 'a1', pieceId: 'p1', kilnSlot: 'AN-01-B2', curveSeg: '缓冷', inAt: '2026-10-10T08:00', outAt: '', state: '待入窑', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'a2', pieceId: 'p2', kilnSlot: 'AN-01-C1', curveSeg: '缓冷', inAt: '2026-10-11T08:00', outAt: '', state: '待入窑', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'a3', pieceId: 'p3', kilnSlot: 'AN-01-C2', curveSeg: '升温', inAt: '2026-09-29T08:00', outAt: '', state: '退火中', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ])
  await old.close()
}

async function main(): Promise<void> {
  console.log('\n[A] v2 → v3 老库升级')
  await buildV2Database()
  await db.open()

  const cards = await listCards()
  assert(cards.length === 6, `灌入 6 张内置 v1 工艺卡（实际 ${cards.length}）`)

  const a1 = await db.anneals.get('a1')
  const a2 = await db.anneals.get('a2')
  const a3 = await db.anneals.get('a3')
  const b1 = await db.batches.get('b1')
  assert(b1?.glassType === '钠钙玻璃', '老批次补玻璃种类=钠钙玻璃')
  assert(Boolean(a1) && a1.cardVersion !== 0 && !a1.legacy, `3mm 薄壁件套上当时那版卡（cardVersion=${a1?.cardVersion}）`)
  assert(a1?.cardKey === '钠钙玻璃::0-5mm', `套中的是钠钙薄壁卡系（实际 ${a1?.cardKey}）`)
  assert(a1?.scheduleState === '已排', '待入窑且有窑位 → 升级后为已排')
  assert(Boolean(a2) && a2.legacy === true && a2.scheduleState === '待排', '300mm 超界件套不上卡 → legacy 只读且退回待排')
  assert(Boolean(a3) && !a3.legacy && a3.scheduleState === '已进窑', '退火中排位升级后为已进窑')

  const cardThin = cards.find((c) => c.cardKey === '钠钙玻璃::0-5mm' && c.state === 'active')!
  const beforeVersion = cardThin.version

  console.log('\n[B] 卡升版：重算 / 撞窑位退回 / 已进窑冻结')
  // 先放一条别的排位，占用 a1 用新版时长推算后会撞上的窑位 AN-01-B2 同窗
  // a1 在 2026-10-10T08:00，新版把缓冷放慢到 5℃/h（500/5=100h），窗口大幅拉长；
  // 再加一条同窑位但时间落在拉长后窗口内的已排排位
  const stamp = new Date().toISOString()
  const blocker: Anneal = {
    id: 'a9',
    pieceId: 'p1',
    kilnSlot: 'AN-01-B2',
    cardVersionId: cardThin.id,
    cardKey: cardThin.cardKey,
    cardVersion: cardThin.version,
    curveSeg: '缓冷',
    inAt: '2026-10-12T08:00',
    outAt: '',
    state: '待入窑',
    scheduleState: '已排',
    legacy: false,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }
  // blocker 需要另一件作品，避免与 a1 完全同件；新增 p4 壁厚 3mm
  await db.pieces.put({
    id: 'p4', batchId: 'b1', state: '制作中', artist: '丁', craft: '吹制', name: '邻件',
    designHeightMm: 100, wallThicknessMm: 3, createdAt: stamp, updatedAt: stamp, revision: ROW_REVISION,
  } as Piece)
  blocker.pieceId = 'p4'
  await db.anneals.put(blocker)

  // 发布新版：缓冷速率 40 → 5 ℃/h（窗口拉长到足以撞上 blocker），保温加大
  const result = await publishCardVersion({
    name: cardThin.name,
    glassType: cardThin.glassType,
    minMm: cardThin.minMm,
    maxMm: cardThin.maxMm,
    curve: {
      升温: { startC: 20, endC: 560, rateCPerHour: 120, holdHours: 0 },
      保温: { startC: 560, endC: 560, rateCPerHour: 0, holdHours: 2 },
      缓冷: { startC: 560, endC: 60, rateCPerHour: 5, holdHours: 0 },
    },
    note: '放慢缓冷测试',
    cardKey: cardThin.cardKey,
  })
  assert(result.card.version === beforeVersion + 1, `新版本号=${result.card.version}（旧 v${beforeVersion}）`)
  assert(result.bounced >= 1, `升版重算有排位撞窑位退回待排（bounced=${result.bounced}）`)

  const a1After = await db.anneals.get('a1')
  assert(a1After?.cardVersion === result.card.version, 'a1 已重绑新版本')
  assert(a1After?.scheduleState === '待排' && a1After.kilnSlot === '', 'a1 撞窑位 → 退回待排且清空窑位')

  const a9After = await db.anneals.get('a9')
  assert(a9After?.cardVersion === result.card.version && a9After.scheduleState === '已排', '未撞位的 a9 重绑新版仍为已排')

  const a3After = await db.anneals.get('a3')
  assert(a3After?.cardVersion === beforeVersion && a3After.scheduleState === '已进窑', '已进窑的 a3 冻结旧版不重算')

  // blocker 重算后与 a1（已退回，不占位）不再相关
  console.log('\n[C] 进窑后再升版 / 对账 / 手工对齐')
  // 给 a9 推进到退火中 → 冻结
  await advanceAnnealState('a9', '退火中', '2026-10-12T09:00')
  const a9Fired = await db.anneals.get('a9')
  assert(a9Fired?.state === '退火中' && a9Fired.scheduleState === '已进窑', 'a9 进窑后置已进窑')

  // 再造一条已排但停留在旧版的排位：直接插一条 v1 绑定记录（模拟另一条未重算路径用于对账）
  const laggard: Anneal = {
    id: 'a10', pieceId: 'p4', kilnSlot: 'AN-01-A3',
    cardVersionId: cardThin.id, cardKey: cardThin.cardKey, cardVersion: beforeVersion,
    curveSeg: '缓冷', inAt: '2026-11-01T08:00', outAt: '', state: '待入窑',
    scheduleState: '已排', legacy: false, createdAt: stamp, updatedAt: stamp, revision: ROW_REVISION,
  }
  await db.anneals.put(laggard)
  const flagged = await reconcileSchedules()
  assert(flagged >= 1, `对账把版本落后的未进窑排位置待确认（flagged=${flagged}）`)
  const a10After = await db.anneals.get('a10')
  assert(a10After?.scheduleState === '待确认', 'a10 → 待确认')
  const a3Reconciled = await db.anneals.get('a3')
  assert(a3Reconciled.scheduleState === '已进窑', '已进窑旧版 a3 对账时不动')

  // 手工对齐 a10：当前 AN-01-A3 空闲，应回到已排
  const next = await resolveSchedule('a10')
  assert(next === '已排', '手工按新版对齐后回到已排（窑位不冲突）')
  const a10Resolved = await db.anneals.get('a10')
  assert(a10Resolved.cardVersion === result.card.version && a10Resolved.scheduleState === '已排', 'a10 已绑定最新版且已排')

  console.log('\n[D] 遗留只读排位不可推进')
  let blocked = false
  await advanceAnnealState('a2', '退火中', '2026-10-11T09:00').catch(() => { blocked = true })
  const a2Still = await db.anneals.get('a2')
  assert(a2Still.state === '待入窑' && a2Still.legacy === true, 'legacy 排位推进被忽略，仍只读留档')

  console.log('\n[E] 新区间不覆盖 → 待确认')
  // 发一个把壁厚上限收窄到 2mm 的“新卡系”不现实；改为对卡系再发一版把区间改到 0–3.5（仍含3/4），
  // 这里直接验证：把上限改为 0–2.5mm，p4(3mm) 的 a9 已进窑不受影响；待排的 a1 重算应置待确认
  const res2 = await publishCardVersion({
    name: cardThin.name,
    glassType: cardThin.glassType,
    minMm: 0,
    maxMm: 2.5,
    curve: result.card.curve,
    note: '收窄区间',
    cardKey: result.card.cardKey,
  })
  assert(res2.unresolved >= 1, `区间收窄后不覆盖的未进窑排位置待确认（unresolved=${res2.unresolved}）`)
  const a1Final = await db.anneals.get('a1')
  assert(a1Final?.scheduleState === '待确认', 'a1（3mm）因新版仅覆盖到 2.5mm → 待确认')

  await db.close()

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  } else {
    console.log('\n全部断言通过 ✅')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
