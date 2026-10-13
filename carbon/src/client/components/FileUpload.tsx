import { IconLoader2 as Loader2, IconUpload as Upload, IconX as X } from '@tabler/icons-react';
import type { TFunction } from 'i18next';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api';
import { resizeImage } from '@/lib/image-resize';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

interface FileUploadProps {
  /** 'avatar' is public-read through the app; 'private' is owner-only. */
  kind: 'avatar' | 'private';
  accept?: string;
  maxSize?: number;
  onUpload: (url: string) => void;
  onError?: (error: string) => void;
  /** Optional transform (e.g. resize) applied before presigning the exact bytes to PUT. */
  prepare?: (file: File) => Promise<Blob>;
  className?: string;
  children?: React.ReactNode;
}

interface PresignResponse {
  url: string;
  headers: Record<string, string>;
  fileUrl: string;
}

async function presignErrorMessage(res: Response, maxSize: number, t: TFunction): Promise<string> {
  if (res.status === 503) return t('upload.notConfigured');
  if (res.status === 429) return t('upload.tooManyRequests');
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (data.error === 'type_not_allowed') return t('upload.typeNotAllowed');
  if (data.error === 'size_not_allowed') {
    return t('upload.tooLarge', { size: Math.round(maxSize / 1024 / 1024) });
  }
  return t('upload.failed');
}

/**
 * Drag-and-drop file upload component using signed URLs.
 *
 * The browser asks the API for a presigned PUT URL, uploads the bytes straight
 * to object storage, then reports the app-relative `fileUrl` (`/api/files/...`).
 * The server owns the object key; callers never choose a path.
 *
 * Reading the file back:
 * - `kind="avatar"`: the `fileUrl` works as a plain `<img src={fileUrl}>`; the
 *   server redirects anyone to a signed read.
 * - `kind="private"`: also a plain `<a href={fileUrl} download>` or
 *   `<img src={fileUrl}>`. The browser sends the HttpOnly session cookie with
 *   the request, so the owner gets the signed read and anyone else a 404.
 *
 * Usage:
 *   <FileUpload
 *     kind="private"
 *     accept="application/pdf"
 *     maxSize={10 * 1024 * 1024}
 *     onUpload={(fileUrl) => save(fileUrl)}
 *   />
 */
export function FileUpload({
  kind,
  accept,
  maxSize = 10 * 1024 * 1024,
  onUpload,
  onError,
  prepare,
  className,
  children,
}: FileUploadProps) {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const body: Blob = prepare ? await prepare(file) : file;
        if (body.size > maxSize) {
          onError?.(t('upload.tooLarge', { size: Math.round(maxSize / 1024 / 1024) }));
          return;
        }

        // Presign with the size of the exact Blob we will PUT; Content-Length is signed.
        const presign = await apiFetch('/api/v1/files/presign', {
          method: 'POST',
          body: JSON.stringify({
            kind,
            contentType: body.type || file.type,
            size: body.size,
          }),
        });
        if (!presign.ok) {
          onError?.(await presignErrorMessage(presign, maxSize, t));
          return;
        }
        const { url, headers, fileUrl } = (await presign.json()) as PresignResponse;

        // Browsers forbid setting Content-Length; fetch derives it from the Blob body.
        const putHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(headers)) {
          if (name.toLowerCase() !== 'content-length') putHeaders[name] = value;
        }
        const put = await fetch(url, { method: 'PUT', headers: putHeaders, body });
        if (!put.ok) {
          onError?.(t('upload.failed'));
          return;
        }

        onUpload(fileUrl);
      } catch {
        onError?.(t('upload.failed'));
      } finally {
        setUploading(false);
      }
    },
    [kind, maxSize, prepare, onUpload, onError, t]
  );

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) upload(file);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) upload(file);
    // Reset input so same file can be re-selected
    e.target.value = '';
  }

  if (children) {
    return (
      <>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={handleChange}
          className="hidden"
        />
        <button type="button" onClick={() => inputRef.current?.click()} className="cursor-pointer">
          {children}
        </button>
      </>
    );
  }

  return (
    <button
      type="button"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        'flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors',
        dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
        className
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleChange}
        className="hidden"
      />
      {uploading ? (
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      ) : (
        <>
          <Upload className="mb-2 size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {t('upload.dragOr')}{' '}
            <span className="text-primary underline">{t('upload.browse')}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('upload.maxSize', { size: Math.round(maxSize / 1024 / 1024) })}
          </p>
        </>
      )}
    </button>
  );
}

const AVATAR_MAX_EDGE = 256;
const resizeAvatar = (file: File) => resizeImage(file, AVATAR_MAX_EDGE, 'image/webp');

/**
 * Avatar upload component with preview. Resizes to a 256px WebP in the browser
 * before uploading (GIFs are sent as-is to keep animation).
 */
export function AvatarUpload({
  currentUrl,
  onUpload,
  size = 'lg',
}: {
  currentUrl?: string | null;
  onUpload: (url: string) => void;
  size?: 'sm' | 'lg';
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(currentUrl || '');
  const [error, setError] = useState('');

  function handleUpload(newUrl: string) {
    setUrl(newUrl);
    setError('');
    onUpload(newUrl);
  }

  const sizeClass = size === 'sm' ? 'size-16' : 'size-20';

  return (
    <div className="flex items-center gap-4">
      <div
        className={cn(
          'relative overflow-hidden rounded-full bg-muted flex items-center justify-center',
          sizeClass
        )}
      >
        {url ? (
          <img src={url} alt={t('upload.avatarAlt')} className="size-full object-cover" />
        ) : (
          <span className="text-2xl text-muted-foreground">?</span>
        )}
      </div>
      <div className="space-y-1">
        <FileUpload
          kind="avatar"
          prepare={resizeAvatar}
          accept="image/jpeg,image/png,image/gif,image/webp"
          maxSize={2 * 1024 * 1024}
          onUpload={handleUpload}
          onError={setError}
        >
          <Button type="button" variant="outline" size="sm">
            {t('upload.changeAvatar')}
          </Button>
        </FileUpload>
        {error ? (
          <p className="flex items-center gap-1 text-xs text-destructive">
            <X className="size-3" />
            {error}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('upload.avatarHint')}</p>
        )}
      </div>
    </div>
  );
}
