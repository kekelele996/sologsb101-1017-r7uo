/**
 * 默认退火工艺卡（v1，「当时那版」）
 * 工艺技术组立卡前的内置基准卡：覆盖三种料性 × 薄壁/厚壁两档，共 6 张 v1。
 * - 新库首屏播种时写入；
 * - 老库升级 v3 时用于「按作品壁厚套当时那版」补绑卡版本。
 * 所有时长参数中，保温按常见经验取整（小时），升降温给出速率与目标温度。
 */
import type { AnnealCard, CardCurve, GlassType } from '../types/card'
import { buildCardKey } from './thermal'

/** 默认卡固定 id 前缀，保证升级与播种引用稳定 */
export const DEFAULT_CARD_ID_PREFIX = 'card-default'

interface DefaultCardSpec {
  key: string
  name: string
  glassType: GlassType
  minMm: number
  maxMm: number
  note: string
  curve: CardCurve
}

/** 默认卡固定行 id（cardVersionId 用），形如 card-default-钠钙玻璃-thin */
export function defaultCardId(spec: Pick<DefaultCardSpec, 'key'>): string {
  return `${DEFAULT_CARD_ID_PREFIX}-${spec.key}`
}

const c = (
  heat: [number, number, number],
  holdTemp: number,
  holdHours: number,
  cool: [number, number, number],
): CardCurve => ({
  升温: { startC: heat[0], endC: heat[1], rateCPerHour: heat[2], holdHours: 0 },
  保温: { startC: holdTemp, endC: holdTemp, rateCPerHour: 0, holdHours },
  缓冷: { startC: cool[0], endC: cool[1], rateCPerHour: cool[2], holdHours: 0 },
})

/**
 * 内置六张基准卡（v1）。
 * 元组含义：升温 [起℃, 止℃, ℃/h]；保温（退火点℃, 小时）；缓冷 [起℃, 止℃, ℃/h]。
 */
export const DEFAULT_CARD_SPECS: DefaultCardSpec[] = [
  {
    key: '钠钙玻璃-thin',
    name: '钠钙玻璃 · 薄壁',
    glassType: '钠钙玻璃',
    minMm: 0,
    maxMm: 5,
    note: '钠钙玻璃薄壁件基准卡：退火点 560 ℃，缓冷可稍快。',
    curve: c([20, 560, 120], 560, 1.2, [560, 60, 40]),
  },
  {
    key: '钠钙玻璃-thick',
    name: '钠钙玻璃 · 厚壁',
    glassType: '钠钙玻璃',
    minMm: 5.01,
    maxMm: 100,
    note: '钠钙玻璃厚壁件基准卡：延长保温、放慢缓冷，防止厚件炸裂。',
    curve: c([20, 560, 90], 560, 2.4, [560, 60, 25]),
  },
  {
    key: '钾铅玻璃-thin',
    name: '钾铅玻璃 · 薄壁',
    glassType: '钾铅玻璃',
    minMm: 0,
    maxMm: 5,
    note: '钾铅晶质玻璃薄壁件基准卡：退火点约 470 ℃。',
    curve: c([20, 470, 100], 470, 1.0, [470, 60, 35]),
  },
  {
    key: '钾铅玻璃-thick',
    name: '钾铅玻璃 · 厚壁',
    glassType: '钾铅玻璃',
    minMm: 5.01,
    maxMm: 100,
    note: '钾铅晶质玻璃厚壁件基准卡：放慢升降温，充分均热。',
    curve: c([20, 470, 75], 470, 2.0, [470, 60, 22]),
  },
  {
    key: '硼硅玻璃-thin',
    name: '硼硅玻璃 · 薄壁',
    glassType: '硼硅玻璃',
    minMm: 0,
    maxMm: 5,
    note: '硼硅酸盐玻璃薄壁件基准卡：退火点约 565 ℃，料性较稳。',
    curve: c([20, 565, 110], 565, 1.0, [565, 70, 45]),
  },
  {
    key: '硼硅玻璃-thick',
    name: '硼硅玻璃 · 厚壁',
    glassType: '硼硅玻璃',
    minMm: 5.01,
    maxMm: 100,
    note: '硼硅酸盐玻璃厚壁件基准卡：厚截面仍需放慢缓冷。',
    curve: c([20, 565, 85], 565, 2.2, [565, 70, 30]),
  },
]

/** 构造默认卡行（v1 / active）；createdAt 由调用方传入 */
export function buildDefaultCards(stamp: string, revision: number): AnnealCard[] {
  return DEFAULT_CARD_SPECS.map((spec) => ({
    id: defaultCardId(spec),
    cardKey: buildCardKey(spec.glassType, spec.minMm, spec.maxMm),
    name: spec.name,
    glassType: spec.glassType,
    minMm: spec.minMm,
    maxMm: spec.maxMm,
    version: 1,
    state: 'active',
    curve: spec.curve,
    note: spec.note,
    createdAt: stamp,
    updatedAt: stamp,
    revision,
  }))
}
