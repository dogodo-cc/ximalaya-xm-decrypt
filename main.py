import base64
import io
import sys
import re
import magic
import pathlib
import os
import glob
import logging
import shutil
import subprocess
import tempfile
import mutagen
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from mutagen.easyid3 import ID3
from wasmer import Store, Module, Instance, Uint8Array, Int32Array, engine
from wasmer_compiler_cranelift import Compiler

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


def get_str(x):
    if x is None:
        return ""
    return x


def read_file(x):
    with open(x, "rb") as f:
        return f.read()


# return number of id3 bytes
def get_xm_info(data: bytes):
    # print(EasyID3(io.BytesIO(data)))
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
    for i, b in enumerate(data):
        memory_view[i] = b


def xm_decrypt(raw_data):
    # load xm encryptor
    # print("loading xm encryptor")
    xm_encryptor = Instance(Module(
        Store(engine.Universal(Compiler)),
        pathlib.Path("./xm_encryptor.wasm").read_bytes()
    ))
    # decode id3
    xm_info = get_xm_info(raw_data)
    # print("id3 header size: ", hex(xm_info.header_size))
    encrypted_data = raw_data[xm_info.header_size:xm_info.header_size + xm_info.size:]

    # Stage 1 aes-256-cbc
    xm_key = b"ximalayaximalayaximalayaximalaya"
    # print(f"decrypt stage 1 (aes-256-cbc):\n"
    #       f"    data length = {len(encrypted_data)},\n"
    #       f"    key = {xm_key},\n"
    #       f"    iv = {xm_info.iv().hex()}")
    cipher = AES.new(xm_key, AES.MODE_CBC, xm_info.iv())
    de_data = cipher.decrypt(pad(encrypted_data, 16))
    # print("success")
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
    # print(bytearray(memory_i.buffer)[track_id_offset:track_id_offset + len(track_id)].decode())
    # print(f"decrypt stage 2 (xmDecrypt):\n"
    #       f"    stack_pointer = {stack_pointer},\n"
    #       f"    data_pointer = {de_data_offset}, data_length = {len(de_data)},\n"
    #       f"    track_id_pointer = {track_id_offset}, track_id_length = {len(track_id)}")
    # print("success")
    xm_encryptor.exports.g(stack_pointer, de_data_offset, len(de_data), track_id_offset, len(track_id))
    memview_int32: Int32Array = memory_i.int32_view(offset=stack_pointer // 4)
    result_pointer = memview_int32[0]
    result_length = memview_int32[1]
    if memview_int32[2] != 0 or memview_int32[3] != 0:
        raise RuntimeError(f"XM decryption validation failed: flags[2]={memview_int32[2]}, flags[3]={memview_int32[3]}")
    result_data = bytearray(memory_i.buffer)[result_pointer:result_pointer + result_length].decode()
    # Stage 3 combine
    # print(f"Stage 3 (base64)")
    decrypted_data = base64.b64decode(xm_info.encoding_technology + result_data)
    final_data = decrypted_data + raw_data[xm_info.header_size + xm_info.size::]
    # print("success")
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


def decrypt_xm_file(from_file, output_path='./output', force_mp3=False):
    logger.info(f"正在解密{_path(from_file)}")
    data = read_file(from_file)
    info, audio_data = xm_decrypt(data)
    detected_ext = find_ext(audio_data[:0xff])
    output_ext = detected_ext

    if force_mp3 and detected_ext != 'mp3':
        logger.info(f"检测到格式为 {detected_ext}，开始转码为 mp3")
        audio_data = convert_to_mp3(audio_data, detected_ext)
        output_ext = 'mp3'

    output = f"{output_path}/{replace_invalid_chars(info.album)}/{replace_invalid_chars(info.title)}.{output_ext}"
    if not os.path.exists(f"{output_path}/{replace_invalid_chars(info.album)}"):
        os.makedirs(f"{output_path}/{replace_invalid_chars(info.album)}")
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
    logger.info(f"解密成功，文件保存至{_path(output)}！")


def replace_invalid_chars(name):
    invalid_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|']
    for char in invalid_chars:
        if char in name:
            name = name.replace(char, " ")
    return name


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
        if not os.path.isdir(input_path):
            logger.error(f"错误: {input_path} 不是有效的目录")
            sys.exit(1)
        files_to_decrypt = glob.glob(os.path.join(input_path, "*.xm"))
        if not files_to_decrypt:
            logger.error(f"错误: 在 {input_path} 中找不到 .xm 文件")
            sys.exit(1)
        logger.info(f"找到 {len(files_to_decrypt)} 个文件待解密")
    else:
        if not os.path.isfile(input_path):
            logger.error(f"错误: {input_path} 不是有效的文件")
            sys.exit(1)
        if not input_path.lower().endswith('.xm'):
            logger.warning(f"警告: {input_path} 可能不是 .xm 文件")
        files_to_decrypt = [input_path]
    
    logger.info(f"输出路径:{_path(output_path)}")
    logger.info("-" * 50)
    
    total_files = len(files_to_decrypt)
    successful = 0
    failed = 0
    
    for idx, file in enumerate(files_to_decrypt, 1):
        try:
            logger.info(f"[{idx}/{total_files}] 处理文件: {os.path.basename(file)}")
            decrypt_xm_file(file, output_path, force_mp3)
            successful += 1
        except Exception as e:
            failed += 1
            logger.error(f"[{idx}/{total_files}] 解密 {file} 失败: {e}")
    
    logger.info("-" * 50)
    logger.info(f"解密完成！成功: {successful}/{total_files}, 失败: {failed}/{total_files}")
