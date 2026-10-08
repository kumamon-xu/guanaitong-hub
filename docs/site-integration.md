# 官网接入边界

本项目适配官网页面使用的接口和字段。这些适配不是公开稳定的第三方 API 合约；官网变化可能导致读取失败，应用通过校验与完整快照保护已有数据。

## 已接入的只读范围

基础路径由 `electron/adapter.ts` 定义，允许的路径及请求方法集中在 `electron/official-client.ts`。

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `common/getCurrentInfo` | GET | 当前卡片身份、余额、可用状态及到期时间 |
| `common/getCommonInfo` | POST | 读取配送策略等公共信息 |
| `card/getProductHomeUrl` | GET | 当前卡的官网商品首页 |
| `product/list` | GET | 标准商品全分页目录 |
| `exchangeOrder/list` | GET | 目标卡历史订单 |
| `product/cmsQueryProductCategory` | POST | 商品分类树 |
| `product/cmsQueryProduct` | POST JSON | 分类成员全分页目录 |
| `address/list`、`address/getById` | GET | 当前卡官网地址只读查询 |

`address/add` 是单独的显式用户确认操作，不进入只读重试范围。应用不自动提交订单、写入购物车、修改默认官网地址或注销卡片。

## 响应与身份检查

响应以 `{ code, msg, data }` 包装，HTTP 成功不等于业务成功。会话失效、网络、超时、永久 HTTP、结构变化、卡号不一致及存储失败分开处理。

同步开始与快照提交前均核对返回卡号。响应属于其他卡、分页重复/不完整、总数变化或缺少关键字段时，不覆盖上次完整数据。临时读取失败不会被当成需要重新登录。

## 数据语义

- 只接受可解析的非负余额、价格和金额；未知值保持 `null`。
- 只有明确售罄才记录零库存，列表没有提供数值库存时不伪造数量。
- 标准目录来源标识包含官网商品码、库存分组与商品类型；商品合并继续保留每卡报价和链接。
- 历史订单按卡和官网来源定位，保留商家子订单区别。
- 地址字段只按官网实际结构解析；未知或企业固定配送规则不默认当成普通地址。

## 会话与重试

每卡使用独立内存 Chromium 会话，Cookie 经系统加密保存在 SQLite。仅已知只读接口在临时网络或可重试 HTTP 错误下受控重试，登录、永久 HTTP 与无效结构不会盲目重试。

网页只允许官网 HTTPS 导航，没有 Node 权限或本地 IPC 权限。需要重新登录时按[按需恢复流程](auto-login.md)处理，额外验证交由用户。

## 相关模块

- `electron/adapter.ts`：标准目录与订单归一化、分页及身份检查。
- `electron/categories.ts`：分类配置和成员读取。
- `electron/official-addresses.ts`：地址和地区校验、显式新增及读回核对。
- `electron/official-client.ts`：白名单、请求封装和错误分类。
- `electron/sync-manager.ts`：任务进度、并发、取消和批次。

公共文档只记录通用协议形状。账户、店铺归属、订单标识、Cookie、完整响应和现场截图留在忽略目录中。
