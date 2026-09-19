/**
 * Identifies an image by its leading bytes rather than by what the upload
 * claimed to be.
 *
 * The `Content-Type` on a multipart part and the filename extension are both
 * supplied by the client, so neither is evidence. Sniffing the magic number is
 * what actually guarantees the worker is handed a decodable image: without it,
 * a renamed `.exe` reaches S3, reaches the queue, reaches PyTorch, and only
 * then fails -- one container away from where the mistake was made, after a
 * model load and a database round trip.
 *
 * The recognised set matches the suffixes predict.py already accepts, so the
 * web path cannot admit a format the CLI path would reject.
 */

export interface DetectedImageType {
  /** Canonical media type, used for the S3 object and the download response. */
  mime: string;
  /** Canonical extension *without* the dot, used to build the object key. */
  extension: string;
}

/** `true` when every byte of `signature` appears at `offset` in `buffer`. */
function matchesAt(buffer: Buffer, offset: number, signature: readonly number[]): boolean {
  if (buffer.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => buffer[offset + index] === byte);
}

const ASCII_RIFF = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const ASCII_WEBP = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"

export function detectImageType(buffer: Buffer): DetectedImageType | null {
  // PNG: the 8-byte signature includes CR/LF/EOF bytes specifically so that a
  // corrupting text-mode transfer is detectable.
  if (matchesAt(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', extension: 'png' };
  }

  // JPEG: SOI marker, then the first byte of the following marker.
  if (matchesAt(buffer, 0, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }

  // WebP is a RIFF container; the form type at offset 8 is what distinguishes
  // it from a WAV or an AVI, so checking "RIFF" alone would not be enough.
  if (matchesAt(buffer, 0, ASCII_RIFF) && matchesAt(buffer, 8, ASCII_WEBP)) {
    return { mime: 'image/webp', extension: 'webp' };
  }

  // BMP: "BM".
  if (matchesAt(buffer, 0, [0x42, 0x4d])) {
    return { mime: 'image/bmp', extension: 'bmp' };
  }

  return null;
}

/** Human-readable list for error messages, kept next to the checks above. */
export const SUPPORTED_IMAGE_FORMATS = 'PNG, JPEG, WebP or BMP';
