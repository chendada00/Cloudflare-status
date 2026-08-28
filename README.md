# Cloudflare Status — EdgeOne Status UI Edition

本版本按 `chendada00/edgeone-status` 的视觉体系重新设计：玻璃面板、Hero、横向 Tab、时间控制、Metric Card、Chart Card、主题切换。

## 重要修复

- 所有 REST 资源统一做数组归一化，不再因为 Cloudflare 返回 object 而触发 `.map is not a function`。
- 每个产品使用独立 GraphQL 请求：Workers / D1 / KV / R2 / Durable Objects / Zone。
- 一个产品查询失败不会把其它产品全部变成 0。
- 错误直接显示 Cloudflare 返回的错误，而不是伪装成 0。
- 首页只读取资源清单。
- Zone 只有选择具体域名后才读取 Zone Analytics。
- 1/7/14/30 天切换；KV、D1、R2 等官方 Analytics 当前保留周期以 Cloudflare 文档为准。
- R2 使用 `objectCount / uploadCount / payloadSize / metadataSize`。
- KV 使用 `keyCount / byteCount`。
- Durable Objects 增加 Memory P50/P99。

## 部署

Cloudflare Pages 连接 GitHub：

- Framework preset: None
- Build command: 留空
- Build output directory: `.`
- Functions 自动识别 `/functions`。

环境变量：

`CLOUDFLARE_API_TOKEN`
`CLOUDFLARE_ACCOUNT_ID`
`SITE_NAME`（可选）

建议 API Token 使用最小必要权限。

## 说明

Cloudflare GraphQL Analytics 是观测数据，不应直接当成最终账单。免费额度/计费页面建议使用 Cloudflare Billable Usage 的专用接口或控制台口径。
