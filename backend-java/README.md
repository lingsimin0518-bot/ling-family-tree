# 凌氏族谱 Java 后端（第一阶段）

这是与现有 Cloudflare Worker + D1 网站完全独立的 Java 后端。当前阶段只包含基础数据模型和 Person CRUD，不连接现有前端。

## 技术栈

- Java 21
- Spring Boot 4.1.1
- MySQL 8
- MyBatis-Plus 3.5.17
- REST API

## 目录结构

```text
src/main/java/cn/lingshi/familytree/
├─ controller/   REST 接口
├─ service/      业务接口与实现
├─ mapper/       MyBatis-Plus 数据访问层
├─ entity/       Family、Person、Relationship 实体
├─ dto/          接口输入与输出对象
└─ config/       MyBatis-Plus 与异常处理配置
```

## 连接 MySQL

先启动 MySQL 8，并准备一个可创建数据库和数据表的账号。默认连接为：

```text
jdbc:mysql://localhost:3306/family_tree
用户名：root
密码：change-me
```

推荐通过环境变量提供真实配置，不要把真实密码写进代码：

```powershell
$env:MYSQL_URL='jdbc:mysql://localhost:3306/family_tree?createDatabaseIfNotExist=true&useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Tokyo'
$env:MYSQL_USERNAME='root'
$env:MYSQL_PASSWORD='你的MySQL密码'
```

应用首次启动时会执行 `src/main/resources/schema.sql`，创建 `family`、`person`、`relationship` 三张表。

## 编译和启动

电脑安装 Java 21 后：

```powershell
.\mvnw.cmd clean test
.\mvnw.cmd spring-boot:run
```

本机当前还准备了便携 Java 21，可在当前终端临时使用：

```powershell
$env:JAVA_HOME='F:\Projects\.tools\jdk-21'
$env:Path="$env:JAVA_HOME\bin;$env:Path"
.\mvnw.cmd spring-boot:run
```

启动地址：`http://localhost:8080`

## 准备测试族谱

第一阶段尚未实现 Family CRUD。先在 MySQL 中创建一条族谱记录：

```sql
INSERT INTO family (name, description, created_at, updated_at)
VALUES ('凌氏家谱 Java 测试', '第一阶段接口测试', NOW(), NOW());
```

记下生成的 `id`，下面示例假设它是 `1`。

## Person CRUD 接口

### 新增人物

```http
POST /api/persons
Content-Type: application/json

{
  "familyId": 1,
  "name": "凌测试",
  "gender": "男",
  "generation": 3,
  "birthDate": "2000-05-18",
  "deathDate": null,
  "biography": "Java 后端测试人物"
}
```

### 查询单个人物

```http
GET /api/persons/1
```

### 查询人物列表

```http
GET /api/persons?familyId=1&page=1&size=20
GET /api/persons?familyId=1&name=凌&generation=3&page=1&size=20
```

### 修改人物

更新请求中的 `version` 必须使用最近一次查询返回的版本号，用于防止并发覆盖：

```http
PUT /api/persons/1
Content-Type: application/json

{
  "familyId": 1,
  "name": "凌测试改",
  "gender": "男",
  "generation": 4,
  "birthDate": "2000-05-18",
  "deathDate": null,
  "biography": "修改后的简介",
  "version": 1
}
```

### 软删除人物

```http
DELETE /api/persons/1
```

删除后数据库记录仍保留，但 `deleted` 变为 `1`，普通查询不会再返回该人物。

## 自动验证

`PersonCrudIntegrationTests` 使用独立的内存测试数据库，验证新增、单人查询、列表、修改、版本号递增和软删除。它不会读写 MySQL，也不会影响现有 Cloudflare D1 数据。
