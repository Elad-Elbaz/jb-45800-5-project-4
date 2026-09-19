/**
 * Multipart handling for the one upload route.
 *
 * The image is received as `multipart/form-data` rather than as a base64
 * string in a JSON body. Base64 inflates every payload by a third, and
 * accepting it would mean raising the JSON body limit to tens of megabytes for
 * every route on the server, including the ones that should never see a large
 * body at all. Multipart keeps the ceiling on the single endpoint that needs
 * one.
 *
 * Note the absence of a `fileFilter` checking the declared Content-Type.
 * That was here and was removed: the part's media type is chosen by the
 * client, so rejecting on it is both unsound and actively harmful. `curl -F
 * "image=@hand.png"` labels the part `application/octet-stream`, and a filter
 * demanding `image/*` rejects a perfectly valid PNG from a perfectly
 * reasonable client. The authoritative check is the magic-number sniff in
 * utils/imageType.ts, which reads the bytes themselves -- and having two
 * gates, one of them wrong, is worse than having the one that is right.
 */

import multer from 'multer';

import { env } from '../config/env';

/** The form field name the React client must use. */
export const UPLOAD_FIELD = 'image';

export const uploadSingleImage = multer({
  /**
   * In memory, not on disk. The file is forwarded straight to S3 and never
   * needed again locally, so a temp file would only add a write, a read and a
   * cleanup path that leaks on crash. `fileSize` below is what keeps this
   * bounded: multer aborts mid-stream once the limit is passed, so an
   * oversized upload never fully lands in the heap.
   */
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.maxUploadBytes,
    files: 1,
    fields: 4,
  },
}).single(UPLOAD_FIELD);
