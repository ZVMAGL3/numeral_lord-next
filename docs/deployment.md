# 当前部署说明

## 公网测试地址

- 可直接分享的游戏页面：`http://39.107.250.161/numeral-lord-play/`
- 中继健康检查：`http://39.107.250.161/numeral-lord/`
- 本地网页连接公网中继：`http://127.0.0.1:5173/?relay=ws://39.107.250.161/numeral-lord`

打开两个公网游戏页面（可来自两台设备），会进入同一个房间并分别得到房主和 `player-2` 席位。本地开发页面也可以使用上述查询参数连接同一个公网中继。

## 服务器布局

- 系统：Debian 12。
- 独立运行时：`/opt/numeral-lord-runtime/current`，当前为 Node 24.21.0、pnpm 12.5.1，不修改服务器已有的 Node 20 环境。
- 项目目录：`/opt/numeral-lord-next`。
- systemd 服务：`numeral-lord.service`，已启用开机自启和失败重启。
- Colyseus 只监听 `127.0.0.1:2567`，不直接暴露内部端口。
- 已有 Nginx 的 `/numeral-lord/` 路径转发 HTTP、匹配请求和 WebSocket；原站点及其他端口保持不变。

## 运维命令

```bash
systemctl status numeral-lord.service
journalctl -u numeral-lord.service -f
systemctl restart numeral-lord.service
curl http://127.0.0.1:2567/
nginx -t
```

仓库中的 `deploy/install-server.sh` 会校验并安装独立 Node 运行时、依赖及 systemd 服务；`deploy/configure-nginx.sh` 以可回滚方式添加 Nginx 路由。

## 当前边界

后端管理房间、临时账户席位、房主身份、断线窗口和消息传输。游戏规则仍由无界面的 `game-core` 在客户端/房主执行；服务端把命令绑定到真实发送席位，只接受房主的状态快照，冲突时以房主为准。

正式账户数据库、对局持久化、房间码界面、HTTPS/WSS 和域名尚未接入。公网生产使用前必须补上 HTTPS/WSS，并更换曾通过聊天传递过的服务器密码。
