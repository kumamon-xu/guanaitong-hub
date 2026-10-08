# 查询、同步、管理与发布配置

## v0.6.0 功能

| 模块 | 实现 |
| --- | --- |
| 查询 | 商品/订单 SQL 分页、搜索与筛选索引、按需详情、商品虚拟滚动 |
| 状态与保存 | 小型总览/清单快照、版本通知、变化行 upsert、未变化字段复用密文 |
| 同步 | 同卡请求复用、1～3 张卡并发、阶段/分页进度、取消、重试与批次记录 |
| 诊断 | 只读白名单、响应校验、错误分类、脱敏任务阶段与接口信息 |
| 管理 | 标签、到期提醒、来源报价历史、预算余量、订单筛选与 CSV 导出 |
| 工程 | IPC 参数校验、模块拆分、ESLint/类型检查、Windows/macOS 工作流 |
| 更新 | HTTPS 发布清单、版本与说明、下载前数据库备份、签名构建配置 |

## 查询与一致性

公开传输只返回当前页或界面需要的预览、清单产品；完整业务快照仍用于校验和备份。SQLite 的 `TEMP` 检索表只存于进程内存，持久库/WAL 不保存商品或订单明文检索内容。

卡片、单位、精确金额和分类必须匹配同一来源报价。不同卡的目录可合并展示，余额和兑换仍分别验证。未知余额、价格、库存保持 `null`。

报价历史按卡片和官网来源保存；只在价格/单位变化时新增，初次保存建立缓存基线。同步及历史变化一起提交，失败不会留下半份数据。v3 口令备份包含历史和任务，恢复后的未完成任务标为中断。

## 同步边界

取消会停止读取和分页，并在事务开始前再次检查状态。已完成的事务不会因之后取消而撤销。重启后排队/运行任务改为中断，由用户重试。

分类部分失败保留完整商品及旧分类并给出提示；身份核对、目录完整性或结构校验失败不会覆盖上次快照。永久 HTTP、登录及结构错误不盲目重试，新增地址不进入只读重试流程。

## 发布配置

应用在「设置与备份 → 程序更新」中读取维护者提供的公开 HTTPS JSON 地址。发布清单格式如下，示例域名与校验值需要替换为真实内容：

```json
{
  "format": "guanaitong-release",
  "schemaVersion": 1,
  "version": "0.6.0",
  "publishedAt": "2026-10-08T00:00:00.000Z",
  "notes": "发布说明",
  "downloads": {
    "win32-x64": {
      "url": "https://example.com/application-setup.exe",
      "sha256": "替换为产物的64位十六进制SHA256"
    }
  }
}
```

清单限制为 256 KiB，验证格式、版本、日期、当前系统的 HTTPS 下载地址与校验值。应用展示说明，备份数据库后打开下载链接；用户自行下载安装包，新版启动时执行结构迁移。此流程不自动运行安装程序，也不声称已验证浏览器下载文件的完整性。

### 本地构建

```sh
npm run check
npm run test:desktop
npm run release:win
# 在 macOS 上：
npm run release:mac
# 必须签名时：
node scripts/build-release.mjs win --signed
```

构建输出安装包和 `SHA256SUMS-*.txt`。设置 `RELEASE_BASE_URL` 后，按真实产物生成平台清单；没有真实地址时不生成带虚构链接的清单。多平台发布时将各自 `downloads` 合并为共同清单。

### 签名与公证

| 平台 | 环境变量 |
| --- | --- |
| Windows | `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`，或 electron-builder 的 `CSC_LINK` 回退 |
| macOS | `CSC_LINK` / `CSC_KEY_PASSWORD`，或钥匙串身份 `CSC_NAME` |
| macOS 公证 | `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` |

证书及口令放在环境变量或 GitHub Secrets，不能提交源码。强制签名时缺少可用证书会失败，未签名产物不能标为已签名。

### GitHub Actions

- `ci.yml`：Windows/macOS 执行代码检查、合成测试、原生桌面验证和目录打包。
- `release.yml`：手动准备平台产物，默认要求签名；上传 Actions artifacts，不自动发布 GitHub Release。
- 仓库变量：`RELEASE_BASE_URL`。
- 仓库 Secrets：`WIN_CSC_*`、`MAC_CSC_*` 及所需 `APPLE_*`。

Windows/macOS 的原生检查与目录打包已通过首次[公开 Actions 验证](https://github.com/kumamon-xu/guanaitong-hub/actions/runs/37738342471)。后续状态以 Actions 实际结果为准；真实证书签名、公证、用户设备安装和正式发布源仍需对应环境验收。

## 公开仓库规则

源码、合成测试和通用文档可以提交；个人数据库、备份、现场日志、证书和安装产物留在忽略目录。提交前运行 `npm run audit:public`，本地也可配置 `git config core.hooksPath .githooks` 启用暂存区检查。
