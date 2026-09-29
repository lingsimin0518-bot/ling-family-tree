# 生产 D1 备份与本地恢复验证

本功能为 Sites 托管的生产 D1 创建只读逻辑备份。导出器会先检查真实表结构，只接受两个完整、稳定的结构：

- schema 0006：16 张业务表；
- schema 0010：19 张业务表（恢复工具也兼容 0008/0009 的19表结构）。

如果只出现部分认证新表，导出会整体失败，不会把半升级数据库标记为有效备份。

## 谁可以导出

只有系统级 SUPER_ADMIN 可以调用 POST /api/admin/backups/export。族谱内部 OWNER、ADMIN、EDITOR、VIEWER 均无权导出。维护模式开启时，此只读运维能力仍保留。

## 导出方式

1. 使用 SUPER_ADMIN 登录。
2. 进入 /admin 的“生产备份”。
3. 点击“生成并下载完整备份”。
4. 把 production-schema-版本-时间.zip 保存到项目外的受保护目录。

导出只执行读取、导出前后行数核对与校验和计算，不应用 migration，也不执行业务数据写入。

## ZIP 内容

每个备份都包含 manifest.json、checksums.json、schema/schema.json、schema/README.md 和每张表独立的 tables/表名.json。

manifest 是表集合的权威来源，记录真实 schema_version、表文件、逐表行数和 SHA-256。

schema 0006 包含16张表：

action_idempotency、action_rate_limit、announcements、families、family_activities、family_users、generations、media、person_claims、persons、relationships、review_requests、system_audit_logs、user_messages、user_sessions、users。

schema 0010 在此基础上增加 phone_change_challenges、sms_verifications、user_identities。

## 安全保存

备份包含密码哈希、邮箱、手机号、登录会话和完整族谱资料：

- 不得提交到 Git；
- 不得发送到普通聊天、邮件附件或公开网盘；
- 建议保存在加密磁盘或权限受限的离线目录；
- 不在日志中打印表数据或备份内容；
- 本地恢复环境必须隔离，因为恢复的 user_sessions 可能仍有效。

.gitignore 排除 /backups/、production-before-*.zip、production-schema-*.zip 和 *.production-backup.zip。

## 本地恢复验证

运行：

    pnpm backup:verify -- "F:\Backups\ling-family-tree\production-schema-0006-时间.zip"

验证工具依据 manifest：

1. 验证 schema 与精确表集合；
2. 验证 ZIP 无缺失文件或多余文件；
3. 验证全部 SHA-256；
4. 创建全新的隔离本地 D1；
5. 只应用与备份版本匹配的 migration；
6. 确认目标库所有对应表均为空；
7. 按外键安全顺序导入；
8. 对比逐表行数；
9. 执行外键检查。

工具不使用 --remote，并移除子进程中的 Cloudflare Token 与 Account ID。

本地双版本回归：

    pnpm backup:test-fixture

该命令分别生成并恢复验证 0006/16表 与 0010/19表 的纯本地测试备份。

## 当前限制

- 这是应用层逻辑备份，不是平台时间点快照；
- 导出前后任一表行数变化都会导致整体失败；
- 达到 Worker 安全内存上限时会明确失败，不会截断；
- 没有线上一键恢复；
- 恢复工具只面向全新本地 D1，不覆盖现有库。
