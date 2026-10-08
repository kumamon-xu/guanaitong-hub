# 参与开发

## 环境

使用 Node.js 24 或更新版本。Windows 与 macOS 分别运行原生 Electron 测试，避免跨系统复制 `node_modules`。

```sh
npm ci
npm run dev
```

## 提交前检查

```sh
npm run check
npm run test:login-browser
npm run test:desktop
git add <reviewed-files>
npm run audit:public
git diff --cached --check
```

常规测试只使用合成数据和临时目录。真实账号测试必须获得账号持有者授权，现场资料放在 `.private/`，不要提交账号信息、Cookie、地址或数据库。

## 变更原则

- 官网适配只在明确的只读接口范围内重试。官网地址新增保持单独的用户确认操作。
- 未知余额、价格和库存使用 `null`，不能伪造零或库存数量。
- 商品合并保留每卡来源报价；筛选条件必须命中同一个来源。
- 结构迁移只追加到 `electron/database-migrations.ts`，不要修改已经发布的迁移脚本。
- 涉及存储、同步或备份的变更应覆盖失败回滚和旧格式兼容。
- 公开截图只能使用合成演示数据，不能仅遮住卡号而保留真实余额、订单或地址。

提交说明应描述最终行为和验证结果。发布与签名配置见[发布说明](docs/phase-two-three.md)。
