import base64
import io
import sys
import re
import magic
import pathlib
import os
import logging
import shutil
import subprocess
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
import mutagen
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from mutagen.easyid3 import ID3
from wasmer import Store, Module, Instance, Uint8Array, Int32Array, engine
from wasmer_compiler_cranelift import Compiler
from rich.console import Console, Group
from rich.live import Live
from rich.progress import BarColumn, Progress, TextColumn

# ANSI color codes
_RED    = '\033[31m'
_BLUE   = '\033[34m'
_GREEN  = '\033[32m'
_YELLOW = '\033[33m'
_RESET  = '\033[0m'

# Match an entire already-colored span so its content is not re-colorized
_COLORIZE_RE = re.compile(
    r'(\033\[[0-9;]*m(?:(?!\033\[0m)[\s\S])*\033\[0m)'  # already-colored span — pass through
    r'|(mp3|flac|m4a|wav)'                                 # audio format names   — green
    r'|(\b\d+\.?\d*\b)',                                  # numbers              — blue
    re.IGNORECASE,
)

def _colorize(msg: str) -> str:
    def _sub(m):
        if m.group(1):
            return m.group(1)
        if m.group(2):
            return f"{_GREEN}{m.group(2)}{_RESET}"
        return f"{_BLUE}{m.group(3)}{_RESET}"
    return _COLORIZE_RE.sub(_sub, msg)

def _path(p: str) -> str:
    """Format a file path as yellow + quoted, with a leading space."""
    return f' "{_YELLOW}{p}{_RESET}"'

class _ColorFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        msg = record.getMessage()
        if record.levelno >= logging.ERROR:
            return f"{_RED}{msg}{_RESET}"
        return _colorize(msg)

_handler = logging.StreamHandler()
_handler.setFormatter(_ColorFormatter())
logging.basicConfig(level=logging.INFO, handlers=[_handler])
logger = logging.getLogger(__name__)
console = Console()

_XM_ENCRYPTOR = None


def get_xm_encryptor():
    global _XM_ENCRYPTOR
    if _XM_ENCRYPTOR is None:
        wasm_path = pathlib.Path(__file__).with_name("xm_encryptor.wasm")
        _XM_ENCRYPTOR = Instance(Module(
            Store(engine.Universal(Compiler)),
            wasm_path.read_bytes()
        ))
    return _XM_ENCRYPTOR


class XMInfo:
    def __init__(self):
        self.title = ""
        self.artist = ""
        self.album = ""
        self.tracknumber = 0
        self.size = 0
        self.header_size = 0
        self.ISRC = ""
        self.encodedby = ""
        self.encoding_technology = ""

    def iv(self):
        if self.ISRC != "":
            return bytes.fromhex(self.ISRC)
        return bytes.fromhex(self.encodedby)


def read_file(x):
    with open(x, "rb") as f:
        return f.read()


def get_xm_info(data: bytes):
    id3 = ID3(io.BytesIO(data), v2_version=3)
    id3value = XMInfo()
    id3value.title = str(id3["TIT2"])
    id3value.album = str(id3["TALB"])
    id3value.artist = str(id3["TPE1"])
    id3value.tracknumber = int(str(id3["TRCK"]))
    id3value.ISRC = "" if id3.get("TSRC") is None else str(id3["TSRC"])
    id3value.encodedby = "" if id3.get("TENC") is None else str(id3["TENC"])
    id3value.size = int(str(id3["TSIZ"]))
    id3value.header_size = id3.size
    id3value.encoding_technology = str(id3["TSSE"])
    return id3value


def get_printable_count(x: bytes):
    i = 0
    for i, c in enumerate(x):
        # all pritable
        if c < 0x20 or c > 0x7e:
            return i
    return i


def get_printable_bytes(x: bytes):
    return x[:get_printable_count(x)]


def write_bytes_to_memory(memory_view, data: bytes):
    """Write bytes data to WebAssembly memory view"""
    if not data:
        return

    # Prefer bulk copy to avoid Python-level per-byte loop overhead.
    try:
        memory_view[0:len(data)] = data
        return
    except Exception:
        pass

    for i, b in enumerate(data):
        memory_view[i] = b


def xm_decrypt(raw_data):
    # Reuse Wasm instance in current process to avoid repeated heavy initialization.
    xm_encryptor = get_xm_encryptor()
    xm_info = get_xm_info(raw_data)
    encrypted_data = raw_data[xm_info.header_size:xm_info.header_size + xm_info.size:]

    # Stage 1 aes-256-cbc
    xm_key = b"ximalayaximalayaximalayaximalaya"
    cipher = AES.new(xm_key, AES.MODE_CBC, xm_info.iv())
    de_data = cipher.decrypt(pad(encrypted_data, 16))

    # Stage 2 xmDecrypt
    de_data = get_printable_bytes(de_data)
    track_id = str(xm_info.tracknumber).encode()
    stack_pointer = xm_encryptor.exports.a(-16)
    if not isinstance(stack_pointer, int):
        raise ValueError(f"Expected stack_pointer to be int, got {type(stack_pointer)}")
    de_data_offset = xm_encryptor.exports.c(len(de_data))
    if not isinstance(de_data_offset, int):
        raise ValueError(f"Expected de_data_offset to be int, got {type(de_data_offset)}")
    track_id_offset = xm_encryptor.exports.c(len(track_id))
    if not isinstance(track_id_offset, int):
        raise ValueError(f"Expected track_id_offset to be int, got {type(track_id_offset)}")
    memory_i = xm_encryptor.exports.i
    memview_unit8: Uint8Array = memory_i.uint8_view(offset=de_data_offset)
    write_bytes_to_memory(memview_unit8, de_data)
    memview_unit8: Uint8Array = memory_i.uint8_view(offset=track_id_offset)
    write_bytes_to_memory(memview_unit8, track_id)
    xm_encryptor.exports.g(stack_pointer, de_data_offset, len(de_data), track_id_offset, len(track_id))
    memview_int32: Int32Array = memory_i.int32_view(offset=stack_pointer // 4)
    result_pointer = memview_int32[0]
    result_length = memview_int32[1]
    if memview_int32[2] != 0 or memview_int32[3] != 0:
        raise RuntimeError(f"XM decryption validation failed: flags[2]={memview_int32[2]}, flags[3]={memview_int32[3]}")
    result_data = bytearray(memory_i.buffer)[result_pointer:result_pointer + result_length].decode()

    # Stage 3 combine
    decrypted_data = base64.b64decode(xm_info.encoding_technology + result_data)
    final_data = decrypted_data + raw_data[xm_info.header_size + xm_info.size::]
    return xm_info, final_data


def find_ext(data):
    """Detect audio format by magic bytes and file signatures"""
    if len(data) < 4:
        raise ValueError("Data too short to detect format")
    
    # Check by magic byte signatures (most reliable)
    if data[:3] == b'ID3' or data[:2] == b'\xff\xfb' or data[:2] == b'\xff\xfa':
        logger.debug("Detected MP3 format by magic bytes")
        return 'mp3'
    
    if data[:4] == b'fLaC':
        logger.debug("Detected FLAC format by magic bytes")
        return 'flac'
    
    if data[:4] == b'RIFF' and len(data) >= 12 and data[8:12] == b'WAVE':
        logger.debug("Detected WAV format by magic bytes")
        return 'wav'
    
    # Check M4A/MP4 format (atom-based)
    if len(data) >= 8 and data[4:8] == b'ftyp':
        if len(data) >= 12:
            brand = data[8:12].decode('latin1', errors='ignore')
            if any(sig in brand for sig in ['M4A', 'isom', 'iso2', 'mp42']):
                logger.debug(f"Detected M4A format by ftyp brand: {brand}")
                return 'm4a'
    
    # Fallback to magic library detection
    try:
        magic_result = magic.from_buffer(data[:4096]).lower()
        logger.debug(f"Magic library detected: {magic_result}")
        for ext in ['m4a', 'mp3', 'flac', 'wav']:
            if ext in magic_result:
                return ext
    except Exception as e:
        logger.warning(f"Magic library detection failed: {e}")
    
    raise ValueError(f"Failed to detect audio format from data signature")


def convert_to_mp3(audio_data: bytes, source_ext: str):
    """Convert audio bytes to mp3 using ffmpeg."""
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise RuntimeError("未找到 ffmpeg，请先安装 ffmpeg 后再使用 -mp3 参数")

    with tempfile.TemporaryDirectory() as temp_dir:
        input_file = os.path.join(temp_dir, f"input.{source_ext}")
        output_file = os.path.join(temp_dir, "output.mp3")

        with open(input_file, "wb") as f:
            f.write(audio_data)

        cmd = [ffmpeg_path, "-y", "-i", input_file, "-vn", "-codec:a", "libmp3lame", "-q:a", "2", output_file]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"音频转码失败: {result.stderr.strip()}")

        with open(output_file, "rb") as f:
            return f.read()


def decrypt_xm_file(from_file, output_path='./output', force_mp3=False, output_file=None, verbose=True):
    if verbose:
        logger.info(f"正在解密{_path(from_file)}")
    data = read_file(from_file)
    info, audio_data = xm_decrypt(data)
    detected_ext = find_ext(audio_data[:0xff])
    output_ext = detected_ext

    if force_mp3 and detected_ext != 'mp3':
        if verbose:
            logger.info(f"检测到格式为 {detected_ext}，开始转码为 mp3")
        audio_data = convert_to_mp3(audio_data, detected_ext)
        output_ext = 'mp3'

    if output_file is None:
        original_name = replace_invalid_chars(os.path.splitext(os.path.basename(from_file))[0])
        output = os.path.join(output_path, f"{original_name}.{output_ext}")
    else:
        output_base = os.path.splitext(output_file)[0]
        output = f"{output_base}.{output_ext}"

    output_dir = os.path.dirname(output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)
    buffer = io.BytesIO(audio_data)
    tags = mutagen.File(buffer, easy=True)
    if tags is not None:
        tags["title"] = info.title
        tags["album"] = info.album
        tags["artist"] = info.artist
        logger.debug(tags.pprint())
        tags.save(buffer)
    else:
        logger.warning("无法识别音频标签格式，跳过标签写入")
    with open(output, "wb") as f:
        buffer.seek(0)
        f.write(buffer.read())
    if verbose:
        logger.info(f"解密成功，文件保存至{_path(output)}！")


def collect_xm_files(root_dir):
    """Recursively collect .xm files under root_dir (case-insensitive)."""
    files = []
    for current_root, _, file_names in os.walk(root_dir):
        for file_name in file_names:
            if file_name.lower().endswith('.xm'):
                files.append(os.path.join(current_root, file_name))
    return sorted(files)


def replace_invalid_chars(name):
    invalid_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|']
    for char in invalid_chars:
        if char in name:
            name = name.replace(char, " ")
    return name


def build_batch_progress_renderable(total_files, output_path, current_file, progress):
    return Group(
        f"当前任务总数：{total_files}",
        f"当前输出路径：{output_path}",
        f"当前完成任务：{current_file}",
        progress,
    )


def decrypt_xm_file_worker(file_path, input_path, output_path, force_mp3):
    """Worker function for multiprocessing batch decryption."""
    try:
        # Worker logs are suppressed; parent process prints ordered progress.
        logger.setLevel(logging.ERROR)
        relative_path = os.path.relpath(file_path, input_path)
        target_file_without_ext = os.path.splitext(relative_path)[0]
        target_file = os.path.join(output_path, f"{target_file_without_ext}.xm")
        decrypt_xm_file(file_path, output_path, force_mp3, output_file=target_file, verbose=False)
        return True, file_path, ""
    except Exception as e:
        return False, file_path, str(e)


if __name__ == "__main__":
    args = sys.argv[1:]
    force_mp3 = False
    if "-mp3" in args:
        force_mp3 = True
        args = [arg for arg in args if arg != "-mp3"]

    if len(args) < 1:
        logger.info("使用方法:")
        logger.info("  解密单个文件: python3 main.py <xm_file_path> [output_path] [-mp3]")
        logger.info("  批量解密文件: python3 main.py <directory_path> [output_path] [-mp3]")
        logger.info("\n示例:")
        logger.info("  python3 main.py /path/to/file.xm")
        logger.info("  python3 main.py /path/to/file.xm ./output")
        logger.info("  python3 main.py /path/to/file.xm ./output -mp3")
        logger.info("  python3 main.py /path/to/directory")
        logger.info("  python3 main.py /path/to/directory ./output")
        logger.info("  python3 main.py /path/to/directory ./output -mp3")
        sys.exit(1)

    input_path = args[0]
    output_path = "./output"
    
    # 根据输入路径类型自动判断是否为批量模式
    if os.path.isdir(input_path):
        is_batch = True
    else:
        is_batch = False
    
    # 处理输出路径参数
    if len(args) >= 2:
        output_path = args[1]
    
    files_to_decrypt = []
    
    if is_batch:
        files_to_decrypt = collect_xm_files(input_path)
        if not files_to_decrypt:
            logger.error(f"错误: 在 {input_path} 及其子目录中找不到 .xm 文件")
            sys.exit(1)
    else:
        if not os.path.isfile(input_path):
            logger.error(f"错误: {input_path} 不是有效的文件")
            sys.exit(1)
        if not input_path.lower().endswith('.xm'):
            logger.warning(f"警告: {input_path} 可能不是 .xm 文件")
        files_to_decrypt = [input_path]
    
    total_files = len(files_to_decrypt)
    successful = 0
    failed = 0
    
    if is_batch and total_files > 1:
        worker_count = min(total_files, os.cpu_count() or 1)
        progress = Progress(
            TextColumn("当前任务进度："),
            BarColumn(bar_width=30),
            TextColumn("{task.completed}/{task.total} ({task.percentage:>3.0f}%)"),
            console=console,
            expand=False,
        )
        task_id = progress.add_task("decrypt", total=total_files)
        completed_count = 0
        current_file = "等待中"

        with Live(
            build_batch_progress_renderable(total_files, output_path, current_file, progress),
            console=console,
            refresh_per_second=10,
            transient=False,
        ) as live:
            with ProcessPoolExecutor(max_workers=worker_count) as executor:
                futures = [
                    executor.submit(decrypt_xm_file_worker, file, input_path, output_path, force_mp3)
                    for file in files_to_decrypt
                ]

                for future in as_completed(futures):
                    current_ok, current_file_path, current_err = future.result()
                    completed_count += 1
                    if current_ok:
                        successful += 1
                    else:
                        failed += 1
                        logger.error(f"批量解密失败: {current_file_path}: {current_err}")

                    current_file = os.path.basename(current_file_path)
                    progress.update(task_id, completed=completed_count)
                    live.update(
                        build_batch_progress_renderable(total_files, output_path, current_file, progress)
                    )
    else:
        for idx, file in enumerate(files_to_decrypt, 1):
            try:
                logger.info(f"[{idx}/{total_files}] 处理文件: {os.path.basename(file)}")
                decrypt_xm_file(file, output_path, force_mp3)
                successful += 1
            except Exception as e:
                failed += 1
                logger.error(f"[{idx}/{total_files}] 解密 {file} 失败: {e}")
    
    logger.info(f"=====>> 解密完成！成功: {successful}/{total_files}, 失败: {failed}/{total_files}")
