# Cloudflare Monitor V6

基于 Cloudflare GraphQL Analytics API 的 Cloudflare 监控面板，页面视觉参考 EdgeOne Status。

## 本版修复

- Durable Objects 不再请求当前账户 Schema 中不存在的 `namespaceId` 输出字段。
- Workflows 不再请求当前账户 Schema 中不存在的 `stepName` 输出字段；改用官方可用的 Workflow / Event Type 数据。
- Queues 使用当前官方的 `queuesBacklogAdaptiveGroups` 和 `queueID`。
- Workers 增加 Memory P50/P90/P99 与 Memory 趋势。
- Durable Objects 增加 Memory P50/P90/P99 趋势。
- 默认时间范围为 1 天。
- 刷新按钮移动到横向页签右侧。
- 页签和内容先显示骨架框架，再异步填充数据。
- 删除页面上的“懒加载”等开发实现说明。
- 删除 Metric / Chart 卡片顶部彩色装饰条。
- 使用系统中文字体，降低标题、数字和深色模式字体粗细。
- ECharts 字体和坐标轴字号降低，减少视觉拥挤。

## Cloudflare GraphQL

Cloudflare GraphQL Analytics Schema 是动态的。不同账户、Zone、套餐可能暴露不同 Dataset / Field；项目应优先以实际账户 Introspection / Settings 为准。

## 部署

Cloudflare Pages：

- Framework preset: None
- Build command: 留空
- Build output directory: `.`

环境变量：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SITE_NAME`（可选）
