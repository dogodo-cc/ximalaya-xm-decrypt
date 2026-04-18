# .xm 文件解密工具

- [forked form](https://github.com/sld272/Ximalaya-XM-Decrypt)
- [原始参考](https://www.aynakeya.com/articles/ctf/xi-ma-la-ya-xm-wen-jian-jie-mi-ni-xiang-fen-xi/)

将 .xm 文件解密，转为普通音频文件

## 环境要求

- Node.js 22 及以上
- 如需使用 `-mp3` 转码，系统中需要先安装 `ffmpeg`

## 安装依赖

```bash
npm install
```

## 使用方式

```bash
node main.js <xm_file_path_or_directory> [-mp3]
```

- `<输入路径>`: 必填，可以是单个 `.xm` 文件，也可以是包含多个 `.xm` 的目录。
- `[-mp3]`: 可选，强制输出 mp3。若原始解密结果不是 mp3，会自动调用 ffmpeg 转码。
- 输出目录会自动创建在"输入目录"的同级位置，目录名为原目录名后追加 `_unlock`。

### 示例

解密单个文件：

```bash
node main.js /path/to/file.xm
node main.js /path/to/file.xm -mp3
```

批量解密目录：

```bash
node main.js /path/to/directory
node main.js /path/to/directory -mp3
```

## 说明

- 使用本地的 `xm_encryptor.wasm` 完成第二阶段解密
- 支持为 mp3、flac、m4a 写入标题、专辑、歌手标签
- 批量处理时会按 CPU 核心数自动限制并发，兼顾速度与稳定性
- 在交互式终端中批量处理时，会以多行实时刷新方式显示当前完成文件与当前任务进度

## 输出说明

- 如果输入是 `/path/to/a/file.xm`，输出目录是 `/path/to/a_unlock/`，只处理该文件
- 如果输入是 `/path/to/a/`，输出目录是 `/path/to/a_unlock/`，并保留原目录下的相对目录结构
- 输出文件默认使用原始文件名命名
- 写回音频元数据时，标题字段会使用原始文件名

## 常见问题

### 未找到 ffmpeg

说明你使用了 `-mp3` 参数，但系统中没有 `ffmpeg`。安装后再运行：

```bash
brew install ffmpeg
```
