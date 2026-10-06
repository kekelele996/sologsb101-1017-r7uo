/** v2 → v3 升级迁移验证：旧排位无卡版本，按作品壁厚套当时卡版，套不上留只读 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { DB_NAME } from '../src/utils/db'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exitCode = 1
  } else {
    console.log('PASS:', msg)
  }
}

async function main(): Promise<void> {
  await Dexie.delete(DB_NAME)

  // 1) 以 v2 结构建库并灌旧数据（无 cards 表；pieces 无 glassKind；anneals 无卡版本字段）
  const old = new Dexie(DB_NAME)
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
  await old.table('furnaces').bulkPut([
    { id: 'f1', code: 'AN-01', type: '退火窑', maxTempC: 620, fuelType: '电', state: '运行', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ])
  await old.table('batches').bulkPut([
    { id: 'b1', furnaceId: 'f1', colorCode: 'G-1', recipe: '钠钙玻璃基础料', meltDate: '2026-09-01', tempC: 1180, remainKg: 100, createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'b2', furnaceId: 'f1', colorCode: 'L-9', recipe: '钾铅玻璃 + 氧化铜', meltDate: '2026-09-01', tempC: 1100, remainKg: 50, createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'b3', furnaceId: 'f1', colorCode: 'T-1', recipe: '高透钠钙玻璃', meltDate: '2026-09-01', tempC: 1170, remainKg: 80, createdAt: stamp, updatedAt: stamp, revision: 2 },
  ])
  await old.table('pieces').bulkPut([
    { id: 'p1', name: '钠钙薄壁', batchId: 'b1', designHeightMm: 200, wallThicknessMm: 3, craft: '吹制', artist: '甲', state: '制作中', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'p2', name: '钠钙厚壁', batchId: 'b3', designHeightMm: 200, wallThicknessMm: 12, craft: '热塑', artist: '丙', state: '制作中', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'p3', name: '钾铅厚壁套不上', batchId: 'b2', designHeightMm: 120, wallThicknessMm: 10, craft: '铸造', artist: '乙', state: '已退火', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ])
  await old.table('anneals').bulkPut([
    { id: 'a1', pieceId: 'p1', kilnSlot: 'AN-01-A1', curveSeg: '缓冷', inAt: '2026-10-01T08:00', outAt: '', state: '待入窑', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'a2', pieceId: 'p2', kilnSlot: 'AN-01-A2', curveSeg: '缓冷', inAt: '2026-10-02T08:00', outAt: '', state: '待入窑', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'a3', pieceId: 'p3', kilnSlot: 'AN-01-A3', curveSeg: '缓冷', inAt: '2026-09-20T08:00', outAt: '2026-09-21T08:00', state: '已出炉', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ])
  await old.close()

  // 2) 用应用代码重新打开 → 触发 v2→v3 upgrade
  const mod = await import('../src/utils/db')
  await mod.db.open()

  const cards = await mod.db.cards.toArray()
  assert(cards.length === 4, `迁移写入 4 张默认卡（实际 ${cards.length}）`)
  const p1 = await mod.db.pieces.get('p1')
  const p2 = await mod.db.pieces.get('p2')
  const p3 = await mod.db.pieces.get('p3')
  assert(p1.glassKind === '钠钙玻璃' && p2.glassKind === '钠钙玻璃', '钠钙配方推断为钠钙玻璃')
  assert(p3.glassKind === '钾铅玻璃', '钾铅配方推断为钾铅玻璃')

  const a1 = await mod.db.anneals.get('a1')
  const a2 = await mod.db.anneals.get('a2')
  const a3 = await mod.db.anneals.get('a3')
  assert(a1.cardVersionId === 'card-soda-thin-v1' && a1.scheduleStatus === '已排' && a1.locked === false, '钠钙 3mm 套薄壁档')
  assert(a2.cardVersionId === 'card-soda-thick-v1' && a2.scheduleStatus === '已排' && a2.locked === false, '钠钙 12mm 套厚壁档')
  assert(a3.cardVersionId === '' && a3.scheduleStatus === '待确认' && a3.scheduleReason === 'legacy-unmatched' && a3.locked === true, '钾铅 10mm 套不上 → 只读待确认')

  // 迁移后不会重新播种（库非空）
  assert((await mod.db.furnaces.count()) === 1, '旧库迁移后不触发播种')

  mod.db.close()
  console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL MIGRATION TESTS PASSED')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
