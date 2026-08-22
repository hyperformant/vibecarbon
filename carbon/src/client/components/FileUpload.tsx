import { IconLoader2 as Loader2, IconUpload as Upload, IconX as X } from '@tabler/icons-react';
import { useCallback, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

interface FileUploadProps {
  bucket: string;
  path: string;
  accept?: string;
  maxSize?: number;
  onUpload: (url: string) => void;
  onError?: (error: string) => void;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Drag-and-drop file upload component using Supabase Storage.
 *
 * Usage:
 *   <FileUpload
 *     bucket="avatars"
 *     path={`${userId}/avatar`}
 *     accept="image/*"
 *     maxSize={2 * 1024 * 1024}
 *     onUpload={(url) => setAvatarUrl(url)}
 *   />
 */
export function FileUpload({
  bucket,
  path,
  accept,
  maxSize = 10 * 1024 * 1024,
  onUpload,
  onError,
  className,
  children,
}: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (file: File) => {
      if (file.size > maxSize) {
        onError?.(`File too large. Max size: ${Math.round(maxSize / 1024 / 1024)}MB`);
        return;
      }

      setUploading(true);
      try {
        const ext = file.name.split('.').pop();
        const filePath = ext ? `${path}.${ext}` : path;

        const { error } = await supabase.storage.from(bucket).upload(filePath, file, {
          upsert: true,
        });

        if (error) throw error;

        const {
          data: { publicUrl },
        } = supabase.storage.from(bucket).getPublicUrl(filePath);

        onUpload(publicUrl);
      } catch (err) {
        onError?.(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [bucket, path, maxSize, onUpload, onError]
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
            Drag & drop or <span className="text-primary underline">browse</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Max {Math.round(maxSize / 1024 / 1024)}MB
          </p>
        </>
      )}
    </button>
  );
}

/**
 * Avatar upload component with preview.
 */
export function AvatarUpload({
  userId,
  currentUrl,
  onUpload,
  size = 'lg',
}: {
  userId: string;
  currentUrl?: string | null;
  onUpload: (url: string) => void;
  size?: 'sm' | 'lg';
}) {
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
          <img src={url} alt="Avatar" className="size-full object-cover" />
        ) : (
          <span className="text-2xl text-muted-foreground">?</span>
        )}
      </div>
      <div className="space-y-1">
        <FileUpload
          bucket="avatars"
          path={`${userId}/avatar`}
          accept="image/jpeg,image/png,image/gif,image/webp"
          maxSize={2 * 1024 * 1024}
          onUpload={handleUpload}
          onError={setError}
        >
          <Button type="button" variant="outline" size="sm">
            Change avatar
          </Button>
        </FileUpload>
        {error ? (
          <p className="flex items-center gap-1 text-xs text-destructive">
            <X className="size-3" />
            {error}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">JPG, PNG or GIF. Max 2MB.</p>
        )}
      </div>
    </div>
  );
}
