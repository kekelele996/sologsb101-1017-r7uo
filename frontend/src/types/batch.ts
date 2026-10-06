/**
 * 料液批次（GlassBatch）
 * 取料时按剩余量扣减，低于阈值高亮提示补料。
 * glassType 为料性归类，决定作品退火时适用哪一系退火工艺卡。
 */
import type { GlassType } from './card'

export interface GlassBatch {
  id: string
  /** 所属熔化炉 / 坩埚炉 */
  furnaceId: string
  /** 色号 */
  colorCode: string
  /** 配方 */
  recipe: string
  /** 玻璃种类（料性）：老库数据升级时按钠钙玻璃兜底 */
  glassType: GlassType
  /** 熔化日期 YYYY-MM-DD */
  meltDate: string
  /** 出料温度（℃） */
  tempC: number
  /** 剩余量（kg） */
  remainKg: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑料液批次的表单草稿 */
export interface GlassBatchDraft {
  furnaceId: string
  colorCode: string
  recipe: string
  glassType: GlassType
  meltDate: string
  tempC: number
  remainKg: number
}
