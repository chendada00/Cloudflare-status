# Cloudflare Monitor V11

这版按 `edgeone-status` 的核心交互思路重新整理，但没有继续堆叠玻璃拟态和大量装饰。

## 主要改动

- 概览页只请求资源清单，不打开页面就请求所有 Analytics；时间范围在概览页自动隐藏。
- 概览页移除无实际意义的资源饼图和 Queues 空白卡片，改为资源总数、启用产品数和资源清单。
- 页签去掉 Emoji 图标，保持简洁文字导航；刷新按钮移动到页面底部。
- 每个产品页签独立请求，切换页签才请求数据。
- Zone 页签支持选择 Zone。
- Workers / D1 / KV / R2 / Durable Objects 均独立处理；Queues / Workflows 不再放入导航与概览。
- Zone 的 HTTP Analytics 与 Firewall Analytics 分开请求：其中一个数据集不可用时，另一个仍能显示。
- 去掉大面积渐变、玻璃卡片和过重阴影，改成更接近 Cloudflare Dashboard 的简洁风格。
- 默认时间范围为 24 小时，最多 30 天。
- 加载改为 EdgeOne 风格的小圆点脉冲动画，保留空数据状态、错误提示、深色模式。
- API 统一由 `functions/api/[[path]].js` 路由，避免两个 wildcard Function 同时维护造成路由行为不一致。

## 部署

Cloudflare Pages：

- Framework preset: None
- Build command: 留空
- Build output directory: `.`
- Environment variables:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`

API Token 至少需要对应 Analytics Read 权限，以及读取资源列表所需的账户权限。

## 替换步骤

1. 用本目录的 `index.html` 替换仓库根目录 `index.html`。
2. 用本目录的 `functions/api/[[path]].js` 替换原文件。
3. 删除旧的 `functions/api/[[default]].js`，不要保留两个重复的 API wildcard。
4. 保留 `.dev.vars.example` 等配置文件。
5. 提交并重新部署 Pages。

Cloudflare GraphQL Analytics 的 schema 会随产品、账户和套餐变化，因此代码采用“单产品独立请求 + 局部 warnings”的策略，而不是让一个总 GraphQL 查询失败后整页不可用。
