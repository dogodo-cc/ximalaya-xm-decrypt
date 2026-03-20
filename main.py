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
from dataclasses import dataclass
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


@dataclass
class XMInfo:
    title: str = ""
    artist: str = ""
    album: str = ""
    tracknumber: int = 0
    size: int = 0
    header_size: int = 0
    ISRC: str = ""
    encodedby: str = ""
    encoding_technology: str = ""

    def iv(self):
        if self.ISRC != "":
            return bytes.fromhex(self.ISRC)
        return bytes.fromhex(self.encodedby)


def get_xm_info(data: bytes):
    id3 = ID3(io.BytesIO(data), v2_version=3)
    return XMInfo(
        title=str(id3["TIT2"]),
        album=str(id3["TALB"]),
        artist=str(id3["TPE1"]),
        tracknumber=int(str(id3["TRCK"])),
        ISRC="" if id3.get("TSRC") is None else str(id3["TSRC"]),
        encodedby="" if id3.get("TENC") is None else str(id3["TENC"]),
        size=int(str(id3["TSIZ"])),
        header_size=id3.size,
        encoding_technology=str(id3["TSSE"]),
    )


def get_printable_prefix(data: bytes):
    for index, value in enumerate(data):
        if value < 0x20 or value > 0x7e:
            return data[:index]
    return data


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
    de_data = get_printable_prefix(de_data)
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


def write_audio_tags(buffer: io.BytesIO, info: XMInfo, file_stem: str):
    tags = mutagen.File(buffer, easy=True)
    if tags is None:
        logger.warning("无法识别音频标签格式，跳过标签写入")
        return

    tags["title"] = file_stem
    tags["album"] = info.album
    tags["artist"] = info.artist
    logger.debug(tags.pprint())
    tags.save(buffer)


def decrypt_xm_file(from_file, output_dir='./output', force_mp3=False, verbose=True):
    if verbose:
        logger.info(f"正在解密{_path(from_file)}")
    with open(from_file, "rb") as f:
        data = f.read()
    info, audio_data = xm_decrypt(data)
    detected_ext = find_ext(audio_data[:0xff])
    output_ext = detected_ext
    file_stem = replace_invalid_chars(os.path.splitext(os.path.basename(from_file))[0]).strip()

    if force_mp3 and detected_ext != 'mp3':
        if verbose:
            logger.info(f"检测到格式为 {detected_ext}，开始转码为 mp3")
        audio_data = convert_to_mp3(audio_data, detected_ext)
        output_ext = 'mp3'

    output = os.path.join(output_dir, f"{file_stem}.{output_ext}")
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)
    buffer = io.BytesIO(audio_data)
    write_audio_tags(buffer, info, file_stem)
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


def build_unlock_output_path(input_dir):
    normalized_input_dir = os.path.abspath(input_dir)
    input_dir_name = os.path.basename(normalized_input_dir)
    if input_dir_name == "":
        raise ValueError("不支持直接使用根目录作为输入目录")
    return os.path.join(os.path.dirname(normalized_input_dir), f"{input_dir_name}_unlock")


def build_target_output_dir(file_path, input_root_dir, output_root_dir):
    relative_dir = os.path.dirname(os.path.relpath(file_path, input_root_dir))
    return output_root_dir if relative_dir == "" else os.path.join(output_root_dir, relative_dir)


def resolve_input_files(input_path):
    normalized_input_path = os.path.abspath(input_path)
    if os.path.isdir(normalized_input_path):
        input_root_dir = normalized_input_path
        files_to_decrypt = collect_xm_files(input_root_dir)
        if not files_to_decrypt:
            raise FileNotFoundError(f"在 {input_root_dir} 及其子目录中找不到 .xm 文件")
        return input_root_dir, files_to_decrypt

    if not os.path.isfile(normalized_input_path):
        raise FileNotFoundError(f"{input_path} 不是有效的文件或目录")

    if not normalized_input_path.lower().endswith('.xm'):
        logger.warning(f"警告: {normalized_input_path} 可能不是 .xm 文件")

    return os.path.dirname(normalized_input_path), [normalized_input_path]


def print_usage():
    logger.info("使用方法:")
    logger.info("  python3 main.py <xm_file_path_or_directory> [-mp3]")
    logger.info("\n说明:")
    logger.info("  传入文件时，只处理该文件，并以其父目录作为输入目录")
    logger.info("  传入目录时，递归处理目录下所有 .xm 文件")
    logger.info("  输出目录固定为输入目录同级的 *_unlock 目录")
    logger.info("\n示例:")
    logger.info("  python3 main.py /path/to/file.xm")
    logger.info("  python3 main.py /path/to/file.xm -mp3")
    logger.info("  python3 main.py /path/to/directory")
    logger.info("  python3 main.py /path/to/directory -mp3")


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
        target_output_dir = build_target_output_dir(file_path, input_path, output_path)
        decrypt_xm_file(file_path, target_output_dir, force_mp3, verbose=False)
        return True, file_path, ""
    except Exception as e:
        return False, file_path, str(e)


def parse_cli_args(args):
    force_mp3 = False
    if "-mp3" in args:
        force_mp3 = True
        args = [arg for arg in args if arg != "-mp3"]

    if len(args) != 1:
        if len(args) > 1:
            logger.error("错误: 不再支持自定义输出目录，输出会自动写入输入目录同级的 *_unlock 目录")
        print_usage()
        sys.exit(1)

    return args[0], force_mp3


def run_batch_decrypt(input_root_dir, files_to_decrypt, output_path, force_mp3):
    total_files = len(files_to_decrypt)
    successful = 0
    failed = 0
    failed_files = []

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
                executor.submit(decrypt_xm_file_worker, file, input_root_dir, output_path, force_mp3)
                for file in files_to_decrypt
            ]

            for future in as_completed(futures):
                current_ok, current_file_path, current_err = future.result()
                completed_count += 1
                if current_ok:
                    successful += 1
                else:
                    failed += 1
                    failed_files.append((current_file_path, current_err))

                current_file = os.path.basename(current_file_path)
                progress.update(task_id, completed=completed_count)
                live.update(
                    build_batch_progress_renderable(total_files, output_path, current_file, progress)
                )

    logger.info(f"=====>> 解密完成！成功: {successful}/{total_files}, 失败: {failed}/{total_files}")
    if failed_files:
        logger.error("以下文件解密失败:")
        for failed_file, error_message in failed_files:
            logger.error(f"- {failed_file}: {error_message}")


def main():
    input_path, force_mp3 = parse_cli_args(sys.argv[1:])
    try:
        input_root_dir, files_to_decrypt = resolve_input_files(input_path)
        output_path = build_unlock_output_path(input_root_dir)
    except (FileNotFoundError, ValueError) as e:
        logger.error(f"错误: {e}")
        sys.exit(1)

    run_batch_decrypt(input_root_dir, files_to_decrypt, output_path, force_mp3)


if __name__ == "__main__":
    main()
