/**
 * 导出工具：整库 JSON 存档、窑务排产 CSV、工序卡片文本
 * 退火时长一律按作品玻璃种类 + 壁厚命中的生效工艺卡计算；无卡时回退老口径。
 * 全部在浏览器本地完成，不经过任何服务端。
 */
import type { DatabaseSnapshot } from './db'
import { DB_NAME, DB_SCHEMA_VERSION } from './db'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { AnnealCard } from '../types/card'
import type { Inspect } from '../types/inspect'
import { stampSuffix } from './id'
import { cardSegmentHoursMap, cardTotalHours, formatHours, isLowRemain, legacyTotalHours, pickActiveCard } from './thermal'

/** 触发浏览器下载 */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** CSV 单元格转义 */
export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出整库 JSON 存档，返回文件名 */
export function exportSnapshotJson(snapshot: DatabaseSnapshot): string {
  const filename = `${DB_NAME}-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8')
  return filename
}

export interface SnapshotParseResult {
  ok: boolean
  message: string
  snapshot: DatabaseSnapshot | null
}

/** 解析并校验导入的 JSON 存档 */
export function parseSnapshot(text: string): SnapshotParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认文件内容完整。', snapshot: null }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '存档格式不正确：顶层必须是对象。', snapshot: null }
  }
  const data = raw as Partial<DatabaseSnapshot>
  if (data.name !== DB_NAME) {
    return { ok: false, message: `存档不属于本项目：期望 name = ${DB_NAME}，实际为 ${String(data.name)}。`, snapshot: null }
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > DB_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `存档数据结构版本不兼容：当前支持 ≤ v${DB_SCHEMA_VERSION}，实际为 v${String(data.schemaVersion)}。`,
      snapshot: null,
    }
  }
  const keys: Array<keyof DatabaseSnapshot> = ['furnaces', 'batches', 'pieces', 'steps', 'anneals', 'inspects']
  for (const key of keys) {
    if (!Array.isArray(data[key])) {
      return { ok: false, message: `存档缺少 ${String(key)} 数组。`, snapshot: null }
    }
  }
  // 旧版（v2 及以前）存档没有 annealCards，importSnapshot 会补内置卡，这里不判失败
  return { ok: true, message: '存档校验通过。', snapshot: data as DatabaseSnapshot }
}

/** 按作品玻璃种类 + 壁厚取当前生效卡；无卡回退老口径 */
function pieceCard(piece: Piece, batches: GlassBatch[], cards: AnnealCard[]): AnnealCard | null {
  const glassType = batches.find((row) => row.id === piece.batchId)?.glassType ?? '钠钙玻璃'
  return pickActiveCard(cards, glassType, piece.wallThicknessMm)
}

/** 生成窑务排产汇总 CSV（一件作品一行） */
export function buildScheduleCsv(
  furnaces: Furnace[],
  batches: GlassBatch[],
  pieces: Piece[],
  steps: Step[],
  anneals: Anneal[],
  inspects: Inspect[],
  cards: AnnealCard[] = [],
): string {
  const header = [
    '作品名',
    '工艺',
    '玻璃种类',
    '创作者',
    '状态',
    '设计高度(mm)',
    '壁厚(mm)',
    '料液色号',
    '所属窑炉',
    '工序数',
    '已完成工序',
    '累计工时(分钟)',
    '退火记录数',
    '退火窑位',
    '工艺卡版本',
    '退火状态',
    '理论退火时长',
    '检验次数',
    '最近检验结果',
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  pieces.forEach((piece) => {
    const batch = batches.find((row) => row.id === piece.batchId)
    const furnace = furnaces.find((row) => row.id === batch?.furnaceId)
    const pieceSteps = steps.filter((row) => row.pieceId === piece.id).sort((a, b) => a.seq - b.seq)
    const pieceAnneals = anneals.filter((row) => row.pieceId === piece.id)
    const latestAnneal = pieceAnneals.length > 0 ? pieceAnneals[pieceAnneals.length - 1] : null
    const latestCard = latestAnneal ? cards.find((card) => card.id === latestAnneal.cardVersionId) : undefined
    const pieceInspects = inspects.filter((row) => row.pieceId === piece.id).sort((a, b) => a.date.localeCompare(b.date))
    const latestInspect = pieceInspects.length > 0 ? pieceInspects[pieceInspects.length - 1] : null
    const card = pieceCard(piece, batches, cards)
    const hours = card === null ? legacyTotalHours(piece.wallThicknessMm) : cardTotalHours(card)
    lines.push(
      [
        piece.name,
        piece.craft,
        batch?.glassType ?? '钠钙玻璃',
        piece.artist,
        piece.state,
        piece.designHeightMm,
        piece.wallThicknessMm,
        batch?.colorCode ?? '—',
        furnace?.code ?? '—',
        pieceSteps.length,
        pieceSteps.filter((row) => row.state === '已完成').length,
        Math.round(pieceSteps.reduce((acc, row) => acc + row.durationMin, 0) * 10) / 10,
        pieceAnneals.length,
        latestAnneal?.kilnSlot || (latestAnneal ? '待排' : '—'),
        latestAnneal
          ? latestAnneal.legacy
            ? '遗留无卡'
            : `${latestCard?.name ?? '卡缺失'} v${latestAnneal.cardVersion}`
          : '—',
        latestAnneal ? `${latestAnneal.state}/${latestAnneal.scheduleState}` : '—',
        formatHours(hours),
        pieceInspects.length,
        latestInspect?.result ?? '—',
      ]
        .map(csvCell)
        .join(','),
    )
  })
  return `﻿${lines.join('\n')}`
}

/** 导出窑务排产汇总 CSV 文件 */
export function exportScheduleCsvFile(
  furnaces: Furnace[],
  batches: GlassBatch[],
  pieces: Piece[],
  steps: Step[],
  anneals: Anneal[],
  inspects: Inspect[],
  cards: AnnealCard[] = [],
): string {
  const filename = `玻璃窑务排产汇总-${stampSuffix()}.csv`
  download(filename, buildScheduleCsv(furnaces, batches, pieces, steps, anneals, inspects, cards), 'text/csv;charset=utf-8')
  return filename
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}

/** 生成某件作品的工序卡片纯文本 */
export function buildStepCardText(
  piece: Piece,
  batch: GlassBatch | undefined,
  furnace: Furnace | undefined,
  steps: Step[],
  anneals: Anneal[],
  cards: AnnealCard[] = [],
): string {
  const lines: string[] = []
  const card = pieceCard(piece, batch ? [batch] : [], cards)
  const seg =
    card !== null
      ? cardSegmentHoursMap(card)
      : {
          升温: legacyTotalHours(piece.wallThicknessMm) / 3,
          保温: legacyTotalHours(piece.wallThicknessMm) / 3,
          缓冷: legacyTotalHours(piece.wallThicknessMm) / 3,
        }
  const total = card !== null ? cardTotalHours(card) : legacyTotalHours(piece.wallThicknessMm)
  lines.push(`【工序卡片】${piece.name}（${piece.craft} · ${piece.artist} · ${piece.state}）`)
  lines.push(`设计尺寸：高 ${piece.designHeightMm} mm / 壁厚 ${piece.wallThicknessMm} mm`)
  lines.push(
    `料液：${batch === undefined ? '未关联' : `${batch.colorCode}（${batch.recipe}）· ${batch.glassType}`} · 窑炉 ${furnace?.code ?? '—'}`,
  )
  lines.push(
    card !== null
      ? `退火工艺卡：${card.name} v${card.version}（${card.minMm}–${card.maxMm} mm）`
      : '退火工艺卡：未命中生效卡（回退老口径估算）',
  )
  lines.push(
    `理论退火时长：${formatHours(total)}（升温 ${formatHours(seg.升温)} / 保温 ${formatHours(seg.保温)} / 缓冷 ${formatHours(
      seg.缓冷,
    )}）`,
  )
  lines.push('工序：')
  steps
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .forEach((row) => {
      lines.push(
        `  ${row.seq}. ${row.name} · ${row.tempC} ℃ · ${row.durationMin} 分钟 · ${row.operator} · ${
          row.state
        }${row.remark === '' ? '' : ` · ${row.remark}`}`,
      )
    })
  if (anneals.length > 0) {
    lines.push('退火：')
    anneals.forEach((row) => {
      const rowCard = cards.find((item) => item.id === row.cardVersionId)
      const cardText = row.legacy ? '遗留无卡' : `${rowCard?.name ?? '卡缺失'} v${row.cardVersion}`
      lines.push(
        `  ${row.kilnSlot || '待排'} · ${cardText} · ${row.inAt} → ${row.outAt || '未出炉'} · ${row.state}/${row.scheduleState}`,
      )
    })
  }
  return lines.join('\n')
}

/** 生成补料提醒纯文本 */
export function buildRefillText(batches: GlassBatch[], furnaces: Furnace[]): string {
  const low = batches.filter((row) => isLowRemain(row.remainKg))
  if (low.length === 0) return '当前所有料液批次剩余量均在阈值以上，无需补料。'
  const lines: string[] = [`【补料提醒】以下 ${low.length} 个料液批次剩余量偏低：`]
  low.forEach((row) => {
    const furnace = furnaces.find((item) => item.id === row.furnaceId)
    lines.push(
      `· ${row.colorCode}（${furnace?.code ?? '未知窑炉'} · ${row.glassType}）剩余 ${row.remainKg} kg —— ${row.recipe}`,
    )
  })
  return lines.join('\n')
}
