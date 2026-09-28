# B1-4 阿里云短信认证真实环境准备清单

本阶段不部署、不调用阿里云、不执行生产 migration。首次真实测试必须使用独立测试 Version、测试 D1 和白名单手机号，不得开放普通用户入口。

## 1. 阿里云控制台

- 完成阿里云账号实名认证。
- 开通“号码认证服务”，在控制台启用“短信认证”。
- 在短信认证页面选择系统赠送签名和与其配套的系统赠送模板；当前产品不支持自定义签名/模板，赠送签名与赠送模板不可交叉搭配。
- 绑定一个由测试人员控制的中国大陆测试手机号。
- 先使用控制台 OpenAPI 调试页确认签名名称、模板 Code、测试手机号和服务状态，但此步骤不要在本阶段发送短信。

## 2. RAM 程序用户

创建只用于本项目短信认证的 RAM 程序用户，禁用控制台登录，不使用主账号 AccessKey。绑定以下用户自定义策略：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dypns:SendSmsVerifyCode",
        "dypns:CheckSmsVerifyCode"
      ],
      "Resource": "*"
    }
  ]
}
```

两个 API 均不支持资源级授权，因而 `Resource` 必须是 `*`；但 Action 可以精确限制为上述两项。不要授予 `AliyunDypnsFullAccess`，除非阿里云实际鉴权出现与官方授权信息矛盾的情况；即使临时诊断使用，也应立即撤回。

创建 RAM 用户 AccessKey 后仅保存到密码管理器和 Sites Secret。AccessKey Secret 只显示一次，不写入仓库、数据库、工单、截图或日志。真实联调结束后检查调用记录并轮换或禁用测试 AccessKey。

## 3. Sites 服务端运行时配置

必需：

- `SMS_MODE=aliyun`
- `ALIYUN_SMS_ACCESS_KEY_ID`（Secret）
- `ALIYUN_SMS_ACCESS_KEY_SECRET`（Secret）
- `ALIYUN_SMS_SIGNATURE`（系统赠送签名名称）
- `ALIYUN_SMS_TEMPLATE_REGISTER`
- `ALIYUN_SMS_TEMPLATE_LOGIN`
- `ALIYUN_SMS_TEMPLATE_RESET_PASSWORD`
- `ALIYUN_SMS_TEMPLATE_BIND_PHONE`
- `ALIYUN_SMS_TEMPLATE_CHANGE_PHONE`

可选且建议显式配置：

- `ALIYUN_SMS_ENDPOINT=https://dypnsapi.aliyuncs.com`
- `ALIYUN_SMS_REGION_ID=cn-hangzhou`

若五种 purpose 使用同一赠送模板，可以填写相同 Template Code；本地仍以 purpose 隔离验证码。`.openai/hosting.json` 只保留逻辑绑定，运行时值由 Sites 管理。

## 4. 受控真实测试模式设计

首次真实调用前还需增加一个小型安全门，不直接复用普通用户公开发送入口：

- 新增仅 `SUPER_ADMIN` 可访问的测试发送/校验入口。
- 服务端要求 `ALIYUN_SMS_TEST_ENABLED=true`，并读取 `ALIYUN_SMS_TEST_PHONE_E164` 与 `ALIYUN_SMS_TEST_CYCLE_ID`；前端不得提交或覆盖白名单与轮次。
- 固定 purpose 为 `REGISTER`，固定最多发送一条；服务端以幂等键和 D1 已存在挑战双重阻止第二次发送。
- 保留现有手机号/IP/60秒/小时/每日限流，测试门不能绕过它们。
- 发送响应只返回成功状态和有效期，不返回验证码、Provider 原始响应、AccessKey 或签名内容。
- 校验成功只消费 `sms_verifications` 挑战，不调用注册逻辑，不创建 `users`、`user_identities` 或 session。
- 测试入口仅存在于独立测试 Version；验证完成后删除入口、清除测试 Version 的 Secret 并重新构建。

## 5. 第一次真实测试步骤

1. 在非生产测试 D1 执行 `0000`—`0009`，确认生产 D1 未连接。
2. 保存独立测试 Version，但不要替换正式站点。
3. 为该测试环境配置 Secret 与唯一白名单手机号。
4. 以 `SUPER_ADMIN` 登录受控测试页，确认页面只显示脱敏号码。
5. 单击一次发送；核对本地生成一条 `REGISTER / ALIYUN_SMS_AUTH / ACCEPTED` 挑战记录。
6. 手机收到验证码后人工输入；调用 `CheckSmsVerifyCode`。
7. 核对阿里云返回 `Model.VerifyResult=PASS`，本地同一 phone + purpose 挑战变为 `VERIFIED` 且写入 `used_at`。
8. 确认没有创建 User、PHONE identity 或正式 session；再次发送和再次消费均应失败。
9. 检查无敏感日志、无普通用户入口、无其他号码发送记录。
10. 删除临时测试入口并撤下测试 Version；保留不含验证码和 Secret 的结果记录。

## 6. 失败处理

- Secret 错误或签名错误：停止测试，检查变量名称；轮换疑似泄露的 AccessKey，不把原始签名响应贴入公开日志。
- RAM 权限不足：先核对自定义策略是否绑定到正确 RAM 用户，不直接改成主账号 AccessKey；仅用官方诊断信息确认缺失 Action。
- 模板/签名错误：重新从短信认证控制台复制赠送签名和配套 Template Code，不尝试混用。
- 频率限制：停止重试，等待 `Retry-After` 或控制台限制窗口结束，不切换手机号规避风控。
- 服务商不可用或拒绝：保持 `SMS_MODE=mock` 的普通开发环境，不启用真实入口；记录脱敏 Request ID 供阿里云诊断。
- 任一异常：不执行数据库回滚，不删除挑战记录；撤下测试 Version/关闭测试入口并移除测试环境 Secret 即可。

## 7. 人工放行点

- [ ] 服务已开通且短信认证启用
- [ ] 系统赠送签名与模板配套
- [ ] 测试手机号已绑定并由本人控制
- [ ] RAM 策略只有两个 dypns Action
- [ ] AccessKey 属于独立 RAM 程序用户
- [ ] Sites Secret 已配置但未写入代码
- [ ] 独立测试 D1 已完成 0000—0009
- [ ] 白名单、单次发送、SUPER_ADMIN 后端门禁已实现并测试
- [ ] 明确批准一次真实发送后才允许调用
