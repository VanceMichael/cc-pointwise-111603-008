# 园区电表读数台账

Node.js 本地数据接入项目。一次来源读取、结构化导入与操作查询保留；在其之上扩展了面向**迟到读数与更正**的区间台账：读数按版本留存、区间可随时重建、已确认结算受保护且差异必须由管理员显式处理。来源服务和业务存储独立，来源变化不会自动刷新本地集合。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为与本地接口测试；`npm run demo` 启动临时来源并演示「首批导入 → 迟到中间读数 → 确认结算 → 更正读数 → 复核差异 → 版本追溯」完整链路，结束时自动清理临时数据。`npm run acceptance` 在临时目录中验证上述链路与旧链路的重启回读、重放幂等。演示数据不访问生产站点。

- 旧入口：`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`。
- 台账入口（状态写入独立的 `var/ledger.json`，不覆盖旧集合）：
  - `npm start -- ledger-import [文件]`：导入来源原始读数（默认 `fixtures/meter-readings.json`），返回新增版本、重复去重、受影响区间与待处理复核数
  - `npm start -- intervals`：查看当前区间台账（computed / boundary / regression，complete / gap）
  - `npm start -- confirm [文件]`：确认结算并快照当时读数版本（默认 `fixtures/settlements.json`）
  - `npm start -- reviews`：查看待管理员处理的已确认结算差异
  - `npm start -- resolve <结算ID> <adjust|accept|reject> [说明]`：显式裁决差异
  - `npm start -- settlements`：查看已确认结算（含读数版本快照）
  - `npm start -- trace <读数ID>`：追溯读数的全部版本、参与区间与被结算引用的版本
- 环境变量 `LEDGER_EXPECTED_STEP_MINUTES` 设定预期采集步长（分钟），超过步长的区间标记 `coverage: gap`；不设置则不做缺口判定。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析来源页面并保留原始来源属性。`src/service.js` 与 `src/repository.js` 维护旧的结构化集合；`src/operations.js` 同时提供旧集合视图与新区间台账视图。

### 区间台账（新增）

- `src/ledger-store.js`：纯函数核心，磁盘状态即其数据结构，无 I/O。
  - 读数按 `readingId` 保存**全部版本**，每个版本保留原始读数、测量时间 `measuredAt`、来源接收时间 `receivedAt`、本地入库时间 `ingestedAt`、批次号与内容摘要 `digest`。相同内容重复导入只计 `duplicates`，不产生新版本、不重复计量；同 ID 的不同内容追加版本，历史版本永不覆盖。
  - `buildIntervals` 按测量时间排序推导区间：同 epoch 相邻读数差值为用量；epoch 变化（换表/复位）产出 `boundary`、同 epoch 读数倒退产出 `regression`，两者 `usage` 均为 `null`，绝不产出零用量或负用量；时间缺口只标记 `coverage: gap`，真实差值照算。
  - `confirmSettlements` 快照确认时使用的读数版本（version + digest）。之后任何导入都先重建区间再 `recheckSettlements`：一致则无复核；不一致则生成/刷新 `open` 复核，给出确认值、重算值、差额、受影响区间以及新旧两套读数版本证据，**确认账单原值保持不变**。复核经 `resolveReview` 显式裁决（adjust/accept/reject）并写入审计；再次出现差异会重新打开并保留裁决史。
  - `traceReading` 可追到一个读数的所有版本、参与的区间以及结算实际使用过的版本。
- `src/ledger-repository.js` / `src/meter-ledger.js`：原子持久化与应用服务。每次导入返回 `affected`（added/removed/changed 区间 ID），让迟到中间读数分裂、改写的区间一目了然。
- `fixtures/meter-readings*.json`：首批、迟到、更正、换表/复位、倒退等场景数据；`fixtures/settlements.json` 为已确认区间样例。

状态目录属于运行产物。扩展导入保留现有 CLI 和现有集合查询能力；新增状态独立组织在 `var/ledger.json`。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。

`npm start` 或 `npm start -- --help` 查看全部命令；原导入和查询使用显式的 ingest、query 动作。
