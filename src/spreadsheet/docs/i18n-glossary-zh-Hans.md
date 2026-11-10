# Simplified Chinese (zh-Hans): style guide and glossary

The translation follows the terms of Microsoft Excel's Simplified Chinese edition, which is what
people who use spreadsheets in Chinese already know, and the Microsoft Simplified Chinese style guide
for punctuation and spacing. Where Excel has no term, use the plainest common Chinese.

## Style

- **Voice.** Address the person as 你 (not 您), as current Microsoft and Apple software does. Be
  short and plain; drop English filler ("Please", "Note that") rather than translating it.
- **Punctuation.** Full-width in Chinese text: ，。：；？！（）“”‘’、《》. A list of items is separated
  with 、. Quotation marks around a name are “…”. Keep the ellipsis as `…` (one character), as the
  source has it: `另存为…`. Keep ASCII punctuation inside code, formulas, file names, paths, keys
  (`Ctrl+C`), and between Latin text.
- **Spacing.** One half-width space between Chinese and Latin letters or digits: `在 Excel 中打开`,
  `共 3 行`, `Ctrl+S 保存`. No space between Chinese and full-width punctuation. A space around an
  argument (`正在导入 {name}…`) where the value is usually Latin text or a number.
- **Untranslated.** Product names (Puter, Excel, Microsoft, Google Sheets, LibreOffice),
  SmartArt, Power Query, DAX, VBA; function names; error values (`#N/A`, `#DIV/0!`); format codes;
  file extensions; keyboard key names (Ctrl, Shift, Alt, Enter, Esc, Tab, ⌘); units in code.
- **Arguments** (`{name}`) are kept exactly, and may move to wherever Chinese word order puts them.
- **Plurals.** Chinese has one form: `{count, plural, other {# 行}}`. There is no "1 row / 2 rows"
  distinction to keep, and no `one` case. Exact cases (`=0 {没有行}`) may stay where the English has them.
- **Counters.** Use the measure word Excel uses: `3 个工作表`, `5 行`, `2 列`, `4 个单元格`, `1 项`.
- **Menus and buttons** are verb phrases without a final 。; a sentence in a message or hint ends with 。.
  Where the English has no final full stop on a sentence (a toast, a status line), leave the final 。
  off too.
- **Titles** of dialogs use the Excel dialog name when there is one (设置单元格格式, 选择性粘贴).
- Text written into a file or a cell (sheet names, default chart titles, a template's content) is
  workbook content and is not in the catalogs.

## Glossary

### The workbook

| English | 中文 |
|---|---|
| spreadsheet (the app; a file) | 电子表格 |
| workbook | 工作簿 |
| worksheet, sheet | 工作表 |
| chart sheet | 图表工作表 |
| cell | 单元格 |
| active cell | 活动单元格 |
| range | 区域（单元格区域） |
| selection | 所选内容 / 选定区域 |
| row / column | 行 / 列 |
| row height / column width | 行高 / 列宽 |
| header (row/column headings) | 行号 / 列标 / 标题 |
| gridlines | 网格线 |
| sheet tab | 工作表标签 |
| formula | 公式 |
| function | 函数 |
| argument (of a function) | 参数 |
| reference | 引用 |
| absolute / relative reference | 绝对引用 / 相对引用 |
| name (defined name) | 名称 |
| named range | 命名区域 |
| Name Manager | 名称管理器 |
| Define Name | 定义名称 |
| constant | 常量 |
| array formula | 数组公式 |
| spill / spill range | 溢出 / 溢出区域 |
| value | 值 |
| text | 文本 |
| number | 数字 |
| date / time | 日期 / 时间 |
| blank | 空白 |
| error | 错误 |
| circular reference | 循环引用 |
| iterative calculation | 迭代计算 |
| calculation | 计算 |
| recalculate | 重新计算 |
| table (Excel table) | 表格 |
| total row / header row | 汇总行 / 标题行 |
| banded rows | 镶边行 |
| calculated column | 计算列 |
| structured reference | 结构化引用 |
| comment (threaded) | 批注 |
| note | 注释 |
| reply | 回复 |
| hyperlink, link | 链接 |
| external link | 外部链接 |
| template | 模板 |
| draft (kept in the browser) | 草稿 |
| version history | 版本历史记录 |

### Interface

| English | 中文 |
|---|---|
| ribbon | 功能区 |
| tab (ribbon) | 选项卡 |
| group (ribbon) | 组 |
| Quick Access Toolbar | 快速访问工具栏 |
| menu / submenu | 菜单 / 子菜单 |
| context menu | 快捷菜单 |
| toolbar | 工具栏 |
| formula bar | 编辑栏 |
| Name Box | 名称框 |
| status bar | 状态栏 |
| task pane, pane | 任务窗格 / 窗格 |
| dialog | 对话框 |
| command | 命令 |
| command palette | 命令面板 |
| keyboard shortcut | 键盘快捷方式 |
| tooltip | 工具提示 |
| zoom | 缩放 |
| home screen / start screen | 主屏幕 / 开始屏幕 |
| theme (light/dark) | 主题（浅色/深色） |
| accessibility | 辅助功能 |
| alt text | 替代文字 |
| sign in / sign out | 登录 / 退出登录 |
| account | 账户 |
| cloud | 云端 |
| upload / download | 上传 / 下载 |
| share | 共享 |
| editing together (co-authoring) | 共同编辑 |
| collaborator | 协作者 |
| offline | 离线 |
| AI assistant | AI 助手 |

### Ribbon tabs and File menu

| English | 中文 |
|---|---|
| File | 文件 |
| Home | 开始 |
| Insert | 插入 |
| Draw | 绘图 |
| Page Layout | 页面布局 |
| Formulas | 公式 |
| Data | 数据 |
| Review | 审阅 |
| View | 视图 |
| Automate | 自动执行 |
| Help | 帮助 |
| New | 新建 |
| Open | 打开 |
| Recent | 最近使用 |
| Save / Save As / Save a Copy | 保存 / 另存为 / 保存副本 |
| Export / Import | 导出 / 导入 |
| Print | 打印 |
| Options | 选项 |
| Close | 关闭 |
| Info / Properties | 信息 / 属性 |

### Editing

| English | 中文 |
|---|---|
| Undo / Redo | 撤消 / 恢复 |
| Cut / Copy / Paste | 剪切 / 复制 / 粘贴 |
| Paste Special | 选择性粘贴 |
| Paste Values | 粘贴值 |
| Transpose | 转置 |
| Format Painter | 格式刷 |
| Fill / Fill handle | 填充 / 填充柄 |
| AutoFill | 自动填充 |
| Flash Fill | 快速填充 |
| AutoComplete | 记忆式键入 |
| AutoCorrect | 自动更正 |
| AutoSum | 自动求和 |
| Find / Replace / Replace All | 查找 / 替换 / 全部替换 |
| Go To / Go To Special | 定位 / 定位条件 |
| Find & Select | 查找和选择 |
| Select All | 全选 |
| Clear / Clear All / Clear Formats / Clear Contents | 清除 / 全部清除 / 清除格式 / 清除内容 |
| Insert / Delete (cells, rows) | 插入 / 删除 |
| shift cells right / down | 活动单元格右移 / 下移 |
| entire row / entire column | 整行 / 整列 |
| Hide / Unhide | 隐藏 / 取消隐藏 |
| Freeze Panes / Unfreeze | 冻结窗格 / 取消冻结窗格 |
| Split | 拆分 |
| Group / Ungroup | 组合 / 取消组合 |
| Outline | 分级显示 |
| Spelling | 拼写检查 |
| Thesaurus | 同义词库 |
| Translate | 翻译 |

### Formatting

| English | 中文 |
|---|---|
| Format Cells | 设置单元格格式 |
| Number format | 数字格式 |
| General | 常规 |
| Number / Currency / Accounting | 数值 / 货币 / 会计专用 |
| Date / Time / Percentage / Fraction | 日期 / 时间 / 百分比 / 分数 |
| Scientific / Text / Special / Custom | 科学记数 / 文本 / 特殊 / 自定义 |
| decimal places | 小数位数 |
| thousands separator | 千位分隔符 |
| Alignment | 对齐 |
| Align Left / Center / Align Right | 左对齐 / 居中 / 右对齐 |
| Top / Middle / Bottom Align | 顶端对齐 / 垂直居中 / 底端对齐 |
| Wrap Text | 自动换行 |
| Shrink to fit | 缩小字体填充 |
| Merge & Center / Merge Cells / Unmerge Cells | 合并后居中 / 合并单元格 / 取消单元格合并 |
| Indent | 缩进 |
| Orientation (text) | 方向 |
| Font / Font size / Font color | 字体 / 字号 / 字体颜色 |
| Bold / Italic / Underline / Strikethrough | 加粗 / 倾斜 / 下划线 / 删除线 |
| Superscript / Subscript | 上标 / 下标 |
| Borders / Fill color | 边框 / 填充颜色 |
| Cell Styles | 单元格样式 |
| Format as Table | 套用表格格式 |
| Conditional Formatting | 条件格式 |
| Highlight Cells Rules / Top/Bottom Rules | 突出显示单元格规则 / 最前/最后规则 |
| Data Bars / Color Scales / Icon Sets | 数据条 / 色阶 / 图标集 |
| Manage Rules | 管理规则 |
| Theme colors / Standard colors | 主题颜色 / 标准色 |
| More Colors | 其他颜色 |
| No Fill / No Color | 无填充 / 无颜色 |

### Insert, charts and objects

| English | 中文 |
|---|---|
| PivotTable / PivotChart | 数据透视表 / 数据透视图 |
| Recommended PivotTables | 推荐的数据透视表 |
| field / Row / Column / Values / Filters (pivot areas) | 字段 / 行 / 列 / 值 / 筛选 |
| Slicer / Timeline | 切片器 / 日程表 |
| Chart / Recommended Charts | 图表 / 推荐的图表 |
| Column / Bar / Line / Pie / Area / Scatter chart | 柱形图 / 条形图 / 折线图 / 饼图 / 面积图 / 散点图 |
| Doughnut / Radar / Combo / Waterfall / Histogram | 圆环图 / 雷达图 / 组合图 / 瀑布图 / 直方图 |
| Chart Title / Axis Title / Legend / Data Labels | 图表标题 / 坐标轴标题 / 图例 / 数据标签 |
| axis / primary / secondary | 坐标轴 / 主 / 次 |
| series / category | 系列 / 类别 |
| Trendline / Error Bars | 趋势线 / 误差线 |
| Select Data | 选择数据 |
| Change Chart Type | 更改图表类型 |
| Format Data Series / Format Axis | 设置数据系列格式 / 设置坐标轴格式 |
| Sparklines | 迷你图 |
| Picture / Shape / Text Box / Icons | 图片 / 形状 / 文本框 / 图标 |
| WordArt / Equation / Symbol | 艺术字 / 公式 / 符号 |
| Place in Cell / Place over Cells | 放置在单元格中 / 放置在单元格上 |
| Bring Forward / Send Backward | 上移一层 / 下移一层 |
| Selection Pane | 选择窗格 |
| Crop | 裁剪 |

### Data and formulas

| English | 中文 |
|---|---|
| Sort / Sort Ascending / Sort Descending | 排序 / 升序 / 降序 |
| Custom Sort | 自定义排序 |
| Filter / AutoFilter / Advanced Filter | 筛选 / 自动筛选 / 高级筛选 |
| Clear Filter | 清除筛选 |
| Data Validation | 数据验证 |
| drop-down list | 下拉列表 |
| Remove Duplicates | 删除重复值 |
| Text to Columns | 分列 |
| Consolidate | 合并计算 |
| Subtotal | 分类汇总 |
| What-If Analysis | 模拟分析 |
| Goal Seek | 单变量求解 |
| Scenario Manager | 方案管理器 |
| Data Table | 模拟运算表 |
| Solver | 规划求解 |
| Forecast Sheet | 预测工作表 |
| Analysis ToolPak | 分析工具库 |
| Get Data | 获取数据 |
| Queries & Connections | 查询和连接 |
| Refresh / Refresh All | 刷新 / 全部刷新 |
| Data Model | 数据模型 |
| Insert Function | 插入函数 |
| Function Library | 函数库 |
| Calculation Options / Calculate Now / Calculate Sheet | 计算选项 / 开始计算 / 计算工作表 |
| Trace Precedents / Trace Dependents / Remove Arrows | 追踪引用单元格 / 追踪从属单元格 / 删除箭头 |
| Show Formulas | 显示公式 |
| Error Checking | 错误检查 |
| Evaluate Formula | 公式求值 |
| Watch Window | 监视窗口 |
| Protect Sheet / Protect Workbook | 保护工作表 / 保护工作簿 |
| password | 密码 |
| locked / hidden (cell protection) | 锁定 / 隐藏 |
| Track Changes | 修订 |
| Script / Macro | 脚本 / 宏 |
| Code Editor | 代码编辑器 |

### Page layout and printing

| English | 中文 |
|---|---|
| Normal / Page Layout / Page Break Preview (views) | 普通 / 页面布局 / 分页预览 |
| Margins / Orientation / Size | 页边距 / 纸张方向 / 纸张大小 |
| Portrait / Landscape | 纵向 / 横向 |
| Print Area / Print Titles | 打印区域 / 打印标题 |
| Page Break | 分页符 |
| Header / Footer | 页眉 / 页脚 |
| Scale to Fit / Fit to | 调整为合适大小 / 调整为 |
| Page Setup | 页面设置 |
| page | 页 |
| Print Preview | 打印预览 |

### Status bar and messages

| English | 中文 |
|---|---|
| Ready | 就绪 |
| Saving… / Saved | 正在保存… / 已保存 |
| Average / Count / Sum / Min / Max | 平均值 / 计数 / 求和 / 最小值 / 最大值 |
| Could not … | 无法… |
| … is not allowed | 不允许… |
| Try again | 重试 |
| Learn more | 了解详细信息 |
