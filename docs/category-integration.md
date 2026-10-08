# 商品分类规则

分类来自当前卡片官网目录，不通过商品标题猜测。每卡独立会话读取分类，并用准确的来源报价标识建立归属。

## 适配字段

CMS 首页的 JSON 配置提供店铺及商品组件信息。`electron/categories.ts` 只解析 JSON 配置，不执行远端网页脚本；支持多个商品组件。

| 只读请求 | 信息 |
| --- | --- |
| `product/cmsQueryProductCategory` | `inventoryId`、`productCategoryList`、`categoryId`、`name`、`subCategoryList` |
| `product/cmsQueryProduct` | `productCode`、`inventoryId`、`suitType`、分页成员及分类条件 |

CMS 来源标识使用 `productCode:inventoryId:suitType`，对应标准目录的商品码、库存分组与商品类型。库存分组可能按兑换额度命名，不能当成商品分类。

## 返回合约

```ts
{
  cardId: string;
  bySourceId: Record<string, string[]>;
  sourceIds: string[];
  warnings: string[];
  complete: boolean;
}
```

分类保留官网父/子层级及多分类归属；同一商品在不同卡、库存分组和商品类型下保持独立。

## 完整性与筛选

- 只有完整查询成功后，缺少分类映射的报价才明确标记为「未分类」。
- 空页、重复页、总数变化、跨库存响应或字段变化返回诊断提示。
- 部分分类失败时，保留已确认映射、旧分类和完整商品总库，不把查询失败当成没有分类。
- 卡片、单位、金额与分类必须同时命中同一个来源报价，避免跨卡拼接筛选条件。
- 受控并发读取分类任务，各任务自身顺序读取分页。

## 测试

`tests/categories.test.ts` 使用合成配置与响应，覆盖多组件、层级、分页完整性、卡片隔离、异常及部分失败。数据库查询测试验证分类与价格的同来源约束。私人店铺标识、账户归属及现场响应不纳入公共文档。
