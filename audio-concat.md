# audio-concat.js 实现说明

## 速查版

### 这个脚本做什么
- 递归扫描目录里的音频文件
- 识别文件名中的分段关系
- 把同一组分段按顺序合并成一个完整音频
- 输出到输入目录同级的 `*_concat` 目录

### 支持哪些扩展名
- `.mp3`
- `.m4a`
- `.aac`
- `.wav`
- `.flac`
- `.ogg`
- `.opus`

### 支持哪些分段命名
- `xxx1.mp3` / `xxx2.mp3`
- `xxx(1).mp3` / `xxx(2).mp3`
- `xxx（1）.mp3` / `xxx（2）.mp3`
- `xxx(上).mp3` / `xxx(中).mp3` / `xxx(下).mp3`
- `xxx（上）.mp3` / `xxx（中）.mp3` / `xxx（下）.mp3`

### 主流程
```text
输入目录
  -> 扫描支持的音频文件
  -> 从文件名提取 baseStem + partIndex + style
  -> 按“目录 + baseStem”分组
  -> 校验是否可合并
  -> --preview 只展示结果 / 不带参数时实际调用 ffmpeg 合并
```

### 分组规则
- 同目录下才会分到一组
- 主标题必须完全一致
- 至少 2 个文件才算候选组

### 校验规则
- 同组扩展名必须一致
- 同组命名风格必须一致
- 数字分段必须连续：`1,2,3...`
- 中文分段只接受：`上+下` 或 `上+中+下`
- 源目录里不能已存在同名完整文件
- 输出目录里不能已存在同名结果文件

### 输出规则
- 输入目录：`/path/audio`
- 输出目录：`/path/audio_concat`
- 保留原有子目录结构
- 输出扩展名沿用原分段文件扩展名

### 预览命令
```bash
node audio-concat.js "/path/to/audio_dir" --preview
```

### 正式合并命令
```bash
node audio-concat.js "/path/to/audio_dir"
```

### 常见为什么没被合并
- 缺号：如 `1,2,4`
- 标题不一致：如“遗址”/“遗迹”
- 同组扩展名不同：如 `.mp3` + `.m4a`
- 命名风格混用：如 `1` 和 `(2)`
- `_concat` 目录里已经有输出结果
- 原目录里已经有同名完整文件

### 关键函数速记
- [audio-concat.js:22-34](audio-concat.js#L22-L34) `collectAudioFiles()`：递归扫描音频文件
- [audio-concat.js:54-72](audio-concat.js#L54-L72) `resolveInputFiles()`：校验输入目录
- [audio-concat.js:111-144](audio-concat.js#L111-L144) `parsePartInfo()`：解析分段信息
- [audio-concat.js:153-181](audio-concat.js#L153-L181) `buildGroups()`：构建候选分组
- [audio-concat.js:183-234](audio-concat.js#L183-L234) `validateGroup()`：判断能否合并
- [audio-concat.js:236-264](audio-concat.js#L236-L264) `mergeGroup()`：调用 ffmpeg 合并
- [audio-concat.js:272-360](audio-concat.js#L272-L360) `main()`：串起完整流程

---

这个脚本的目标是：

- 递归扫描一个目录里的音频文件
- 找出文件名上看起来属于同一组的“分段文件”
- 按顺序把它们合并成一个完整音频
- 输出到输入目录同级的 `*_concat` 目录

例如：

```text
屁屁侦探-紫衣夫人的密码事件（上）.mp3
屁屁侦探-紫衣夫人的密码事件（下）.mp3
```

会合并成：

```text
屁屁侦探-紫衣夫人的密码事件.mp3
```

## 一、脚本整体流程

脚本的主流程在 [audio-concat.js:278-360](audio-concat.js#L278-L360)，可以概括成 5 步：

1. 解析命令行参数
2. 扫描目录里的候选音频文件
3. 按文件名规则分组
4. 对每个分组做严格校验
5. 进入预览模式，或者实际调用 ffmpeg 合并

也就是：

```text
输入目录
  -> 扫描音频文件
  -> 从文件名中提取“主标题 + 分段信息”
  -> 分组
  -> 校验是否可以合并
  -> 预览 / 合并输出
```

---

## 二、支持哪些文件

脚本目前支持这些扩展名：

- `.mp3`
- `.m4a`
- `.aac`
- `.wav`
- `.flac`
- `.ogg`
- `.opus`

定义位置在 [audio-concat.js:8](audio-concat.js#L8)。

扫描逻辑在 [audio-concat.js:22-34](audio-concat.js#L22-L34)：

- 递归遍历目录
- 只保留扩展名在支持列表里的文件
- 最终返回一个排好序的文件数组

这一步只负责“找文件”，还不判断这些文件是否能合并。

---

## 三、如何判断一个文件是不是“分段文件”

核心逻辑在 [audio-concat.js:111-144](audio-concat.js#L111-L144) 的 `parsePartInfo()`。

这个函数会从文件名里识别三类分段格式：

### 1. 裸数字

例如：

```text
xxx1.mp3
xxx2.mp3
```

会识别成：

- `baseStem = xxx`
- `style = plain-number`
- `partIndex = 1 / 2`

### 2. 括号数字

例如：

```text
xxx(1).mp3
xxx(2).mp3
xxx（1）.mp3
xxx（2）.mp3
```

这里同时支持：

- 半角括号 `()`
- 全角括号 `（）`

会识别成：

- `baseStem = xxx`
- `style = paren-number`
- `partIndex = 1 / 2`

### 3. 中文顺序

例如：

```text
xxx(上).mp3
xxx(中).mp3
xxx(下).mp3
xxx（上）.mp3
xxx（中）.mp3
xxx（下）.mp3
```

会识别成：

- `baseStem = xxx`
- `style = cn-order`
- `partIndex = 上=1, 中=2, 下=3`

如果一个文件名不符合这些规则，例如：

```text
xxx-final.mp3
xxx完整版.mp3
```

那么这个文件不会参与分组。

---

## 四、如何分组

分组逻辑在 [audio-concat.js:153-181](audio-concat.js#L153-L181) 的 `buildGroups()`。

分组 key 由两部分组成：

1. 文件所在目录
2. 去掉分段后缀后的主标题 `baseStem`

也就是：

```text
key = 目录 + baseStem
```

这样做的目的，是避免“跨目录误合并”。

例如：

```text
A/故事（上）.mp3
A/故事（下）.mp3
B/故事（上）.mp3
B/故事（下）.mp3
```

虽然标题一样，但因为目录不同，会被分成两组，而不是错误地混到一起。

另外，脚本只保留“至少 2 个文件”的组：

- 只有 1 个文件，不算分段组
- 至少 2 个文件，才会进入后续校验

---

## 五、为什么有“候选组”，但不一定“可合并”

候选组只是说明：

- 文件名看起来像一组
- 但还没有通过严格规则校验

真正决定能不能合并的是 [audio-concat.js:183-234](audio-concat.js#L183-L234) 的 `validateGroup()`。

这个函数会做下面几类判断。

### 1. 同一组扩展名必须一致

例如：

```text
xxx(1).mp3
xxx(2).m4a
```

这种不会合并，因为输出格式不确定。

### 2. 同一组命名风格必须一致

例如：

```text
xxx1.mp3
xxx(2).mp3
```

这种会被拒绝，因为一组里混用了两种风格。

### 3. 中文顺序只允许两种合法组合

对于 `上/中/下` 风格，只接受：

- `上 + 下`
- `上 + 中 + 下`

例如：

```text
xxx（上）.mp3 + xxx（下）.mp3
```

合法。

```text
xxx（上）.mp3 + xxx（中）.mp3
```

不合法。

### 4. 数字分段必须连续

对于数字风格，要求必须是连续的：

- `1,2` 合法
- `1,2,3` 合法
- `1,2,4` 不合法
- `1,3` 不合法

例如：

```text
xxx（1）.mp3
xxx（2）.mp3
xxx（4）.mp3
```

会被判定为不能合并，因为缺少 `（3）`。

### 5. 目标输出不能冲突

脚本会检查两类冲突：

#### 源目录冲突

如果原目录已经有：

```text
xxx.mp3
```

同时又有：

```text
xxx（上）.mp3
xxx（下）.mp3
```

那脚本不会合并，因为很可能 `xxx.mp3` 已经是一个完整版本。

#### 输出目录冲突

如果目标输出目录里已经存在：

```text
*_concat/xxx.mp3
```

也不会重复合并，避免覆盖旧结果。

---

## 六、输出路径是怎么决定的

输出目录逻辑在：

- [audio-concat.js:40-47](audio-concat.js#L40-L47)
- [audio-concat.js:49-52](audio-concat.js#L49-L52)

规则是：

### 1. 总输出目录

输入目录：

```text
/path/to/audio
```

输出目录：

```text
/path/to/audio_concat
```

### 2. 子目录结构保持不变

如果原文件在：

```text
/path/to/audio/sub/xxx（上）.mp3
/path/to/audio/sub/xxx（下）.mp3
```

那么输出会在：

```text
/path/to/audio_concat/sub/xxx.mp3
```

这样可以保持原目录结构，方便批量处理后继续定位文件。

### 3. 输出扩展名沿用原文件扩展名

例如：

- 输入是 `.mp3`，输出就是 `.mp3`
- 输入是 `.m4a`，输出就是 `.m4a`

不会强制统一转成某一种格式。

---

## 七、预览模式是怎么工作的

命令：

```bash
node audio-concat.js <目录> --preview
```

逻辑在 [audio-concat.js:319-326](audio-concat.js#L319-L326)。

预览模式下：

- 会扫描文件
- 会分组
- 会做完整校验
- 会打印“最终可合并”的组
- 不会调用 ffmpeg
- 不会生成输出文件

打印格式类似：

```text
=> xxx.mp3
- xxx（上）.mp3
- xxx（下）.mp3
将合并到: /path/to/output/xxx.mp3
```

这个模式主要用于人工确认：

- 分组是否正确
- 顺序是否正确
- 输出路径是否正确

---

## 八、真正合并是怎么做的

实际合并逻辑在 [audio-concat.js:236-264](audio-concat.js#L236-L264) 的 `mergeGroup()`。

流程如下：

### 1. 创建临时目录

脚本会在系统临时目录下创建一个工作目录，例如：

```text
/tmp/audio-concat-xxxxxx
```

### 2. 生成 ffmpeg 需要的 list.txt

`ffmpeg` 的 concat demuxer 需要一个文本文件，内容类似：

```text
file '/path/a.mp3'
file '/path/b.mp3'
file '/path/c.mp3'
```

脚本会把当前分组里已经排好顺序的文件写进去。

### 3. 调用 ffmpeg

调用方式是：

```text
ffmpeg -y -f concat -safe 0 -i list.txt -c copy outputFile
```

含义大概是：

- `-f concat`：使用 concat demuxer
- `-safe 0`：允许使用绝对路径
- `-i list.txt`：读取刚才生成的文件列表
- `-c copy`：直接拷贝音频流，不重新编码

这里选择 `-c copy` 的原因是：

- 更快
- 不损失音质
- 适合本来就属于同一套音频分段的文件

### 4. 检查输出是否成功

ffmpeg 执行后，脚本会检查：

- 退出码是否为 0
- 输出文件是否存在
- 输出文件大小是否大于 0

只要其中任何一步失败，就抛错。

### 5. 清理临时目录

不管成功还是失败，最后都会删除临时目录。

---

## 九、为什么排序看起来和 Finder 不完全一样

脚本里有两种排序：

### 1. 组内排序

组内一定按分段顺序排序，也就是：

- `1,2,3,4`
- 或者 `上,中,下`

这个排序是为了保证合并顺序正确。

### 2. 组与组之间排序

在 [audio-concat.js:146-151](audio-concat.js#L146-L151) 和 [audio-concat.js:309](audio-concat.js#L309) 里，脚本会按输出文件名做中文 + 数字自然排序。

这样做的目的，是让打印顺序更接近人工阅读时的直觉，例如：

- `第2集` 会排在 `第10集` 前面
- 中文标题排序也更自然

但它仍然不一定和 Finder 的所有显示设置完全一致，因为 Finder 还可能受到：

- 手动排序
- 修改时间
- 本地化规则
- 视图模式

的影响。

---

## 十、常见导致“候选组存在，但不可合并”的原因

### 1. 输出已经存在

例如：

```text
故事（上）.mp3
故事（下）.mp3
```

但 `_concat/故事.mp3` 已经存在。此时会被过滤掉。

### 2. 缺号

例如：

```text
故事（1）.mp3
故事（2）.mp3
故事（4）.mp3
```

少了 `（3）`，不会合并。

### 3. 标题不完全一致

例如：

```text
瓢虫遗址的秘密（1）.mp3
瓢虫遗迹的秘密（3）.mp3
```

`遗址` 和 `遗迹` 不同，会被视为两组。

### 4. 同组扩展名不同

例如：

```text
故事（上）.mp3
故事（下）.m4a
```

不会合并。

### 5. 命名风格混用

例如：

```text
故事1.mp3
故事（2）.mp3
```

不会合并。

---

## 十一、关键函数一览

### `collectAudioFiles()`
递归扫描目录，收集支持的音频文件。

位置：
- [audio-concat.js:22-34](audio-concat.js#L22-L34)

### `resolveInputFiles()`
检查输入目录是否合法，并返回扫描结果。

位置：
- [audio-concat.js:54-72](audio-concat.js#L54-L72)

### `parsePartInfo()`
从文件名中提取主标题、风格、分段序号。

位置：
- [audio-concat.js:111-144](audio-concat.js#L111-L144)

### `buildGroups()`
根据目录和主标题进行分组。

位置：
- [audio-concat.js:153-181](audio-concat.js#L153-L181)

### `validateGroup()`
判断一组文件是否满足合并条件。

位置：
- [audio-concat.js:183-234](audio-concat.js#L183-L234)

### `mergeGroup()`
调用 ffmpeg 实际执行合并。

位置：
- [audio-concat.js:236-264](audio-concat.js#L236-L264)

### `main()`
串起整个流程。

位置：
- [audio-concat.js:272-360](audio-concat.js#L272-L360)

---

## 十二、推荐使用方式

### 先预览

```bash
node audio-concat.js "/path/to/audio_dir" --preview
```

先确认：

- 哪些会被合并
- 顺序是否正确
- 输出路径是否正确

### 再正式合并

```bash
node audio-concat.js "/path/to/audio_dir"
```

---

## 十三、当前脚本设计取向

这个脚本整体偏“严格模式”，也就是：

- 不猜测
- 不自动修复标题错字
- 不自动混合不同扩展名
- 不自动覆盖已有输出

这样做的优点是：

- 更安全
- 不容易把不该合并的文件误合并
- 批量处理时风险更低

缺点是：

- 对命名错误比较敏感
- 需要输入文件名尽量规范

对于批量处理儿童故事/章节音频这种场景，这种设计通常更稳。