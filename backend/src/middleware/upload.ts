/**
 * Multipart handling for the one upload route.
 *
 * The image is received as `multipart/form-data` rather than as a base64
 * string in a JSON body. Base64 inflates every payload by a third, and
 * accepting it would mean raising the JSON body limit to tens of megabytes for
 * every route on the server, including the ones that should never see a large
 * body at all. Multipart keeps the ceiling on the single endpoint that needs
 * one.
 */

import multer from 'multer';

import { env } from '../config/env';
import { ApiError } from '../utils/apiError';

/** The form field name the React client must use. */
export const UPLOAD_FIELD = 'image';

export const uploadSingleImage = multer({
  /**
   * In memory, not on disk. The file is forwarded straight to S3 and never
   * needed again locally, so a temp file would only add a write, a read and a
   * cleanup path that leaks on crash. The `fileSize` limit below is what keeps
   * this bounded -- multer aborts mid-stream on exceeding it, so an oversized
   * upload never fully lands in the heap.
   */
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.maxUploadBytes,
    files: 1,
    fields: 4,
  },
  /**
   * A cheap first gate only. The declared MIME type comes from the client and
   * is not evidence of anything, so the real check is the magic-number sniff
   * in utils/imageType.ts, after the bytes are in hand. Rejecting here simply
   * avoids buffering an obvious non-image at all.
   */
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      callback(
        ApiError.unsupportedMediaType(
          `Expected an image, received "${file.mimetype}".`,
        ),
      );
      return;
    }
    callback(null, true);
  },
}).single(UPLOAD_FIELD);
