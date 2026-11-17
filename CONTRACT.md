# 来源与消费契约

## 来源

入口 `/meters/M1/readings`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

register 是累计读数而非区间用量；measuredAt 与 receivedAt 含义不同。epoch 区分更换或复位后的计量周期。`fixtures/settlements.json` 为已确认区间，结算引用 readingId 与版本；迟到读数影响相邻区间，但不授权静默修改已确认账单。

## 业务消费

### 结构化集合（既有）

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；传入台账服务时返回值额外带 `ledger`（区间、复核、结算快照）。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。

### 区间台账（扩展）

1. **读数版本**：readingId 相同而内容不同视为更正，追加新版本（version 从 1 递增）并保存原始读数、measuredAt、来源 receivedAt、本地 ingestedAt、批次与内容摘要 digest；内容摘要相同的重复导入不产生新版本、不重复计量。历史版本只追加、不覆盖、不删除。
2. **区间推导**：区间由当前版本读数按测量时间排序推导，可随时重建。同 epoch 相邻读数之差为用量；epoch 变化为 `boundary`，同 epoch 累计读数倒退为 `regression`，二者 usage 为 null 且必须带 reason，不得折算为零用量或负用量；读数时间跨度超过 `LEDGER_EXPECTED_STEP_MINUTES` 标记 `coverage: gap`，用量仍按真实差值给出。
3. **结算保护**：确认结算时快照所用读数的 version + digest。确认之后：
   - 未结算区间随导入自由更新；导入结果中的 `affected`（added/removed/changed）说明被重新核对的区间。
   - 已确认结算按其读数覆盖的时间窗重算窗内区间总量，与确认值一致则无事项；不一致（含窗内出现 boundary/regression、读数缺失）生成 `open` 复核，呈现 settledValue、recomputedValue、delta、受影响区间与新旧读数版本证据，结算原值不变。
   - 复核只能由管理员显式裁决（adjust/accept/reject），裁决与后续重新打开均进入追加式 audit；`trace <readingId>` 可追到结算实际使用过的读数版本。
4. **兼容边界**：来源协议（路径、字段、分页、ETag）保持不变；台账状态独立存于 `var/ledger.json`，旧集合 `var/records.json` 与 ingest/query 行为不变。
