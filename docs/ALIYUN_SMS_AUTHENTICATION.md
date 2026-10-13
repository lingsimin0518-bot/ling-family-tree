# 阿里云号码认证短信 Provider

本实现调用号码认证服务的 `SendSmsVerifyCode` 与 `CheckSmsVerifyCode`，不调用普通短信 `SendSms`。真实模式由阿里云生成、保存并校验验证码；本地仅保存用途、挑战标识、时效、尝试次数和状态。

## 服务端配置

仅在 Sites 服务端 Secret/环境变量中配置：`SMS_MODE=aliyun`、`ALIYUN_SMS_ACCESS_KEY_ID`、`ALIYUN_SMS_ACCESS_KEY_SECRET`、`ALIYUN_SMS_ENDPOINT`、`ALIYUN_SMS_REGION_ID`、`ALIYUN_SMS_SIGNATURE`，以及五个 `ALIYUN_SMS_TEMPLATE_*`。禁止写入源码、数据库、日志或客户端。

即使多个用途配置同一模板，本地仍按 purpose 隔离挑战，验证码不能跨用途消费。人工联调前需完成阿里云号码认证服务开通、签名和模板审核，并只在非生产 Sites 环境配置 Secret。仓库测试使用模拟 HTTP 响应，不会调用阿里云。
