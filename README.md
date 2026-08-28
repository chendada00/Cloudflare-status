# Cloudflare Status V2

参考 `chendada00/edgeone-status` 的横向页签和卡片式 Dashboard，改为 Cloudflare 产品按需加载。

## 关键设计
- 首屏只调用 `/api/inventory`，不查询全部 Analytics。
- 进入 Workers/D1/KV/R2/DO/Workflows 才调用账号 GraphQL Analytics。
- Zone 先选择域名，再调用 Zone Analytics。
- 当前页数据缓存；点击刷新才重新请求。
- GraphQL 按产品拆分，避免一个产品字段错误导致全部指标显示 0。
- Zone 增加 Requests、Visits、Edge Response、国家、状态码、浏览器、设备、Colo、Firewall Action。
- D1 增加 Rows Read/Written、Queries、Storage、Response、Latency。
- Workers 增加 Requests、Errors、Error Rate、Subrequests、CPU、Wall Time。
- KV/R2/DO/Workflows 分别提供趋势、排行、操作类型等图表。

## 部署到 Cloudflare Pages
Framework preset: None；Build command 留空；Build output directory: `.`。

环境变量：
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SITE_NAME`（可选）

GraphQL Analytics 是观测数据，不应直接等同于最终账单用量。Cloudflare 官方明确区分 Analytics 与 Billable Usage。
