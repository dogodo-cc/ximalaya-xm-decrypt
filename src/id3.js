import NodeID3 from 'node-id3';

export class XMInfo {
    constructor(fields = {}) {
        this.title = fields.title || '';
        this.artist = fields.artist || '';
        this.album = fields.album || '';
        this.tracknumber = fields.tracknumber || 0;
        this.size = fields.size || 0;
        this.headerSize = fields.headerSize || 0;
        this.ISRC = fields.ISRC || '';
        this.encodedby = fields.encodedby || '';
        this.encodingTechnology = fields.encodingTechnology || '';
    }

    iv() {
        const source = this.ISRC !== '' ? this.ISRC : this.encodedby;
        if (!source || source.length % 2 !== 0) {
            throw new Error('无法从 TSRC/TENC 构造 AES IV');
        }
        return Buffer.from(source, 'hex');
    }
}

function decodeSyncSafeInteger(buffer) {
    return ((buffer[0] & 0x7f) << 21) | ((buffer[1] & 0x7f) << 14) | ((buffer[2] & 0x7f) << 7) | (buffer[3] & 0x7f);
}

function decodeFrameSize(buffer, versionMajor) {
    if (versionMajor === 4) {
        return decodeSyncSafeInteger(buffer);
    }
    return buffer.readUInt32BE(0);
}

function removeUnsynchronization(data) {
    const output = Buffer.allocUnsafe(data.length);
    let writeIndex = 0;
    for (let i = 0; i < data.length; i += 1) {
        output[writeIndex++] = data[i];
        if (data[i] === 0xff && i + 1 < data.length && data[i + 1] === 0x00) {
            i += 1;
        }
    }
    return output.subarray(0, writeIndex);
}

function parseId3Header(rawData) {
    if (rawData.length < 10 || rawData.subarray(0, 3).toString('ascii') !== 'ID3') {
        throw new Error('XM 文件头中缺少 ID3 标签');
    }

    const versionMajor = rawData[3];
    const flags = rawData[5];
    const tagPayloadSize = decodeSyncSafeInteger(rawData.subarray(6, 10));
    const hasFooter = versionMajor === 4 && (flags & 0x10) !== 0;
    const totalTagSize = 10 + tagPayloadSize + (hasFooter ? 10 : 0);

    return {
        versionMajor,
        totalTagSize,
        tagPayloadStart: 10,
        tagPayloadEnd: 10 + tagPayloadSize,
        unsynchronized: (flags & 0x80) !== 0,
        hasExtendedHeader: (flags & 0x40) !== 0,
    };
}

function getExtendedHeaderSize(tagData, versionMajor) {
    if (tagData.length < 4) {
        throw new Error('ID3 扩展头长度不足');
    }

    if (versionMajor === 4) {
        return decodeSyncSafeInteger(tagData.subarray(0, 4));
    }

    return tagData.readUInt32BE(0);
}

function decodeTextFrame(frameData) {
    if (!frameData || frameData.length === 0) {
        return '';
    }

    const encoding = frameData[0];
    const body = frameData.subarray(1);

    if (encoding === 0) {
        return Buffer.from(body).toString('latin1').replace(/\0+$/g, '').trim();
    }

    if (encoding === 3) {
        return Buffer.from(body).toString('utf8').replace(/\0+$/g, '').trim();
    }

    if (encoding === 1) {
        if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
            return new TextDecoder('utf-16be').decode(body.subarray(2)).replace(/\0+$/g, '').trim();
        }
        if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
            return new TextDecoder('utf-16le').decode(body.subarray(2)).replace(/\0+$/g, '').trim();
        }
        return new TextDecoder('utf-16le').decode(body).replace(/\0+$/g, '').trim();
    }

    if (encoding === 2) {
        return new TextDecoder('utf-16be').decode(body).replace(/\0+$/g, '').trim();
    }

    return Buffer.from(body).toString('utf8').replace(/\0+$/g, '').trim();
}

function parseTrackNumber(text) {
    const match = String(text || '').match(/\d+/);
    return match ? Number.parseInt(match[0], 10) : 0;
}

function getRawTagString(tags, frameName) {
    const rawValue = tags?.raw?.[frameName];
    if (Array.isArray(rawValue)) {
        return String(rawValue[0] || '').trim();
    }
    if (rawValue == null) {
        return '';
    }
    return String(rawValue).trim();
}

function getManualTagMap(rawData, id3Header) {
    let tagData = rawData.subarray(id3Header.tagPayloadStart, id3Header.tagPayloadEnd);
    if (id3Header.unsynchronized) {
        tagData = removeUnsynchronization(tagData);
    }

    let offset = 0;
    if (id3Header.hasExtendedHeader) {
        const extendedHeaderSize = getExtendedHeaderSize(tagData, id3Header.versionMajor);
        if (extendedHeaderSize <= 0 || extendedHeaderSize > tagData.length) {
            throw new Error('ID3 扩展头长度非法');
        }
        offset += extendedHeaderSize;
    }

    const tagMap = new Map();
    while (offset + 10 <= tagData.length) {
        const frameId = tagData.subarray(offset, offset + 4).toString('ascii');
        if (!frameId.trim() || /^\x00+$/.test(frameId)) {
            break;
        }

        const frameSize = decodeFrameSize(tagData.subarray(offset + 4, offset + 8), id3Header.versionMajor);
        const frameDataStart = offset + 10;
        const frameDataEnd = frameDataStart + frameSize;
        if (frameSize <= 0 || frameDataEnd > tagData.length) {
            break;
        }

        tagMap.set(frameId, decodeTextFrame(tagData.subarray(frameDataStart, frameDataEnd)));
        offset = frameDataEnd;
    }

    return tagMap;
}

export function getXmInfo(rawData) {
    const id3Header = parseId3Header(rawData);
    let parsedTags = {};

    try {
        parsedTags = NodeID3.read(rawData, { noRaw: false }) || {};
    } catch {
        parsedTags = {};
    }

    const manualTagMap = getManualTagMap(rawData, id3Header);

    const info = new XMInfo({
        headerSize: id3Header.totalTagSize,
        title: String(parsedTags.title || manualTagMap.get('TIT2') || ''),
        album: String(parsedTags.album || manualTagMap.get('TALB') || ''),
        artist: String(parsedTags.artist || manualTagMap.get('TPE1') || ''),
        tracknumber: parseTrackNumber(parsedTags.trackNumber || manualTagMap.get('TRCK') || ''),
        ISRC: String(parsedTags.ISRC || getRawTagString(parsedTags, 'TSRC') || manualTagMap.get('TSRC') || ''),
        encodedby: String(parsedTags.encodedBy || getRawTagString(parsedTags, 'TENC') || manualTagMap.get('TENC') || ''),
        size: Number.parseInt(String(parsedTags.size || getRawTagString(parsedTags, 'TSIZ') || manualTagMap.get('TSIZ') || '0'), 10) || 0,
        encodingTechnology: String(parsedTags.encodingTechnology || getRawTagString(parsedTags, 'TSSE') || manualTagMap.get('TSSE') || ''),
    });

    if (!info.size) {
        throw new Error('无法从 TSIZ 读取加密音频长度');
    }

    if (!info.encodingTechnology) {
        throw new Error('无法从 TSSE 读取 base64 前缀');
    }

    return info;
}
