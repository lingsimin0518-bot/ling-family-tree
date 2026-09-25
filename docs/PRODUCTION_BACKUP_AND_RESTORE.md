# 生产 D1 备份与本地恢复验证

本功能用于在执行 `0006_collaboration_persistence.sql` 之前，对 Sites 托管的生产 D1 创建完整的只读逻辑备份。

## 谁可以导出

只有系统级 `SUPER_ADMIN` 可以访问系统后台的“生产备份”页面并调用导出接口。族谱内部的 `OWNER`、`ADMIN`、`EDITOR`、`VIEWER` 均无权导出。

后端接口为：

```text
POST /api/admin/backups/export
```

接口在 Worker 后端执行 `requireSuperAdmin(request)`，不是仅通过前端隐藏按钮限制。

## 如何导出

1. 使用 `SUPER_ADMIN` 账号登录。
2. 进入 `/admin`。
3. 选择“生产备份”。
4. 阅读敏感数据提示。
5. 点击“生成并下载完整备份”。
6. 将下载的 `production-before-0006-时间.zip` 保存到受保护的备份目录。

导出是只读操作，不会执行 `INSERT`、`UPDATE` 或 `DELETE`，也不会应用 migration。

## 备份内容

ZIP 包含 `manifest.json`、`checksums.json`、Schema 说明和以下13张表的独立 JSON：

- `action_idempotency`
- `action_rate_limit`
- `announcements`
- `families`
- `family_users`
- `generations`
- `media`
- `person_claims`
- `persons`
- `relationships`
- `system_audit_logs`
- `user_sessions`
- `users`

备份保留完整恢复所需的敏感数据，包括密码哈希、邮箱、手机号、登录会话和完整族谱资料。

## 安全保存

- 不要把备份提交到 Git。
- 不要发送到普通聊天、邮件附件或公开网盘。
- 建议保存到加密磁盘或权限受限的离线目录。
- 不要在日志中打印表数据或备份内容。
- 从备份恢复出的 `user_sessions` 可能仍然有效，验证环境必须保持本地隔离。

项目 `.gitignore` 已排除 `/backups/`、`production-before-*.zip` 和 `*.production-backup.zip`，但这不能替代安全保管。

## 本地恢复验证

在项目目录运行：

```powershell
pnpm backup:verify -- "F:\Backups\ling-family-tree\production-before-0006-时间.zip"
```

验证工具会：

1. 检查 ZIP 文件集合和 manifest。
2. 确认13张表齐全。
3. 校验 SHA-256。
4. 在系统临时目录创建全新的隔离本地 D1。
5. 仅应用 `0000` 至 `0005` migration。
6. 确认本地目标库为空。
7. 导入13张表。
8. 对比每张表的实际行数与 manifest。
9. 执行外键一致性检查。

工具不会使用 `--remote`，并会从子进程环境中移除 Cloudflare API Token 和 Account ID。它不会覆盖已有的本地数据库。

全部检查成功时，最后输出：

```text
PASS：备份结构、校验和、本地恢复、13张表行数和外键检查全部通过。
```

出现任何 `FAIL` 时，都不能使用该文件作为执行 `0006` 前的有效备份。

## 当前限制

- 这是应用层逻辑备份，不是 Sites 平台的时间点数据库快照。
- 导出前后会核对每张表行数；如果行数变化，导出失败。
- Worker 存在内存和响应大小限制，达到安全上限时接口会明确失败，不会截断数据。
- 当前没有线上一键恢复功能。
- 本工具只用于本地恢复验证，不会恢复或覆盖生产 D1。
