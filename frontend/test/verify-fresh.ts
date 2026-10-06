/** 全新库 + 升版 / 撞位 / 待排 / 对账 / 只读 行为验证（Node + fake-indexeddb） */
import 'fake-indexeddb/auto'
import {
  db,
  resetDatabase,
  listCards,
  publishCardRevision,
  resubmitBounced,
  reconcileSchedules,
  confirmSchedule,
  advanceAnnealState,
  exportSnapshot,
} from '../src/utils/db'
import { nowIso } from '../src/utils/id'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exitCode = 1
  } else {
    console.log('PASS:', msg)
  }
}

async function main(): Promise<void> {
  await resetDatabase()
  const cards = await listCards()
  assert(cards.length === 4, `播种 4 张默认卡（实际 ${cards.length}）`)
  const snap = await exportSnapshot()
  assert(snap.schemaVersion === 3, '结构版本 v3')
  assert(snap.anneals.every((a) => a.cardVersionId !== ''), '播种排位均挂了卡版本')
  assert(snap.pieces.every((p) => typeof p.glassKind === 'string'), '作品均有玻璃种类')
  const green = snap.pieces.find((p) => p.id === 'piece-green-bowl')!
  const greenAnneal = snap.anneals.find((a) => a.pieceId === green.id)!
  assert(snap.cards.find((c) => c.id === greenAnneal.cardVersionId)?.glassKind === '钾铅玻璃', '钾铅作品挂钾铅卡')

  // 升版：未进窑排位改挂新版；旧版留档
  const morning = await db.anneals.get('anneal-m1')
  const oldCard = cards.find((c) => c.id === morning!.cardVersionId)!
  const draft = {
    name: oldCard.name,
    glassKind: oldCard.glassKind,
    wallMinMm: oldCard.wallMinMm,
    wallMaxMm: oldCard.wallMaxMm,
    remark: '放慢缓冷',
    phases: oldCard.phases.map((p) => (p.phase === '缓冷' ? { ...p, rateCPerHour: 20 } : p)),
  }
  const r1 = await publishCardRevision(oldCard.familyKey, draft)
  assert(r1.card.version === 2, `发布 v2（实际 v${r1.card.version}）`)
  assert((await db.cards.get(oldCard.id)).status === 'archived', '旧版留档')
  const m1 = await db.anneals.get('anneal-m1')
  assert(m1!.cardVersionId === r1.card.id && m1!.scheduleStatus === '已排', '未进窑排位改挂新版且保持已排')
  const cup = await db.anneals.get('anneal-c1')
  assert(cup!.cardVersionId !== r1.card.id, '退火中排位照当初那版（不随升版改挂）')

  // 制造撞位：blocker 占同窑位同窗（挂另一族卡，不随升版重算）
  const lead = (await db.cards.toArray()).find((c) => c.glassKind === '钾铅玻璃' && c.status === 'active')!
  await db.anneals.put({
    id: 'anneal-blocker',
    pieceId: 'piece-green-bowl',
    kilnSlot: m1!.kilnSlot,
    curveSeg: '缓冷',
    cardVersionId: lead.id,
    inAt: m1!.inAt,
    outAt: '',
    state: '待入窑',
    scheduleStatus: '已排',
    scheduleReason: 'none',
    locked: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    revision: 3,
  })
  const current = await db.cards.get(m1!.cardVersionId)
  const r2 = await publishCardRevision(current.familyKey, {
    name: current.name,
    glassKind: current.glassKind,
    wallMinMm: current.wallMinMm,
    wallMaxMm: current.wallMaxMm,
    remark: '再次升版制造撞位',
    phases: current.phases.map((p) =>
      p.phase === '缓冷' ? { ...p, rateCPerHour: 10 } : p.phase === '升温' ? { ...p, rateCPerHour: 30 } : p,
    ),
  })
  const m1b = await db.anneals.get('anneal-m1')
  assert(
    m1b!.scheduleStatus === '待排' && r2.bounced.some((b) => b.id === 'anneal-m1'),
    '升版后撞别人窑位 → 退回待排',
  )

  // 待排改窑位重新提交
  const rs = await resubmitBounced('anneal-m1', { kilnSlot: 'AN-01-C2', inAt: m1b!.inAt, cardVersionId: m1b!.cardVersionId })
  assert(rs.ok, `待排改窑位恢复已排：${rs.message}`)
  assert((await db.anneals.get('anneal-m1'))!.scheduleStatus === '已排', '排位状态恢复已排')

  // 对账：缺卡 → 待确认 → 人工改挂
  const active = (await db.cards.toArray()).find((c) => c.status === 'active')!
  await db.anneals.put({
    id: 'anneal-reconcile',
    pieceId: 'piece-red-cup',
    kilnSlot: 'AN-01-B3',
    curveSeg: '升温',
    cardVersionId: active.id,
    inAt: '2026-11-10T08:00',
    outAt: '',
    state: '待入窑',
    scheduleStatus: '已排',
    scheduleReason: 'none',
    locked: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    revision: 3,
  })
  await db.cards.delete(active.id)
  const parked = await reconcileSchedules()
  assert(parked.some((a) => a.id === 'anneal-reconcile'), '引用卡缺失 → 对账搁置')
  const pr = await db.anneals.get('anneal-reconcile')
  assert(pr!.scheduleStatus === '待确认' && pr!.scheduleReason === 'card-missing', '待确认原因正确')
  const replacement = (await db.cards.toArray()).find((c) => c.status === 'active')!
  const cr = await confirmSchedule('anneal-reconcile', replacement.id)
  assert(cr.ok, `人工对账改挂：${cr.message}`)

  // 只读旧排位禁止推进
  await db.anneals.put({
    id: 'anneal-locked',
    pieceId: 'piece-red-cup',
    kilnSlot: 'AN-01-C3',
    curveSeg: '升温',
    cardVersionId: '',
    inAt: '2026-11-11T08:00',
    outAt: '',
    state: '待入窑',
    scheduleStatus: '待确认',
    scheduleReason: 'legacy-unmatched',
    locked: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    revision: 3,
  })
  assert((await advanceAnnealState('anneal-locked', '退火中', '2026-11-11T12:00')) === false, '只读排位禁止推进')

  console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL FRESH-DB TESTS PASSED')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
