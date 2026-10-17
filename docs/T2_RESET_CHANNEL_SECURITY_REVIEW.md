# T2.1 一次性 Production Reset 通道安全审计

日期：2026-10-17（Asia/Tokyo）。

基线：`2f9718ad98b5480d3eaa09851655d043ab99d789`，对应已部署 Version 41。
分支：`codex/t2-production-reset-channel`。

本审计只覆盖新增运维通道及其触及的生命周期核心。没有创建 Sites
Version、部署、配置生产 Secret、执行生产 Reset/Bootstrap、注册正式账号或
解除维护。测试只使用新建本地 D1 和测试夹具。

## 审计结论与证据

### R01 · High · 已修复：并发授权快照可能过期

规则：NEXT-AUTH-001 / NEXT-INJECT-001。

位置：`lib/production-lifecycle.ts:128`、
`lib/production-reset-channel.ts:100` 和 `:181`。

原核心在 batch 外检查管理员；并发请求可能同时通过旧身份检查。
新核心在同一 D1 batch 的第一条 NOT NULL 断言中重新检查 ACTIVE
SUPER_ADMIN，以及本次执行锁的 nonce。任何断言或 DELETE 失败都整批回滚。
限流计数和抢占锁的 INSERT/UPDATE 也在 SQL 内检查仍存活的 SUPER_ADMIN，
避免迟到请求在清库后重新留下操作记录。固定 19 表 DELETE 顺序未复制或改变。

验证：DELETE 故障触发器导致整批回滚；三请求并发仅一个成功，所有请求结束后
19 表仍为 0；成功后旧 Session 返回 401。

### R02 · High · 已实现：独立认证和 CSRF 边界

规则：NEXT-AUTH-001 / NEXT-CSRF-001 / NEXT-HOST-001。

位置：`app/api/admin/operations/production-reset/route.ts:7`、
`lib/production-reset-channel.ts:47` 和 `:124`。

现有 requireSuperAdmin 仍是认证来源。请求还必须通过 production 环境、
维护模式、显式开关、ACTIVE 状态、额外 Header Secret、精确确认文本、
Project/DB binding、批准的 Version/Deployment、实际 0010/19 表、备份 SHA
和外键门禁。固定 HTTPS Origin、Host、请求 URL、路径必须一致；query 一律拒绝。
不信任 forwarded-host，不启用跨站 CORS。GET 仅返回固定 JSON 405。

验证：USER、族谱 OWNER/ADMIN、匿名、禁用和过期会话均拒绝；错误来源、
Host、fetch 元数据、确认文本和目标均拒绝；所有拒绝不清空原业务记录。

### R03 · High · 已实现：持久化尝试上限和失败锁

规则：NEXT-DOS-001。

位置：`lib/production-reset-channel.ts:100`、`:151` 和 `:181`。

复用 action_idempotency，不新增表。批准的操作元组生成固定操作 key；
全局最多三次已认证尝试，不因换 Session、换 IP、Worker 重启或时间推移自动清零。
第四次固定拒绝。核心失败保留 FAILED 锁并拒绝重放，不自动重试 DELETE。

此设计可能在管理员误输后主动停止整次操作，这是有意的 fail-closed 行为。
不得添加可随意清零计数器的线上接口。

### R04 · Medium · 已实现：输入、Secret 与响应最小化

规则：NEXT-SECRETS-001 / NEXT-INPUT-001 / NEXT-LOG-001 / NEXT-ERROR-001。

位置：`lib/production-reset-channel.ts:41`、`:58`、`:157`、`:206`。

Secret 仅从服务端环境和指定 Header 读取，接受 32–64 随机字节的十六进制编码；
恒定时间比较复用原核心工具。JSON 白名单仅七个字段，流式读取上限 2048 字节。
不接受表名、用户身份、Secret 或任意额外字段。代码不能证明人工配置的随机性，
必须由操作人使用安全随机生成器。

失败仅返回固定错误码，不返回原异常、SQL、凭证或数据。结构化应用日志只记录
操作结果、用户 ID、请求 ID、版本核验状态及必要计数。生产 Secret 不进入前端。

扫描覆盖 118 个当前源码文件，检查高置信 AccessKey/私钥模式，并在内存中与
已验证备份里的生产邮箱、手机号、密码哈希和会话哈希做精确比较；未发现命中。
客户端构建不含 Reset Secret 模块，本地夹具入口不进入正式构建，Git 不含生产 ZIP。
这不是一次 Git 历史重写或整个依赖供应链审计。

## 必须明确保留的限制

### R05 · Medium · 平台边界：Deployment 验证为 UNAVAILABLE

位置：`lib/production-reset-channel.ts:28` 和 `:168`。

请求必须匹配服务端批准值，但配置匹配不等于已经读到当前真实部署。
现有 Sites 运行时没有向本应用提供可靠的 Version/Deployment 身份绑定；
生产路由因此返回 `X-Reset-Deployment-Verification: UNAVAILABLE`，不会用用户
Header 或环境配置冒充 VERIFIED。可信平台适配器若将来存在，必须匹配才可 VERIFIED。
本地模拟适配器的匹配与不匹配都已测试。

T2.2 必须通过 Sites 平台只读结果再次核对实际新 Version/Deployment。
部署此入口将产生新版本，不能继续宣称仍是 Version 41。配置更新也可能产生新的
Deployment；所有环境配置就绪后必须重新记录最终实际部署身份，不能为了“自证”
而无限重部署，或把配置中的批准基线称为运行时证明。若下一次批准要求运行时
独立 VERIFIED，该要求当前尚未具备，必须停止，而不是放宽标签。

### R06 · Medium · 生命周期边界：永久锁不能保留在全空业务库中

位置：`docs/T2_PRODUCTION_RESET_CHANNEL.md` 的 Honest permanence boundary。

成功 Reset 同时清空锁、审计、用户和 Session，因此同一旧身份无法再次执行。
并发断言及操作锁保证当前执行一次性，不能把已被清除的行描述为永久锁。
该保证不跨越未来重新创建管理员或完整恢复旧数据库。

新账号注册或 Bootstrap 前，必须单独批准并完成：关闭 Reset 开关、移除 Secret、
删除临时入口、部署清理版本并确认入口消失。这些是继续后续阶段的强制前置条件。
现有绑定不能让 Worker 安全地修改自身 Sites 配置或删除自身部署。

## 验证记录

- lint：0 问题；typecheck：通过；build：通过。
- S0 安全回归：通过。
- 维护模式回归：通过。
- 既有本地生命周期（含本地 Bootstrap 回归）：通过。
- 0006/16 表及 0010/19 表备份恢复、逐表行数、外键：通过。
- 新 Reset 通道完整测试：135 项断言全部 PASS；包含实际构建的 GET 405、
  默认关闭的 POST 503/RESET_DISABLED、health、旧 Session 401 和普通业务 503。

成功 Reset 后本地计数：

| 表 | 行数 | 表 | 行数 |
| --- | ---: | --- | ---: |
| action_idempotency | 0 | action_rate_limit | 0 |
| announcements | 0 | families | 0 |
| family_activities | 0 | family_users | 0 |
| generations | 0 | media | 0 |
| person_claims | 0 | persons | 0 |
| relationships | 0 | review_requests | 0 |
| system_audit_logs | 0 | user_messages | 0 |
| user_sessions | 0 | users | 0 |
| user_identities | 0 | sms_verifications | 0 |
| phone_change_challenges | 0 | | |

PRAGMA foreign_key_check：0 个违规。之后访问实际构建的应用，19 表仍为 0。
没有自动创建 SUPER_ADMIN、OWNER、family 或旧静态树。

开发测试发现并修正了两个测试环境问题：旧数据夹具必须先于数据型 0010
migration 插入；D1 对 compound SELECT 数量有限制，最终计数采用单个 SELECT
中的 19 个标量子查询。另确认本地 Wrangler 存在明确的
`worker restarted mid-request` 暂态响应；仅对只读和明确关闭、无鉴权、空参数
的 HTTP 验收请求有限重试，复用现有维护测试的处理原则。任何真实调用 Reset
核心的请求及生产 API 内部都不自动重试。没有放宽 schema 门禁或删除失败测试。

结论：本地实现、审计和要求的验证已完成，可申请 T2.2 审批。生产执行批准不包含
在本报告中。审批必须明确接受 R05 的 UNAVAILABLE 边界，并包含 R06 的强制撤销
步骤；如果要求运行时独立 VERIFIED，则当前不具备执行条件。
