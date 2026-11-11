# T2.2B-2A.1 本地生命周期验证

日期：2026-11-11（日本时间）。被测试的生产业务代码基线：
`cdbcf2c38ab97787328b714eddb25774dc241ba7`（线上 Version 44）。

## 环境与故障诊断

Windows、Node.js 24.22.1、Wrangler 4.92.0，使用全新临时目录中的本地 D1。
测试通过官方 workerd/D1 执行真实 `batch()`，没有用 mock 替换事务。

原生命周期脚本复现了 `TypeError: fetch failed / write ECONNABORTED`：
错误确认请求已完成；随后多个同步 Wrangler D1 查询也成功；下一次
`fetch` 在 Node/Undici 写入 TCP 连接时失败。S0 与手机号回归脚本也在
同步 D1 查询之后复现了 `read ECONNRESET`。
这些失败栈位于本地 HTTP 传输层，没有得到 Reset 业务结果，不能算 PASS。
没有证据表明是 SQLite 的 DELETE 或事务原子性故障。
Windows TCP 具体中断原因无法仅凭这些栈唯一确定；已消除测试中的连接复用、
同步阻塞期间复用连接、数据库进程交叉访问及启动/销毁时序风险。

另一次手机号测试在固定端口、短启动等待期间出现 Wrangler 启动错误，
因此改为临时端口、明确的 health 就绪检查，并将启动检查纳入清理范围。

## 测试设施修改

- 生命周期 HTTP 使用独立连接、完整读取响应、超时和明确就绪检查。
- 生命周期 Worker 的输出管道始终被读取，退出时终止进程树并等待退出。
- 运行中的生命周期 D1 通过同一 Worker 的固定本地夹具入口读取；
  不再并行启动第二个 Wrangler/SQLite 进程检查它。
- 静态资源 GET 允许普通同源重定向；所有业务 POST 均不重试。
- S0 和手机号测试使用仅允许 localhost/127.0.0.1 的 HTTP 客户端。
- 本地夹具可安装固定的 `persons BEFORE DELETE` 失败触发器，
  检查真实 batch 失败后全部 19 表的逐行数据完全相同。
- 单独填充第二轮夹具，同时发出三个合法核心请求，验证只有一个提交成功；
  原有路由并发、operation lock、尝试次数及重放测试保留。

`app/`、`lib/`、`drizzle/` 与生产基线无差异。没有修改 Reset 实现、
API 安全条件、数据库结构或正式认证行为。本地夹具入口不属于应用路由，
不进入生产构建。

## 结果

| 检查 | 结果 |
| --- | --- |
| Production lifecycle | PASS，47 项 |
| Production Reset 路由 | PASS，191 项 |
| Reset 执行表单 | PASS，12 项 |
| S0 安全回归 | PASS |
| 维护模式回归 | PASS |
| 认证基础 | PASS |
| 阿里云 Provider（mock HTTP，无真实请求） | PASS |
| 手机号认证、0008/0009 rollback、旧 username / SUPER_ADMIN | PASS |
| 0006 / 16 表备份与恢复 | PASS |
| 0006 恢复库升级至 0010，原 16 表数据与外键 | PASS |
| 0010 / 19 表备份与恢复 | PASS |
| lint / typecheck / build | PASS，lint 0 项问题 |

本机 HTTP 辅助工具另行验证：连接中断的 POST 只发送一次；普通 GET
重定向可跟随；非 localhost/127.0.0.1 目标直接拒绝。生产构建扫描也确认
`/test/state`、`/test/fail-delete` 及本地失败触发器均不存在于产物中。

生命周期已验证：19 表均有初始数据；正常清空后全部 0 行；中间 DELETE
失败后逐行回滚；三请求并发仅一个成功；旧用户、SUPER_ADMIN、Session、
身份及族谱均删除；schema/索引/外键定义与 11 条 migration 历史保留；
`foreign_key_check` 无违规；空库普通/失败访问后仍为 19 表 0 行；
无旧静态人物 fallback。原有重注册及 Bootstrap 回归只在本地一次性夹具执行。

## 生产边界

最终所有要求的测试均正常退出，完整生命周期为 100% PASS，无 SKIPPED。
没有将诊断期间的 ECONNRESET / ECONNABORTED 算作测试通过。

本轮没有进行生产 Reset、Bootstrap、业务写入、环境变量修改、
Sites Version 保存或部署。最终只读复核：

- Sites Version 44，部署 `appgdep_6af3edd0ed4c819185423b8b4cd79d74`，succeeded。
- 线上提交仍为本文开头的 `cdbcf2c...`，配置修订仍为 18。
- `MAINTENANCE_MODE=true`，`PRODUCTION_RESET_ENABLED=true`，Secret 仍已配置为机密；没有读取其内容。
- DB 仍为 19 张业务表；users=6、families=2、family_users=3、persons=9、relationships=7、user_sessions=3，均未变化。
- 批准的离线备份 `production-schema-0010-20261017-024056Z.zip` 大小仍为 105,957 字节。
- SHA-256 重新计算为 `D9FA2CF8346495386B749627D74C0A9012D516E1FB9551F1E6D458388219A45D`，与批准值一致。

已补齐申请 T2.2B-2B 的本地验证条件；实际生产 Reset 仍需另行明确批准。
