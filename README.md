# 玻璃吹制工序与退火窑编排台（sologsb101-1017）

面向玻璃工作室的窑务排产员：把每件作品的取料、吹制、塑形、开模、收口逐道工序排定，
分配退火窑位与温度曲线，出炉检验并归档；窑位冲突时禁止提交，不合格自动生成返工提示。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22817**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbglassblow` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 | `<script setup>` 组合式 API |
| 语言 | TypeScript 5 | `strict` 模式，`vue-tsc --noEmit` 零错误 |
| UI 组件库 | Element Plus 2 | 表格、表单、弹窗、日期时间选择、进度条、消息提示 |
| 图标 | @element-plus/icons-vue | 入口统一全局注册 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22817） |
| 路由 | Vue Router 4 | `createWebHistory` + 路由懒加载 |
| 状态管理 | Pinia 2 | setup store，跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbglassblow`，`v2` 为 Piece 增加 craft；**`v3` 新增退火工艺卡表、批次玻璃种类、排位卡版本与排产状态** |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1017/
├── README.md
├── docker-compose.yml          # name: gbglassblow，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：Pinia + Router + Element Plus + 初始化数据库
        ├── App.vue             # 外壳：顶部导航 + 当前作品上下文 + 页脚
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # furnace.ts batch.ts piece.ts step.ts card.ts anneal.ts inspect.ts
        ├── stores/             # furnaceStore.ts pieceStore.ts cardStore.ts annealStore.ts
        ├── components/common/  # StageTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useStepProgress.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（含 CardBook 退火工艺卡）
        ├── router/index.ts     # 路由表 + ROUTES 常量
        └── utils/              # thermal.ts db.ts defaultCards.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/furnaces` | `pages/FurnaceList.vue` | 窑炉与料液台账：新建/编辑/级联删除窑炉、登记料液批次（含玻璃种类）、取料按剩余量扣减、低于阈值高亮提示补料 |
| `/pieces` | `pages/PieceList.vue` | 作品登记与设计尺寸录入：按工艺与状态筛选、设计尺寸比例校验、显示工序完成度与当前道次 |
| `/pieces/:id/steps` | `pages/StepDetail.vue` | 吹制工序逐道记录：拖拽排序、回填温度/时长/操作人、推进工序状态、前序未完成阻断进入退火排位 |
| `/cards` | `pages/CardBook.vue` | **退火工艺卡**：按玻璃种类 × 壁厚区间立卡，三段速率/目标温度/保温时长；每调一次另存新版本，旧版留档 |
| `/annealing` | `pages/AnnealingBoard.vue` | **退火窑位排产**：挑卡排窑位、时段按卡版本推算；卡升版自动重算未进窑排位（撞位退回待排）、按版本对账、进窑冻结 |
| `/export` | `pages/ExportView.vue` | 出炉检验登记（不合格生成返工提示）+ JSON 结构版本查看与导入导出 + 窑务 CSV 汇总 |

`/` 重定向到 `/furnaces`，未匹配路径统一回落到 `/furnaces`。
**层级路由支持直接深链**：把 `http://localhost:22817/pieces/piece-morning-vase/steps` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「作品不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbglassblow`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`
  * `db.version(1)`：建立全部表与 `[pieceId+seq]` 复合索引；
  * `db.version(2)`：**为 `Piece` 增加 `craft` 索引并回填默认值**，同时补齐其余索引与字段；
  * `db.version(3)`：**新增退火工艺卡，退火参数不再写死在程序里**：
    * 新增 `annealCards` 表（`[cardKey+version]` 复合索引）；
    * `batches` 增加 `glassType`（玻璃种类），老批次按「钠钙玻璃」兜底；
    * `anneals` 增加 `cardVersionId / cardKey / cardVersion / scheduleState / legacy`；
    * `.upgrade()` 中先灌入 6 张内置「当时那版（v1）」基准卡（三种料性 × 薄壁/厚壁）；
    * **旧排位没记卡版本：按作品玻璃种类（取批次）+ 壁厚套当时那版卡**，套中即补绑；
      壁厚超出所有卡区间套不上的，置 `legacy = true` **留成只读**（待入窑的同时退回待排）。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `furnaces` | id | code, type, state, fuelType, createdAt, updatedAt |
  | `batches` | id | furnaceId, colorCode, **glassType**, meltDate, remainKg |
  | `pieces` | id | batchId, state, artist, craft, name |
  | `steps` | id | pieceId, **[pieceId+seq]**, seq, state, name |
  | `annealCards` | id | cardKey, **[cardKey+version]**, glassType, state, version |
  | `anneals` | id | pieceId, kilnSlot, state, **scheduleState**, inAt, curveSeg, cardVersionId, cardKey |
  | `inspects` | id | pieceId, date, result, inspector |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `furnaces` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **工艺卡 → 窑炉 → 料液批次 → 作品 → 吹制工序 → 退火 → 出炉检验**，
  并互相引用：
  * 6 张退火工艺卡（钠钙 / 钾铅 / 硼硅 × 薄壁 / 厚壁，全部 v1 生效）；
  * 3 台窑炉（KILN-01 熔化炉 / KILN-02 坩埚炉 / AN-01 退火窑）；
  * 4 批料液（含 `A-207` 剩余 42 kg，故意低于 60 kg 补料阈值用于验证高亮与提醒）；
  * 5 件作品（覆盖四种状态与三种工艺）、17 道吹制工序（每件 2–5 道，seq 连续）；
  * 4 条退火排位（窑位 A1/A2/A3/B1 互不冲突，各绑定对应料性/壁厚的卡版本，覆盖已出炉 / 退火中 / 待入窑）；
  * 3 条出炉检验（含一条「裂纹」不合格 + 一条返工后复检合格）。
  * 固定 id 如 `piece-morning-vase`、`piece-frost-bottle` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的作品 id」这一界面偏好，不存业务数据。
* 删除窑炉会级联清理其料液批次；删除作品会级联清理其工序、退火与检验记录（均在同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22817
```

其他命令：

```bash
npm run build        # vue-tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则（`src/utils/thermal.ts` + `db.ts`）

* **退火工艺卡（不再写死曲线）**
  * 工艺技术组在 `/cards` 按「玻璃种类（钠钙 / 钾铅 / 硼硅）× 壁厚区间」立卡，
    分别定义**升温 / 保温 / 缓冷三段的目标温度、升降温速率与保温时长**；
  * 每调一次参数「另存新版本」：旧版自动置 `archived` **留档只读**，同卡系（`cardKey`）始终只有一个 `active` 版；
  * `cardKey` 跨版本稳定（即使本版改了壁厚区间也不迁移），便于排位持续对账。
* **排窑位与时段推算**
  * 排产员在 `/annealing` 先挑一张卡（按作品玻璃种类＝其料液批次的 `glassType`、壁厚自动筛出适用生效卡）；
  * 排位保存时**冻结 `cardVersionId / cardVersion`**；预计出炉＝入窑 + 该卡三段合计时长；
  * 同一窑位时间窗重叠即冲突，**冲突时禁用提交**（待排 / 待确认的排位不占窑位）。
* **卡升版联动（`publishCardVersion` 同一事务）**
  * 已进窑（退火中 / 已出炉）的排位**冻结原版本照当初那版烧完**，不重算；
  * 未进窑排位按新版重算：新版仍覆盖壁厚且窑位不撞 → 重绑新版本保持「已排」；
    **撞了别人 → 退回「待排」并清空窑位**；新版区间/料性已不覆盖该件 → 置「待确认」。
* **按卡版本对账（`reconcileSchedules`）**
  * 未进窑排位冻结版本 ≠ 卡系当前生效版本 → 置「待确认」先搁着等人工处理；
  * 「按新版对齐」（`resolveSchedule`）会再算一次：仍无覆盖卡保持待确认、撞位退回待排、否则回到已排；
  * 已进窑排位跑旧版是预期行为，不算异常。
* **老库升级（v2 → v3）**
  * 批次补玻璃种类（默认钠钙玻璃）；旧排位按作品壁厚套内置「当时那版 v1」卡补绑；
  * 壁厚超出所有卡区间、套不上卡的排位置 `legacy` **只读留档**，不能编辑 / 推进。
* **温度单位换算**：℃ ↔ ℉（`cToF` / `fToC`）。
* **工序温度校验**：不得超过所选窑炉的 `maxTempC`，且应落在工艺适宜区间（吹制 900–1200 ℃ / 铸造 800–1150 ℃ / 热塑 700–1000 ℃）附近。
* **设计尺寸校验**：壁厚需 ≥ 1.5 mm 且小于设计高度的 1/8，否则给出成型与退火难度提示。
* **前序阻断**：任一前序工序未推进到「已完成」，`/pieces/:id/steps` 的「进入退火排位」会给出明确阻断原因。
* **状态回写**：退火状态推进到「已出炉」即把作品状态回写为「已退火」；登记出炉检验后回写为「已检验」；
  判定不合格时生成返工提示，**原始工序记录完整保留**。
* **料液扣减**：取料按剩余量扣减（不足时扣到 0），剩余量低于 60 kg 时列表行高亮并在顶部汇总提醒。

### 端到端业务验证

```bash
npm run test:e2e     # 内存 IndexedDB：v2→v3 升级套卡/只读、升版重算撞位退回、进窑冻结、版本对账
```
