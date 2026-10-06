/** 安装内存 IndexedDB / IDBKeyRange（模块导入即生效，供 Node 端到端脚本使用） */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

const g = globalThis as unknown as { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange }
g.indexedDB = new IDBFactory()
g.IDBKeyRange = IDBKeyRange

export function fakeDB(): void {
  // 已在模块顶部完成安装；保留空函数兼容显式调用
}
