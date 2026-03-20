# .xm 文件解密工具

- [forked form](https://github.com/sld272/Ximalaya-XM-Decrypt)
- [原始参考](https://www.aynakeya.com/articles/ctf/xi-ma-la-ya-xm-wen-jian-jie-mi-ni-xiang-fen-xi/)

将 .xm 文件解密，转为普通音频文件

## Node.js 版本

仓库中额外提供了一个基于 ESM 的 Node.js 实现 [xm_decrypt.js](xm_decrypt.js)。

### 1. 环境要求

- Node.js 22 及以上
- 如需使用 `-mp3` 转码，系统中需要先安装 `ffmpeg`
- 需要先安装 npm 依赖：`music-metadata`、`node-id3`

### 2. 安装依赖

```bash
npm install
```

### 3. 使用方式

```bash
npm run decrypt -- /path/to/file.xm
npm run decrypt -- /path/to/file.xm -mp3
npm run decrypt -- /path/to/directory

node xm_decrypt.js /path/to/file.xm
```

### 4. 说明

- 命令行参数、输出目录规则与 Python 版本保持一致
- Node.js 版本同样使用本地的 `xm_encryptor.wasm` 完成第二阶段解密
- Node.js 版本使用 `node-id3` 写入 mp3 的标题、专辑、歌手标签
- Node.js 版本使用 `music-metadata` 优先识别输出音频格式
- Node.js 版本支持为 mp3、flac、m4a 写入标题、专辑、歌手标签
- 批量处理时会按 CPU 核心数自动限制并发，兼顾速度与稳定性
- 在交互式终端中批量处理时，会以多行实时刷新方式显示当前完成文件与当前任务进度

## 项目初始化

### 1. 环境要求

- Python 3.9 及以上，命令使用 `python3`
- 建议使用虚拟环境，避免污染系统 Python
- 如需使用 `-mp3` 转码，系统中需要先安装 `ffmpeg`
- 项目依赖 `python-magic` 检测音频格式；如果在 macOS 上安装或运行时报 `libmagic` 相关错误，可先执行：

```bash
brew install libmagic ffmpeg
```

如果你只做解密、不转码为 mp3，`ffmpeg` 不是必需项。

### 2. 创建虚拟环境

```bash
python3 -m venv .venv
source .venv/bin/activate
```

激活成功后，终端前面通常会出现 `.venv` 前缀。

### 3. 安装依赖

```bash
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
```

### 4. 验证初始化是否完成

可以先直接运行不带参数的脚本，确认命令帮助能够正常输出：

```bash
python3 main.py
```

如果环境正常，脚本会打印用法说明，而不是报缺少模块。

## 使用方式

### 1. 命令格式

```bash
python3 main.py <输入路径> [-mp3]
```

- `<输入路径>`: 必填，可以是单个 `.xm` 文件，也可以是包含多个 `.xm` 的目录。
- `[-mp3]`: 可选，强制输出 mp3。若原始解密结果不是 mp3，会自动调用 ffmpeg 转码。
- 输出目录不再手动指定，会自动创建在“输入目录”的同级位置，目录名为原目录名后追加 `_unlock`。

### 2. 示例

先进入项目目录并激活虚拟环境：

```bash
cd /path/to/Ximalaya-XM-Decrypt
source .venv/bin/activate
```

解密单个文件：

```bash
python3 main.py /path/to/file.xm
python3 main.py /path/to/file.xm -mp3
```

批量解密目录：

```bash
python3 main.py /path/to/directory
python3 main.py /path/to/directory -mp3
```

### 3. 输出说明

- 如果输入是 `/path/to/a/file.xm`，输出目录是 `/path/to/a_unlock/`，只处理该文件，不递归扫描其他文件。
- 如果输入是 `/path/to/a/`，输出目录是 `/path/to/a_unlock/`，并保留原目录下的相对目录结构。
- 输出文件默认使用原始文件名命名。
- 写回音频元数据时，标题字段会使用原始文件名。
- 程序结束后会汇总显示成功/失败数量。

## 常见初始化问题

### 1. `ModuleNotFoundError`

通常是因为没有激活虚拟环境，或者依赖没有安装到当前 Python 环境。重新执行：

```bash
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

### 2. `未找到 ffmpeg`

说明你使用了 `-mp3` 参数，但系统中没有 `ffmpeg`。安装后再运行：

```bash
brew install ffmpeg
```

### 3. `libmagic` 相关错误

这是 `python-magic` 缺少系统依赖导致的，macOS 下可执行：

```bash
brew install libmagic
```

## 推荐的首次使用流程

```bash
git clone <your-repo-url>
cd Ximalaya-XM-Decrypt
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
python3 main.py /path/to/file.xm
```
