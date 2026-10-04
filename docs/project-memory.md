# Numeral Lord 项目备忘录

这是项目的持久工作约定。开始新任务或发布前先读本文件；用户后续明确更改约定时，以最新指示为准。

## 发布环境与授权

- 默认发布目标是正式环境。只有用户明确说测试站、stage 或测试链接时，才发布到测试环境。
- 用户已明确：当前账号和对局都是测试用途；用户要求发布时可直接发布，不要仅因存在活动测试连接而停下或重复询问。重启 relay 可能让这些测试连接断开。
- 正式页面：`http://39.107.250.161/numeral-lord-play/`
- 正式 relay：`ws://39.107.250.161/numeral-lord`，服务器内部端口为 `2567`。
- 测试页面：`http://39.107.250.161/numeral-lord-play-stage/`
- 测试 relay：`ws://39.107.250.161/numeral-lord-stage`
- `pnpm --filter @numeral-lord/web build:deploy` 只会在本地构建 `dist`，不会上传或发布。必须明确完成远端发布和发布后健康检查，不能把构建说成部署。

## SSH 登录

SSH 私钥是自定义文件名，位于 `C:\Users\z\.ssh\numeral_lord_deploy_rsa`。连接时显式使用：

```powershell
ssh -i C:\Users\z\.ssh\numeral_lord_deploy_rsa -o IdentitiesOnly=yes -o BatchMode=yes root@39.107.250.161
```

如果未指定 `-i` 的默认连接失败，不代表没有密钥或服务器无法访问；先用上面的身份文件重试。私钥内容绝不可输出、复制进仓库或放入归档。

## 正式部署

- 正式部署脚本：`deploy/update-production.sh`。
- 远端脚本要求发布包放在 `/tmp/numeral-lord-next-production.tar.gz`，项目路径为 `/opt/numeral-lord-next`。
- 脚本会构建完整候选版本、保留服务器工坊资源目录和 PostgreSQL 数据，再切换代码并重启 `numeral-lord.service`。旧目录和发布包只在切换期间临时存在；健康检查成功后立即删除，只保留当前运行版本。健康检查失败时自动恢复旧版本并清理候选版本。
- 脚本本身按安全策略检查 `2567` 活动连接，但用户已说明当前都是测试账号、要求直接发布。按用户当前授权执行，不因测试连接阻塞；发布前仍须确认归档范围中无密钥、`.env`、本地数据库、`node_modules`、构建缓存等敏感或无关文件。
- 发布后核对正式页面 HTML/JS/CSS、贴图资源和 relay 健康，并按变更运行合适的双客户端烟测。
- 测试环境脚本：`deploy/update-staging.sh`；同样只保留当前运行版本，不积累回滚目录。不得把它误认为正式发布。

## 常用验证

```powershell
pnpm typecheck
pnpm -r test
pnpm --filter @numeral-lord/web build:deploy
```

当前工作区近期基线为 177 项测试（game-core 66、server 69、web 42）。构建偶有 Pixi JS chunk 超过 500 kB 的非阻塞提示。

## 页面路由

- 战斗大厅入口是 `/numeral-lord-play/rooms`，不带 `room` 查询参数。
- `/numeral-lord-play/rooms?room=<房间号>` 是邀请直达路由，会直接加入指定房间，不经过战斗大厅；对局开始后会显示实战棋盘。

## 用户沟通偏好

- 优先用中文简洁汇报，先说结果和环境，再说验证与未完成项。
- 清楚区分本地构建、测试站发布和正式环境发布。
- 用户要求执行发布时，按上述正式环境默认执行；不要再次询问已经明确给出的 SSH 身份或默认目标。
