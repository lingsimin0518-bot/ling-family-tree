# 正式空库 Reset 与 SUPER_ADMIN Bootstrap 操作手册

## 当前边界

本阶段只完成核心逻辑、操作设计和全本地 D1 验证。没有公开 Reset API，没有部署，没有连接或修改生产 D1，也没有创建正式管理员。

正式版采用空数据库业务状态：保留表、索引、外键和 migration 记录，清空以下 19 张业务表：

`action_idempotency`、`action_rate_limit`、`announcements`、`families`、`family_activities`、`family_users`、`generations`、`media`、`person_claims`、`phone_change_challenges`、`persons`、`relationships`、`review_requests`、`sms_verifications`、`system_audit_logs`、`user_identities`、`user_messages`、`user_sessions`、`users`。

## 维护模式

生产升级与 Reset 前必须先把服务端 MAINTENANCE_MODE 设置为 true。

维护模式由 Worker 后端判定。普通族谱读取与全部业务写入均返回 HTTP 503 和稳定错误码 SERVICE_MAINTENANCE，避免旧数据泄露和维护窗口内继续写入。登录、退出、最小 health/status、SUPER_ADMIN 只读后台与生产备份保留；SUPER_ADMIN 也不能绕过维护模式执行普通业务写入。

关闭维护模式必须显式把 MAINTENANCE_MODE 设置为 false。不能只隐藏前端按钮，也不能在未完成逐表计数、外键、旧 Session 失效和 Bootstrap 关闭验证前解除维护模式。

## Reset 实现方案

核心实现在 `lib/production-lifecycle.ts`，不属于任何网站路由，不能被普通 HTTP 请求调用。

正式执行时必须使用短期、一次性的运维入口，并同时满足：

1. 服务端确认运行环境是 `production`。
2. 服务端确认 Sites `project_id` 与预期项目完全一致。
3. 当前会话用户在数据库中仍是 `ACTIVE + SUPER_ADMIN`。
4. 提供至少 32 字符的服务端 Reset Secret，使用恒定时间比较。
5. 确认文本必须为 `RESET_ALL_BUSINESS_DATA:<project_id>`。
6. 提供已经完成本地恢复验证的最终备份 SHA-256，并与服务端配置值匹配。
7. 表名使用代码内固定白名单，客户端不能传入表名。
8. Reset 后旧 SUPER_ADMIN 与 Session 同时消失，因此旧请求身份不能再次执行 Reset。
9. Reset 成功后立即删除临时入口和 Reset Secret，再允许注册正式管理员。

不要把 Reset 做成长期后台功能，也不要在浏览器页面中保存 Secret、备份哈希或确认文本。

## 清空顺序与原子性

固定删除顺序：

1. `user_messages`
2. `review_requests`
3. `family_activities`
4. `person_claims`
5. `media`
6. `relationships`
7. `announcements`
8. `generations`
9. `phone_change_challenges`
10. `user_identities`
11. `user_sessions`
12. `action_rate_limit`
13. `action_idempotency`
14. `family_users`
15. `persons`
16. `system_audit_logs`
17. `sms_verifications`
18. `families`
19. `users`

删除通过单次 D1 `batch()` 提交。D1 batch 中任意语句失败时整批回滚，不接受逐表成功、逐表失败的部分清空状态。执行前后均逐表 `COUNT(*)`；完成后执行 `PRAGMA foreign_key_check`。如果计数或外键验证异常，必须保持维护状态并停止后续步骤。

本阶段不需要新 migration。Reset 是受控的一次性数据操作，不能混入 schema migration；`0000～0010` 保持不可变。

## 一次性 SUPER_ADMIN Bootstrap

Reset 后先通过正常注册流程创建指定账号。第一个注册用户保持 `USER`，不会自动成为 SUPER_ADMIN。

Bootstrap 必须满足：

1. 系统当前 SUPER_ADMIN 数量严格为 0。
2. 目标按不可猜测的 `user_id` 明确指定，不接受 username、邮箱或手机号代替。
3. 目标必须存在、状态为 `ACTIVE`、当前角色为 `USER`。
4. 服务端 Bootstrap Secret 至少 32 字符，并使用恒定时间比较。
5. 确认文本必须为 `BOOTSTRAP_SUPER_ADMIN:<user_id>`。
6. 更新角色与写入审计记录通过一个 D1 batch 完成。
7. 审计锁主键固定为 `system-bootstrap-super-admin-v1`；成功后重复调用返回冲突。
8. 成功后删除临时 Bootstrap 入口和 Secret，确认访问该入口返回 404。

审计记录的 `action_type` 为 `SUPER_ADMIN_BOOTSTRAP`。Bootstrap 不依赖用户名，也不会将“第一个注册用户”自动提升。

## 本地验证

运行：

```text
pnpm build
pnpm test:production-reset
```

测试只创建全新的临时本地 D1，显式删除 Cloudflare 账号环境变量，所有 D1 命令均使用 `--local`。测试覆盖：

- 0000～0010 建表；
- Reset 前 19 表均有夹具数据；
- 错误确认不产生部分删除；
- Reset 后 19 表为 0；
- 表、索引、外键保持完整；
- 旧账号、Session、Identity、族谱全部失效；
- 新用户注册后没有默认族谱和系统角色；
- 显式创建族谱后才成为 OWNER；
- Bootstrap 只作用于指定 user_id 且只能成功一次；
- 新 SUPER_ADMIN 能访问系统后台；
- public 与构建产物不包含旧主谱生成器，静态初始树为空；授权后仍可由 API 动态组装当前 family_id 的树。

## 静态旧族谱与 Git

当前工作树的 `public/` 和构建产物不再包含旧主谱生成器或嵌入的真实树对象；运行时也不会 fallback 到旧静态数据。离线原始资料只保存在项目外备份目录，不参与正式系统运行。

但是，私有 GitHub 仓库的历史提交仍可能包含删除前的静态资料。当前没有执行历史重写或强制推送。正式公开仓库前必须单独完成敏感历史清理、重新克隆验证和协作者通知；在此之前仓库必须保持私有。不能把“当前工作树已清理”表述为“Git 历史已清理”。

## 恢复方案

Reset 是不可逆业务操作。恢复只能来自执行前已经验证通过的完整生产备份：

1. 立即保持维护模式，不继续注册、Bootstrap 或创建族谱。
2. 保存 Reset 失败信息和逐表计数，不打印隐私内容。
3. 不在原生产库中手工补写部分记录。
4. 在全新本地 D1 再次验证最终备份的校验和、19 表行数与外键。
5. 使用平台批准的完整恢复流程恢复到一致快照。
6. 恢复后重新核对 schema 版本、逐表行数、外键和登录状态。
7. 只有完整恢复验证通过后才能退出维护状态。

回滚 migration 不能恢复被删除的业务数据。

## 最终生产执行清单

1. 宣布维护窗口并启用服务端维护模式，禁止注册和全部写操作。
2. 确认当前部署、项目 ID、D1 binding 和 schema 版本。
3. 创建最终完整生产备份，保存到项目外且不进入 Git。
4. 在全新本地 D1 完整恢复当前 0006/16表 备份，核对校验和、逐表行数和外键。
5. 部署已通过测试的 S0 安全代码、维护模式与最新 0000～0010；确认升级为19表后再创建一份新的19表备份并恢复验证。
6. 再次确认生产仍在维护状态，配置短期 Reset Secret 和已验证备份 SHA-256。
7. 部署临时、非公开的 Reset 运维入口，执行一次 Reset。
8. 核对 19 表全部为 0、schema/索引仍存在、外键检查通过。
9. 验证旧账号、旧 Session、旧身份、旧族谱均不可用。
10. 立即删除 Reset 入口和 Reset Secret，保存不含隐私的执行结果。
11. 正常注册指定正式管理员账号，记录其真实 `user_id`。
12. 配置独立的一次性 Bootstrap Secret，执行 `BOOTSTRAP_SUPER_ADMIN:<user_id>`。
13. 核对目标角色、唯一审计锁和系统后台权限。
14. 立即删除 Bootstrap 入口和 Secret，并验证入口返回 404。
15. 创建第一本正式族谱，确认创建者为 OWNER，其他普通访问不产生 OWNER。
16. 完成注册、登录、退出、多族谱隔离、权限、备份和公开静态资源安全验收。
17. 验收通过后解除维护模式。

任一步出现异常都必须停止，不得自动重试 Reset、不得部分恢复、不得临时修改生产数据“凑齐”结果。
