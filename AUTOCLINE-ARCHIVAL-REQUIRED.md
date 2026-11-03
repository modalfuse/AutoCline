# AUTOCLINE — 阶段性归档 REQUIRED（t851u）

**立刻遵守。** 不要只改代码不提交。

教训：`cj_8e8b4ecb57c6` 跑完时 `/home/joe/src/AutoCline` 整目录消失，Hub 多 listen + Desktop 直连的**未提交**改动全部丢失。

## 每个里程碑完成后、下一里程碑开始前

1. `git add` + `git commit`（分支 `feat/remote-session-swr-cache`）
2. `git bundle create ~/builds/AutoCline/feat-remote-session-swr-cache-vX.Y-YYYYMMDD.bundle HEAD`
3. （可选）同名 `.patch`；更新 `~/builds/AutoCline/README.md` 一行：tip SHA + 里程碑说明
4. **禁止**仅依赖未提交 worktree

权威全文：`/home/joe/docs/AutoCline任务.md` §0.7（v1.2.1）  
产品要求仍有效：hubUrls 直连 only / 无 SSH -L / listenHosts 配置列表 / 拒 0.0.0.0 / 保留 SWR。
