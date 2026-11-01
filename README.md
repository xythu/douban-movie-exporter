# 豆瓣书影音游戏数据导出工具

![License](https://img.shields.io/badge/license-MIT-green) ![Version](https://img.shields.io/badge/version-2.4.1-blue) ![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-yellow)

一个用于备份豆瓣电影、读书、音乐和游戏收藏的油猴（Tampermonkey）脚本，支持 JSON、Excel，以及可选的封面资源包。

本仓库 fork 自 [byJming/douban-movie-exporter](https://github.com/byJming/douban-movie-exporter)。修复版增加标签页任务隔离、分页异常检查、书影音游戏标签提取，并减少未选字段的浏览器暂存。

## 示例

![个人主页汇总](./数据汇总页.png)

![导出选项](./导出可选项.png)

![抓取完成页](./抓取完成页.png)

![导出数据示例](./导出数据示例.png)

## 功能

- 支持电影、读书、音乐、游戏四类收藏。
- 支持自定义导出字段、JSON 和 Excel（`.xlsx`）。
- 支持从个人主页的“书影音游戏汇总”入口导航到具体分类。
- 支持指定页码范围；默认导出全部页面，即使从第 2 页打开也不会漏掉前面的记录。
- 可选导出封面，并显示下载数量、空间估算和 ZIP 生成进度。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或其他兼容的用户脚本管理器。
2. 如果安装过原版，请先保存旧任务的数据、点击“关闭并清理”，再停用原版，避免两个脚本同时运行。旧版浏览器缓存不会自动迁移或删除。
3. 打开[脚本安装地址](https://raw.githubusercontent.com/xythu/douban-movie-exporter/main/douban-movie-exporter.user.js)。
4. 确认安装或更新，并检查脚本版本为 `2.4.1`。此修复版的更新地址指向本 fork。

## 使用

登录豆瓣电脑版后，进入个人主页或以下任一收藏页：

- 电影：<https://movie.douban.com/mine?status=collect>
- 读书：<https://book.douban.com/mine?status=collect>
- 音乐：<https://music.douban.com/mine?status=collect>
- 游戏：`https://www.douban.com/people/<你的豆瓣 ID>/games?action=collect`

点击右上角“书影音游戏汇总”，选择分类后配置字段。

页码范围默认不启用；勾选“仅导出指定页码范围”后，填写起始页和结束页即可。页码从 1 开始，范围包含首尾页。

任务完成后，下载选项分为两组：

- **单独导出 JSON / Excel**：只下载数据文件。
- **下载完整资源包 ZIP**：仅在选择封面时出现，包含：

  ```text
  covers/                 封面图片
  data/*.json             主数据 JSON
  data/*.xlsx             主数据 Excel
  cover-manifest.json     封面与条目的关联清单
  ```

任务按标签页、收藏用户和收藏状态隔离；在同一个标签页切换到其他用户或状态时，不会自动继续旧任务。

条目为空、页码变化、下一页链接缺失、重复条目或电影补充字段请求失败时，会显示“抓取未完成”，可重试本页或下载已验证页面的部分数据。部分导出的文件名带 `Partial`，JSON 的 `meta.complete` 为 `false`。识别到页面总条目数时还会校验尾页数量；这些检查不能替代对实际导出内容的核对。

任务与数据保存在当前标签页的会话存储中，只暂存选中字段和用于去重、封面关联的 ID、链接、分类；只有选择封面时才暂存图片地址。此存储仍可被同源页面脚本读取。下载成功后请点击“关闭并清理”；浏览器恢复标签页时也可能恢复会话数据。

## 封面说明

豆瓣图片 CDN 存在防盗链，脚本不会把原始图片链接写入 JSON、Excel 或清单，而是在豆瓣页面上下文中下载实际图片并打包到 ZIP。`cover_file` 是 ZIP 内的本地相对路径；清单保留用于关联的条目 ID 和豆瓣链接，标题、评分、日期等仅在选择相应字段时写入。

封面选项默认关闭；不勾选时不会发起图片请求。封面下载最多并发 2 张，超过 200 张会再次确认。

## 注意事项

- 本脚本仅用于个人备份、迁移和学习，请勿高频或商业化抓取。
- 抓取期间不要手动修改收藏状态、排序方式或分页参数。
- 豆瓣页面结构可能调整；如果按钮消失或字段为空，请附页面类型和控制台错误反馈。
- 发布封面或条目内容到个人网站前，请确认用途合规。

## License

MIT License，版权归 ming 所有。联系邮箱：`woqiang0610@163.com`。

## 开发检查

无需安装依赖，使用 Node.js 运行：

```sh
node --check douban-movie-exporter.user.js
node --test tests/exporter.test.cjs
```

回归检查使用离线页面模型，不需要豆瓣账号或网络；实际页面兼容性仍需登录后确认。
