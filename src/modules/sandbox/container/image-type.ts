/**
 * Image sniffing for the container-backed `read` tool.
 *
 * This mirrors pi's own `detectSupportedImageMimeType` (`utils/mime.js`), which is not exported: only the
 * file-path variant is, and that one reads the host filesystem, which is exactly what these tools must not
 * do. The bytes come from the container, so the sniff has to happen on a buffer here.
 *
 * The rules are the ones pi applies, including the two rejections that keep a "supported" extension from
 * sending something the image pipeline cannot handle: an EXIF-only JPEG and an animated PNG.
 */

/** How much of the file pi reads for sniffing; the PNG chunk walk needs the most. */
export const IMAGE_TYPE_SNIFF_BYTES = 4100;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectImageMimeType(buffer: Buffer): string | null {
    if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
        return buffer[3] === 0xf7 ? null : "image/jpeg";
    }

    if (startsWith(buffer, PNG_SIGNATURE)) {
        return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
    }

    if (startsWithAscii(buffer, 0, "GIF87a") || startsWithAscii(buffer, 0, "GIF89a")) {
        return "image/gif";
    }

    if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
        return "image/webp";
    }

    if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
        return "image/bmp";
    }

    return null;
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
    return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Buffer, offset: number, text: string): boolean {
    if (buffer.length < offset + text.length) {
        return false;
    }

    return text.split("").every((char, index) => buffer[offset + index] === char.charCodeAt(0));
}

function isPng(buffer: Buffer): boolean {
    return (
        buffer.length >= 16 &&
        buffer.readUInt32BE(PNG_SIGNATURE.length) === 13 &&
        startsWithAscii(buffer, 12, "IHDR")
    );
}

/** Walk the PNG chunks for an animation control chunk before the first image data chunk. */
function isAnimatedPng(buffer: Buffer): boolean {
    let offset = PNG_SIGNATURE.length;

    while (offset + 8 <= buffer.length) {
        const chunkLength = buffer.readUInt32BE(offset);
        const chunkTypeOffset = offset + 4;

        if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) {
            return true;
        }

        if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) {
            return false;
        }

        const nextOffset = offset + 8 + chunkLength + 4;

        if (nextOffset <= offset || nextOffset > buffer.length) {
            return false;
        }

        offset = nextOffset;
    }

    return false;
}

function isBmp(buffer: Buffer): boolean {
    if (buffer.length < 26) {
        return false;
    }

    const declaredFileSize = buffer.readUInt32LE(2);
    const pixelDataOffset = buffer.readUInt32LE(10);
    const dibHeaderSize = buffer.readUInt32LE(14);

    if (declaredFileSize !== 0 && declaredFileSize < 26) {
        return false;
    }

    if (pixelDataOffset < 14 + dibHeaderSize) {
        return false;
    }

    if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) {
        return false;
    }

    let colorPlanes: number;
    let bitsPerPixel: number;

    if (dibHeaderSize === 12) {
        colorPlanes = buffer.readUInt16LE(22);
        bitsPerPixel = buffer.readUInt16LE(24);
    } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
        if (buffer.length < 30) {
            return false;
        }

        colorPlanes = buffer.readUInt16LE(26);
        bitsPerPixel = buffer.readUInt16LE(28);
    } else {
        return false;
    }

    return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}
