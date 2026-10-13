# 安全整改 S0：生产高危问题止血

基线提交：`56ecd6bb04af5d5f07eea6c90c09b1d3e80f608f`
修复分支：`codex/security-s0-containment`

本阶段只准备代码、测试和数据迁移脚本；没有部署、没有执行生产 migration，也没有修改生产数据库。

## 旧账号激活的后续安全设计

普通注册不再复用任何已存在邮箱对应的 User。未来如需激活旧账号，必须使用独立流程，并满足：

- 先验证原邮箱、原手机号或受信任管理员发放的迁移邀请；
- 激活凭证随机、短时、单次使用，并绑定明确的 `user_id` 和用途；
- 禁用账号不能通过普通激活恢复，必须走管理员审核；
- 激活、角色保留和 Session 签发放在一个可验证的原子状态转换中；
- 记录审计日志，并在并发消费时只允许一次成功。

## 旧静态族谱数据止血

原 `public/family.html` 已在项目外备份为：

`F:\Backups\ling-family-tree\legacy-family-static-source-before-s0-56ecd6b.html`

备份前后 SHA-256 均为：

`DF5A54A1A567BC2ED65A14541CB04148EF79888EB273F45DACC9A3A5DA46D207`

公开页面中的真实人物、关系和生平生成数据已移除。API 未授权、会话过期或读取失败时返回错误状态，不再回退到旧主谱。完整迁入 D1 留待后续独立阶段。

## 固定加入码失效步骤

代码层已经拒绝加入任何 `LEGACY_STATIC` 族谱，并且 VIEWER 不再获得加入码。

生产环境仍需在未来获批部署时执行 `0010_security_s0_containment.sql`，把现存 `LEGACY_STATIC` 加入码替换为随机禁用值。部署前必须先备份，部署后验证旧码返回 404 且不新增 `family_users`。

rollback 文件仅用于紧急回退。它会恢复已公开的旧码，因此会重新引入风险，不能作为常规回滚手段。

## 历史 OWNER 只读审计

没有连接实时生产数据库。以下结果来自已验证的生产备份快照 `production-before-0006-20260926-110117Z.zip`，快照时间为 `2026-09-26T11:01:17.212Z`：

| family_id | OWNER user_id | username | joined_at | family created_by | 判断 |
| --- | --- | --- | --- | --- | --- |
| `family-lingshi-existing` | `sD8o8Su5INyOQ7uSUEChpaWHf4lENhPebgNnNn6dr1Bw0w7RNe08zB` | `ling` | `2026-09-06T13:44:27.604Z` | 同一 user_id | 创建人与 OWNER 一致，但没有角色变更日志，只能待核实来源 |
| `c4fbe46c-bf7b-44fd-9323-ad48540df8f7` | `644d3dce-d63b-4995-a893-aa49d4fca1a8` | `1` | `2026-09-13T02:35:06.906Z` | 同一 user_id | 创建人与 OWNER 一致，符合显式创建族谱结果 |

快照中的 `system_audit_logs` 没有 OWNER/ROLE/MEMBER 相关记录，不能仅凭时间认定任何 OWNER 非法。本阶段未降权、未删除、未修改任何记录。

快照中没有 username、nickname 或 display_name 为 `2_1` 的唯一匹配，因此无法确认 `2_1` 对应的具体账号，未做推测。

## 分支安全差异整合

没有用 `main` 覆盖审计分支。S0 分支逐项整合了：

- React、React DOM、`react-server-dom-webpack`：`19.2.6` → `19.2.8`；
- Vite：`8.0.13` → `8.0.16`；
- Sharp 锁定为 `0.35.4`；
- `main` 中备用人物详情的 HTML 转义修复。

`main` 中的 README、工作目录说明和其他非安全业务差异没有直接覆盖当前分支。
