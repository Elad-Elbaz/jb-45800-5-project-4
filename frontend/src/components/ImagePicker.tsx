import { useId, useRef, useState } from 'react';

import { ACCEPTED_MIME_TYPES, MAX_UPLOAD_BYTES } from '../config';
import { formatBytes } from '../utils/format';

interface ImagePickerProps {
  previewUrl: string | null;
  fileName: string | null;
  disabled: boolean;
  onSelect: (file: File) => void;
  onReject: (message: string) => void;
}

/**
 * File input plus a drop target, sharing one validation path.
 *
 * The checks here are a courtesy, not a defence: the server re-validates size
 * and sniffs the magic number regardless, because nothing arriving over HTTP
 * can be trusted to have passed through this component at all. What they buy
 * is an instant answer instead of a round trip for an obvious mistake.
 */
export function ImagePicker({
  previewUrl,
  fileName,
  disabled,
  onSelect,
  onReject,
}: ImagePickerProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const accept = (file: File | undefined): void => {
    if (!file) {
      return;
    }
    if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
      onReject(`${file.type || 'That file type'} is not supported. Use PNG, JPEG, WebP or BMP.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      onReject(
        `That image is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
      );
      return;
    }
    onSelect(file);
  };

  return (
    <div
      className={`picker${isDragging ? ' picker--dragging' : ''}${disabled ? ' picker--disabled' : ''}`}
      onDragOver={(event) => {
        // Without preventDefault the browser navigates to the dropped file,
        // which looks exactly like the app crashing.
        event.preventDefault();
        if (!disabled) {
          setIsDragging(true);
        }
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        if (!disabled) {
          accept(event.dataTransfer.files[0]);
        }
      }}
    >
      <input
        ref={inputRef}
        id={inputId}
        className="picker__input"
        type="file"
        accept={ACCEPTED_MIME_TYPES.join(',')}
        disabled={disabled}
        onChange={(event) => {
          accept(event.target.files?.[0]);
          // Reset, so choosing the same file twice in a row still fires
          // onChange. Without this, re-picking after a reset does nothing.
          event.target.value = '';
        }}
      />

      {previewUrl ? (
        <div className="picker__preview">
          <img src={previewUrl} alt={fileName ? `Preview of ${fileName}` : 'Selected image'} />
          <p className="picker__filename">{fileName}</p>
        </div>
      ) : (
        <div className="picker__empty">
          <p className="picker__headline">Drop an image here</p>
          <p className="picker__hint">PNG, JPEG, WebP or BMP, up to {formatBytes(MAX_UPLOAD_BYTES)}</p>
        </div>
      )}

      {/* A real <label> for the input: it keeps the control keyboard
          reachable and screen-reader labelled, which a div with an onClick
          would not be. */}
      <label className="picker__button" htmlFor={inputId}>
        {previewUrl ? 'Choose a different image' : 'Choose an image'}
      </label>
    </div>
  );
}
