# Cloudflare Monitor

Cloudflare Monitor 是一个基于 Cloudflare GraphQL Analytics 与账户资源 API 的轻量级监控看板，用于集中查看账户下网站（Zone）、Workers、D1、KV、R2 与 Durable Objects 等资源及运行数据。

网站采用按页签懒加载的方式：打开概览时仅获取资源清单，切换到具体产品后再加载对应 Analytics 数据，并提供当天、24 小时、7 天、14 天和 30 天等查询范围。页面以简洁的卡片、趋势图和状态信息展示 Cloudflare 资源运行情况，适合部署在 Cloudflare Pages 上作为个人或团队的轻量监控面板。
