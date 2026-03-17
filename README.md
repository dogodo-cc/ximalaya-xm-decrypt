# .xm 文件解密工具

- [forked form](https://github.com/sld272/Ximalaya-XM-Decrypt)
- [原始参考](https://www.aynakeya.com/articles/ctf/xi-ma-la-ya-xm-wen-jian-jie-mi-ni-xiang-fen-xi/)

将 .xm 文件解密，转为普通音频文件

## 使用方式

### 1. 安装依赖

```bash
pip3 install -r requirements.txt
```

如果要使用 `-mp3` 参数将音频统一转码为 mp3，请先安装 `ffmpeg`。

### 2. 命令格式

```bash
python3 main.py <输入路径> [输出目录] [-mp3]
```

- `<输入路径>`: 必填，可以是单个 `.xm` 文件，也可以是包含多个 `.xm` 的目录。
- `[输出目录]`: 可选，默认是 `./output`。
- `[-mp3]`: 可选，强制输出 mp3。若原始解密结果不是 mp3，会自动调用 ffmpeg 转码。

### 3. 示例

解密单个文件：

```bash
python3 main.py /path/to/file.xm
python3 main.py /path/to/file.xm ./output
python3 main.py /path/to/file.xm ./output -mp3
```

批量解密目录：

```bash
python3 main.py /path/to/directory
python3 main.py /path/to/directory ./output
python3 main.py /path/to/directory ./output -mp3
```

### 4. 输出说明

- 输出目录默认是 `./output`。
- 文件会按专辑名自动分目录，文件名使用歌曲名。
- 批量模式会汇总显示成功/失败数量。
