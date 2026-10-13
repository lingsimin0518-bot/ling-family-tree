# Production Reset 前置准备检查

## 当前目标

把生产从 0006/16表 安全升级到 0010/19表，随后才可另行申请 Production Reset 与一次性 SUPER_ADMIN Bootstrap。本文不是执行授权。

## 发布包必须包含

- S0 安全止血；
- 服务端维护模式；
- migration 0007、0008、0009、0010；
- 正式手机号认证与阿里云 Provider；
- 16/19 表版本感知备份与恢复验证；
- 非路由形式的 Production Reset / Bootstrap 核心逻辑。

## 发布包不得包含

- /api/admin/test-sms 下的任何路由；
- 阿里云短信联调后台 UI；
- 真实 AccessKey、真实手机号或生产备份；
- Production Reset 公开路由；
- Bootstrap 公开路由；
- 旧静态凌氏人物、关系或生平数据。

## 维护模式许可边界

允许：

- 用户名/密码或手机号/密码登录，以便既有 SUPER_ADMIN 进入运维后台；
- 退出与 Session 状态读取；
- /api/health；
- /admin 和 /api/admin 的只读 GET；
- POST /api/admin/backups/export。

拒绝：

- 注册、短信验证码、验证码登录、密码重置；
- 创建、加入、删除族谱；
- 人物、关系、认领、权限与审核写入；
- 公告、动态、消息写入；
- 手机号绑定与换号；
- SUPER_ADMIN 的账号状态修改等普通后台写入；
- 普通族谱数据 GET（fail closed）。

## 本地批准门槛

以下检查全部通过后，才具备“申请部署批准”的条件：

1. pnpm lint
2. pnpm exec tsc --noEmit
3. pnpm build
4. pnpm test:security-s0
5. pnpm test:auth-foundation
6. pnpm test:phone-auth
7. pnpm test:aliyun-sms
8. pnpm test:production-reset
9. pnpm test:maintenance
10. pnpm test:upgrade-0006-0010
11. pnpm backup:test-fixture

即使全部通过，也不等于已经授权部署、开启生产维护、执行 migration、Reset 或 Bootstrap。
