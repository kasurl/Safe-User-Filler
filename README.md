# Safe User Filler

你是否还在为了测试问卷而手动填一大堆数据？你是否还在苦于真实数据缺少而到处求情填报问卷？你是否还在为问卷测试而苦恼于数据不够多、分布不均、角色不全？

### 现在自动化填表工具来了！

Safe User Filler 是一个本地问卷 QA / 场景模拟辅助工具。它给ai分配工作，然后自动自动填表、自动翻页，成为你的数据库的得力帮手。

本项目在bilibili，有完整的手把手教学，供各位参考～

声明：本项目只用作学术探讨以及思路交流，请勿用于任何非法用途。生成的数据仅用于测试目的，不得冒充真实用户数据。 本项目若被滥用导致任何法律或道德问题，开发者不承担任何责任。

## 文件结构

```text
safe-survey-filler/
  README.md
  safe-user-filler.user.js
  examples/
    survey_config.example.json
    responses.example.csv
  prompts/
    stage1_extract_config.md
    stage2_generate_csv.md
```

## 浏览器安装

### Safari

1. 打开 App Store。
2. 安装 `Userscripts` 扩展。
3. 打开 Safari 设置。
4. 进入 `扩展`。
5. 勾选并启用 `Userscripts`。
6. 打开 `Userscripts` 应用，选择一个脚本保存目录。
7. 新建脚本文件，粘贴 `safe-user-filler.user.js` 的全部内容。
8. 保存后刷新问卷页面。

### Chrome / Edge

1. 打开 Chrome Web Store 或 Edge Add-ons。
2. 安装 `Tampermonkey`。
3. 点击浏览器右上角 Tampermonkey 图标。
4. 选择 `Create a new script`。
5. 删除默认内容。
6. 粘贴 `safe-user-filler.user.js` 的全部内容。
7. 按 `Ctrl+S` 或 `Command+S` 保存。
8. 打开或刷新问卷页面。

### Firefox

1. 打开 Firefox Add-ons。
2. 安装 `Tampermonkey` 或 `Violentmonkey`。
3. 新建 userscript。
4. 粘贴 `safe-user-filler.user.js`。
5. 保存后打开或刷新问卷页面。

## 使用步骤

1. 安装浏览器扩展并保存 userscript。
2. 打开问卷链接。
3. 页面右侧出现 `Safe User Filler` 面板。
4. 点击 `导入 JSON`，选择问卷结构 JSON。
5. 点击 `导入 CSV`，选择答案 CSV。
6. 点击 `填完整份`。
7. 到最后一页后，程序会高亮提交按钮；你手动提交后，开启连续辅助时会自动回到问卷首页、切换下一份并继续填入。

## 两阶段 AI 工作流

你只需要准备问卷题目的照片，例如三张截图。然后按两个阶段处理。

### 阶段 1：从照片生成 JSON 和题目概括

把三张题目照片发给视觉模型，并使用：

[prompts/stage1_extract_config.md](prompts/stage1_extract_config.md)

这一阶段会输出：

- `survey_config.json`：程序要导入的问卷结构文件。
- `questions_summary.md`：给人看的题目和选项概括，方便检查识别是否正确。
- `csv_header.csv`：第二阶段生成 CSV 时要使用的表头。

你需要人工检查：

- 题目是否漏识别。
- 题型是否正确。
- 选项文字是否完整。
- `surveyUrl` 是否已经改成真实问卷链接。

检查无误后，把 JSON 另存为 `survey_config.json`。

### 阶段 2：按你的要求生成模拟 CSV

把阶段 1 的 `survey_config.json` 和你的生成要求发给模型，并使用：

[prompts/stage2_generate_csv.md](prompts/stage2_generate_csv.md)

你可以这样描述要求：

```text
样本数量：120
分布要求：18-25 岁居多；整体偏积极，但保留少量中立和谨慎。
角色要求：学生、职员、自由职业者都要有，不要全部一样。
```

这一阶段会输出 CSV。把结果另存为 `responses.csv`，然后在右侧面板点击 `导入 CSV`。

## 答案匹配方式

默认推荐使用选项序号，例如 `1`、`4`。这比按文字匹配更稳，尤其适合问卷星、腾讯问卷这类页面结构经常变化的平台。

CSV 中直接写第几个选项：

```csv
respondent_id,persona,Q1_gender,Q2_sleep_time
SIM-001,测试样本,1,4
```

这里的 `1` 表示第 1 个选项，`4` 表示第 4 个选项。多选题可以写成 `1|3|5`。

JSON 中推荐给选择题加入：

```json
"answerMode": "index"
```

这样该题会优先按序号选择。程序仍保留文字匹配能力；如果某道题确实需要按文字填，可以把它设置为：

```json
"answerMode": "text"
```

## 故障排查

- 面板没出现：确认 userscript 扩展已启用，并且安装的是最新版 `safe-user-filler.user.js`；问卷星页面请刷新一次，脚本会在页面重绘后自动补回面板。
- 面板显示“当前网址未匹配”：导入或修改 JSON，把 `surveyUrl` 改成当前问卷链接，然后保存配置并刷新。
- 连续辅助提交后没有回首页：确认 `surveyUrl` 是初始问卷链接。程序会对问卷星、腾讯问卷采用通用回跳兜底；腾讯问卷可能会异步跳转，因此提交后数秒内会多次尝试回到 `surveyUrl`。
- 填不进去：检查题目 `title` 是否能在页面上匹配到，并优先确认 CSV 是否写了正确的选项序号。
- 选项没匹配：检查 JSON 的 `options` 顺序是否和页面一致；必要时使用 `"answerMode": "text"` 和 `aliases` 做文字映射。
- 翻页失败：检查 `navigation.nextText` 是否等于页面按钮文字。
- 没找到提交：检查 `navigation.submitText` 是否等于页面按钮文字。
- 页面改版：点击 `清除页缓存`。
