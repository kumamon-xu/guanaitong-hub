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

程序默认使用本项目 GitHub Releases 的 latest API。高级设置仍可指定自定义 HTTPS 清单；留空恢复默认。只接受正式稳定版本，draft/prerelease 不参与更新，没有正式版本时返回明确的“暂未发布”状态。

GitHub 最新发布需要包含统一的 release.json，以及清单中对应系统和架构的安装包。程序核对标签版本、资产来源、API digest 与清单 SHA-256/大小；下载只跟随已知 GitHub HTTPS 资产域名。下载完成后校验，失败或取消删除本次临时文件，不覆盖数据。

v0.7.1 增加 API 故障回退：GitHub API 返回 403/429、临时服务错误，或连接失败/超时时，读取 `https://github.com/<owner>/<repo>/releases/latest/download/release.json`。必须先解析到同仓库的正式 `vX.Y.Z` 标签，再读取该版本的 `SHA256SUMS.txt`，核对清单版本、所有安装包的来源、声明大小及校验值。最终下载仍验证实际字节大小和 SHA-256。API 正常时保留资产 digest 校验；API 发布信息、草稿或预发布状态不合法时不触发回退。自定义 HTTPS 清单沿用原校验，不转向另一个发布来源。

未认证 API 额度由出口 IP 共用，额度耗尽可能返回 HTTP 403。旧程序缺少回退逻辑时，需要手动安装修补版一次；无须填写 GitHub Token，也不要清空应用数据目录。

v0.7.2 将 API 响应体读取纳入传输故障处理：即使已收到 HTTP 200，分块断流或正文超时也会触发官方资产回退。JSON 格式、大小及发布身份错误仍直接拒绝；响应流清理异常不覆盖这些原始校验结果。

校验成功后创建数据库安全副本，界面显示已准备好。用户确认打开时再次校验缓存文件，并保存会话、再次备份，再交接给系统安装/解压工具；程序随后退出。macOS 用户将解压后的应用替换到应用目录。

v0.6.0 的旧更新逻辑不支持这个完整通道，需先手动安装 v0.6.1 或更新版本。v0.6.2 使用数据库 v3；v0.7.0 通过版本化迁移升级至 v4，迁移前自动备份。v0.6.1/v0.6.2 可通过程序内更新升级，回退前须按[迁移说明](sqlite-migration.md)保留新版数据并恢复相应旧版安全副本。

### 构建与多平台清单

本地使用 npm run release:win，Mac 上使用 npm run release:mac，可追加 --arch x64 或 --arch arm64。发布地址默认从 package.json 的仓库信息或 GITHUB_REPOSITORY 推导，也可通过 RELEASE_BASE_URL 指定。

每个平台产物记录实际文件大小、SHA-256、程序版本和数据库版本。Windows x64、macOS arm64/x64 三份清单由 scripts/merge-release.mjs 合并为统一 release.json 和 SHA256SUMS.txt。合并前实际读取安装包验证大小和校验值，缺少平台、版本不一致、文件缺失或校验失败时拒绝组装。

版本说明只提取 CHANGELOG.md 中当前版本段落，不把所有历史记录并入新发布说明。

### 签名与公证

| 平台 | 环境变量 |
| --- | --- |
| Windows | WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD，或 CSC_LINK 回退 |
| macOS | CSC_LINK / CSC_KEY_PASSWORD，或钥匙串身份 CSC_NAME |
| macOS 公证 | APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID |

证书与口令放在环境变量或 GitHub Secrets，不能提交源码。强制签名缺少证书时失败；未签名产物不会标记为已签名。

### GitHub 发布工作流

release.yml 通过 workflow_dispatch 手动运行，默认 signed=true、create_draft=true：

1. 分别构建 Windows x64、macOS arm64 与 macOS x64，运行代码检查和原生桌面测试。
2. 组装统一清单并重新验证实际安装包。
3. 可将三类安装包、release.json 和校验清单上传到版本草稿；不会自动发布给稳定更新用户。
4. 维护者审查签名、公证和安装验证后，才将草稿转为正式 Release。

没有配置签名证书时，可设置 signed=false 验证草稿流程；这不会取得发布者签名或公证。工作流拒绝覆盖已有正式版本。

v0.6.1 的三平台构建与组装已完成[在线验证](https://github.com/kumamon-xu/guanaitong-hub/actions/runs/37742811978)，并于 2026-10-08 转为[正式发布](https://github.com/kumamon-xu/guanaitong-hub/releases/tag/v0.6.1)。发布包含三类安装包、统一清单和校验文件，默认更新通道已可读取。此版本使用未签名模式，macOS 未公证；未签名模式会忽略签名环境变量，空 Secrets 不会被误当成证书路径。

v0.6.2 已通过[三平台构建与清单组装](https://github.com/kumamon-xu/guanaitong-hub/actions/runs/37750960143)，并于 2026-10-08 [正式发布](https://github.com/kumamon-xu/guanaitong-hub/releases/tag/v0.6.2)。包含余额校验、下架收藏与地址页脱敏修复，公开更新通道和下载校验已通过。签名状态与 v0.6.1 相同。

v0.7.0 已通过[三平台构建与清单组装](https://github.com/kumamon-xu/guanaitong-hub/actions/runs/37902415619)，并于 2026-10-09 [正式发布](https://github.com/kumamon-xu/guanaitong-hub/releases/tag/v0.7.0)。包含应用内结算、明确确认后的扣卡提交与兑换记录保护修复，数据库及统一备份为 v4。公开更新通道、资产大小及校验值已复核；真实卡只验证到预览，最终提交使用模拟接口验证。安装包未签名，macOS 未公证。

v0.7.1 已通过[三平台构建与清单组装](https://github.com/kumamon-xu/guanaitong-hub/actions/runs/37904824254)，并于 2026-10-09 [正式发布](https://github.com/kumamon-xu/guanaitong-hub/releases/tag/v0.7.1)。修复 API 限流时更新检查失败，实际公开资产检查包含强制 403 回退；数据库与备份保持 v4，签名状态与 v0.7.0 相同。旧程序受限时需手动安装一次。

ci.yml 继续执行 Windows/macOS 的代码、模拟登录、原生加密与目录打包检查。工作流中的 build 任务仅有读取权限，草稿组装任务单独使用 contents:write。

## 公开仓库规则

源码、合成测试和通用文档可以提交；个人数据库、备份、现场日志、证书和安装产物留在忽略目录。提交前运行 `npm run audit:public`，本地也可配置 `git config core.hooksPath .githooks` 启用暂存区检查。
