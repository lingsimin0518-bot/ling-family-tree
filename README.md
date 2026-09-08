# 凌氏家谱网站

家谱管理网站的源码仓库，保留既有开发历史。代码包含家族成员资料，仓库应保持私有。

## 项目结构

- `app/`：页面、家谱入口及 API。
- `public/family.html`：现有家谱交互页面，包含静态家谱资料。
- `lib/`：家谱存储和世代关系逻辑。
- `db/` 与 `drizzle/`：数据库结构及迁移文件。
- `.openai/hosting.json`：现有 Sites 项目标识及数据库绑定配置，不包含登录凭据。

## 开发环境

项目使用 React、TypeScript、Vinext/Vite 和 Cloudflare D1。需要 Node.js >= 22.13.0 与 pnpm。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

常用检查与构建命令：

```sh
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

登录和数据功能依赖现有 Sites 身份信息及 D1 绑定。仅安装依赖不代表已具备线上账户和数据库；本次迁移未重新安装依赖或启动本地服务。

## 数据与发布

GitHub 用于源码和版本管理，不是线上数据库备份，也不会因为推送代码自动更新现有网站。
不要提交密钥、环境变量、聊天导出、依赖缓存、部署压缩包或运行中的数据库文件。
保留现有 Sites 项目标识；部署时继续使用已有项目，不另建重复站点。

## 本地协作

主工作副本：`F:\族谱程序\family-tree`。
C 盘 OneDrive 原目录暂保留为迁移备份。请在 F 盘副本继续开发，避免两边同时修改。

Codex 和 Claude 开始编辑前先查看 Git 状态；同一文件尽量轮流修改。提交前查看差异，提交后记录完成内容和未完成事项。
