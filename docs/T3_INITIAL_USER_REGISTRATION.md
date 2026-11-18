# T3A.1：维护期首个正式账号一次性注册通道

本阶段只在本地实现、验证、提交并同步 GitHub。没有保存 Sites Version、部署、
配置生产 Secret、启用生产开关、创建生产用户或执行 Bootstrap。
开发基线为 `428aabdc56fee433773be4d32dc370fdfccb364b`；
其正式业务代码与 Version 44 的 `cdbcf2c38ab97787328b714eddb25774dc241ba7` 一致。

## 入口与配置

- `POST /api/admin/operations/initial-user`：唯一账号创建入口。
- 此路径的 GET、HEAD、PUT、PATCH、DELETE、OPTIONS 返回 `405 METHOD_NOT_ALLOWED`。
- 同一POST路径支持明确的只读可用性检查：Header为
  `X-Initial-User-Availability-Check: v1`，JSON必须严格为 `{}`，禁止携带
  Registration Secret。此分支始终在创建分支之前终止，不能创建账号。
  仅在所有服务端门禁均通过且全库为空时返回 `available=true`、项目 ID 和
  `runtimeDeploymentVerification=UNAVAILABLE`，不返回账号、表行数或 Secret。
- `/maintenance-admin` 中的临时注册区域只有在上述状态确认后才显示。

只读检查采用现有运维自检相同的固定Header分支，减少临时路由数量。
本地构建验收必须与生成的发布配置一致：`no_bundle=true`并保留ESModule规则，
不能让Wrangler重新打包已经构建的多模块Worker。本机Wrangler开发代理连续
POST会出现`worker restarted mid-request`，稳定GET也不能消除。因此构建后
四项禁用态HTTP检查各用独立本地实例，每项POST只发一次，并最终核对19表未变化。
原有状态/缓存/无Session断言全部保留；真实D1核心测试仍在同一运行时执行连续
请求和3个并发创建请求。该结果不代表生产连续HTTP已验收，后续获批部署后必须
先保持新开关关闭，再做生产默认禁用态及维护门禁验收。

| 服务端配置 | 要求 |
| --- | --- |
| APP_ENV | production |
| MAINTENANCE_MODE | true |
| INITIAL_USER_REGISTRATION_ENABLED | 默认未配置即 false；后续获批时才可设 true |
| INITIAL_USER_REGISTRATION_SECRET | 用户本人以安全随机源生成32～64字节，编码成64～128个、偶数长度的小写十六进制字符；只能配置为 Sites 机密 |
| INITIAL_USER_REGISTRATION_ALLOWED_PROJECT_ID | 必须与 `.openai/hosting.json` 的 project_id 完全一致 |
| PRODUCTION_RESET_ENABLED | 必须明确为 false |
| PRODUCTION_RESET_SECRET | 必须不存在 |

数据库绑定固定为源配置中的 `DB`，不能由请求选择。Secret 格式校验不能证明
随机性，必须由用户本人使用密码管理器的安全随机源生成并保管。
不提供真实 Secret 示例、不生成生产密钥，也不把 Secret 发送到对话。

普通 `/api/auth/register` 和 `/api/auth/register/phone` 的维护门禁不变：
维护中始终在解析/写入账号之前返回 `503 SERVICE_MAINTENANCE`。

## 请求与权限边界

创建请求必须来自固定正式 HTTPS 同源，校验 URL、Host、Origin、Fetch Metadata，
不接受 query 触发、不放宽 CORS。请求必须为 JSON，流式读取限制4096字节。
Secret 仅来自 `X-Initial-User-Registration-Secret`，通过现有恒定时间比较函数验证。
JSON 只接受 `projectId/username/password/confirmPassword/email` 五个字符串字段，
拒绝 user_id、system_role、SQL、Secret 或其他额外字段。

当前没有 SUPER_ADMIN，因此这个独立 Secret 是本通道的操作授权，不是新的管理员
Session，也不能用于其他接口。它只能在严格空库状态下创建一个普通 USER。
真实运行 Version/Deployment 没有可靠的应用内身份绑定，始终诚实标记 UNAVAILABLE；
将来执行时仍须从 Sites 控制面另行核对正式版本和部署。

## 正式认证逻辑复用

`lib/auth.ts` 抽出 `prepareUserRegistration()` 和 `userRegistrationInsert()`，
原普通注册和新通道共用。复用内容包括用户名、密码及确认密码、邮箱/联系方式
校验，用户名/邮箱/手机号重复检查，PBKDF2 100000次、16字节随机salt、UUID、
时间字段及相同的账号插入语句。没有改变密码校验的恒定时间逻辑。

临时表单保留邮箱和确认密码，是为了完整沿用现有正式注册规则；邮箱不发送
验证邮件，手机号/短信/微信不参与本通道。SQL 明确写入 `status=ACTIVE` 和
`system_role=USER`，不依赖默认角色，更不根据首个用户或没有管理员而提权。

本通道不调用 `createAuthSession()`，因此成功后只产生一个完整 users 行，
user_sessions 仍为0。成功响应仅包含 `ok` 和账号的 id、username、system_role、status。

## 空库、并发和原子性

服务端先验证真实0010 migration记录、19表集合、关键结构和无未知业务表；
再要求全部19张业务表为空。users非0返回 `409 INITIAL_USER_ALREADY_EXISTS`；
其他业务表非0则 fail closed。

同一个真实 D1 batch 内依次执行：

1. 在现有 `action_idempotency` 插入固定临时guard，条件为全部19表仍为空。
   条件不符使 NOT NULL guard失败，整个事务中止。
2. 使用正式共享插入语句创建唯一 ACTIVE USER。
3. 插入完整性guard，确认恰好插入1个用户、角色和密码哈希符合预期，
   且没有 Session、身份、族谱、OWNER、人物或其他业务副作用。
4. 删除两个临时guard。

并发写由 D1/SQLite事务序列化，只有一个batch可以提交；失败全部回滚。
成功后除 users=1 外，其余18表仍为0，不留下永久锁或测试审计记录。
后续请求即使开关和Secret仍正确，也会被users非0门禁拒绝。
不新增表或migration，不修改0000～0010。

## 前端敏感信息

Secret和两个密码字段为空值开始、type=password、不持久化、不进入URL、Cookie、
日志或analytics。Secret仅在请求Header传递。同步ref防止快速双击重复提交；
成功或失败后立即清空Secret和密码，网络结果不明时关闭表单，绝不自动重试。
成功后只显示安全账号字段，不自动登录或启动Bootstrap。

## 验证记录

验证仅使用新的临时本地D1、合成账号和运行时随机测试Secret/密码。
测试Worker不属于应用路由，正式构建必须不包含其夹具接口。

| 检查 | 结果 |
| --- | --- |
| lint / typecheck / build | PASS；lint为0，无类型错误，构建成功 |
| initial-user路由、并发、失败回滚 | PASS，214项；真实本地D1，3个并发仅1个成功，4种失败完整回滚 |
| 初始账号表单 | PASS，16项 |
| S0 / maintenance | PASS；普通与SUPER_ADMIN业务写入维护门禁保持，关闭恢复仅在本地测试 |
| auth-foundation / phone-auth / aliyun-sms | PASS；旧username登录、SUPER_ADMIN、Mock流程及0008/0009 rollback不回归，无真实短信 |
| production lifecycle / reset-channel / reset-form | PASS，分别47 / 191 / 12项；全部仅本地夹具 |
| 16表与19表备份恢复 | PASS；结构、SHA-256、逐表行数、关联与外键均通过，0006→0010保留原有身份与OWNER归属 |
| 敏感扫描 | PASS；运行时随机测试Secret/密码不在构建、控制台或Wrangler日志中；源码/构建凭据模式扫描无发现 |

扫描范围是当前待提交源码/文件、构建产物以及本轮合成测试凭据在输出/日志中的
逐值检查。没有接收、读取或配置真实Registration Secret、旧Reset Secret或AccessKey；
因此不声称对未知的历史Secret做过逐值比对，也不声称已经清理整个Git历史。
生产备份本体不在本次文件中，备份忽略规则仍有效。

上述结果是本地验收，尚未进行生产HTTP验收。可以申请T3A.2的默认关闭部署；
生产启用、配置Secret和提交真实账号均不属于本阶段。下一阶段应先核对Sites
控制面版本/部署和固定正式域名，再保持开关关闭验证连续HTTP和维护门禁。

## 后续边界与移除

只有单独获批的 T3A.2 才能保存/部署该版本，且首次部署应保持新开关关闭。
生产Secret的创建、输入、启用和正式账号提交均需要后续明确批准。
成功创建后应按后续获批流程关闭该开关、删除Registration Secret并使配置生效；
管理员Bootstrap属于其他阶段，不能使用本Secret代替。

临时功能可完整移除：删除initial-user路由、`lib/initial-user-registration.ts`、
前端临时组件及其panel引用，删除对应测试和配置。正式认证复用函数继续保留，
因为普通注册也使用它们。不得恢复旧静态数据或重新开放维护中的普通注册。
