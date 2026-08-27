# Cloudflare Status

基于 Cloudflare Pages Functions 的账号级监控面板，页面风格参考 EdgeOne Status，但后端和指标体系按 Cloudflare API/GraphQL 重新实现。

## 已实现

- Zone：HTTP Requests、Bytes、Cached Bytes、Threats、趋势图
- Workers：Requests、Errors、Subrequests、CPU Time、趋势图
- D1：Read/Write Queries、Rows Read/Written、Response Bytes、Query Latency、Storage
- KV：Operations、Storage、操作饼图
- 资源发现：Zones、Workers、D1、KV、R2、Durable Objects
- Billable Usage：调用 Cloudflare 账户用量 API，接口不可用时不影响其它页面
- 1/7/30 天切换、Zone 筛选、暗色模式、响应式页面
- 所有 Cloudflare 密钥仅在服务端 Pages Functions 环境变量中使用

## 部署

1. 上传整个项目到 GitHub。
2. Cloudflare Dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git。
3. Framework preset 选 None。
4. Build command 留空。
5. Build output directory 填 `.`。
6. 在 Settings -> Environment variables 添加：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - 可选 `SITE_NAME`
   - 可选 `SITE_ICON`
7. 重新部署。

## API Token 权限

按最小权限原则创建只读 Token。建议先添加：

- Zone / Zone / Read
- Account / Workers Scripts / Read
- Account / D1 / Read
- Account / Workers KV Storage / Read
- Account / R2 / Read
- Account / Durable Objects / Read
- Account / Account Analytics / Read
- Account / Billing / Read（如果账户/API 支持 Billable Usage）

不同 Cloudflare 产品和 GraphQL 数据集的权限要求可能随 Cloudflare API 调整。某个数据集没有权限时，本项目会显示“部分指标未获取”，其它指标继续工作。

## 重要说明

Cloudflare GraphQL 数据集不是所有账户、所有套餐、所有产品都保证开放相同字段。本项目对每组指标独立降级处理。Billable Usage API 目前属于 Alpha/Restricted 体系，账户未开放时可能返回错误；这不是页面代码错误。

