/**
 * FileUpload: presign -> PUT to the storage URL -> onUpload(fileUrl).
 * The server owns the object key; the browser only ever PUTs the exact bytes
 * it declared at presign time.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'tok' } } })),
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { FileUpload } from '@/components/FileUpload';

const presignOk = {
  key: 'private/u1/abc.pdf',
  url: 'https://s3.example.com/put?sig=1',
  headers: { 'Content-Type': 'application/pdf' },
  expiresIn: 300,
  fileUrl: '/api/files/private/u1/abc.pdf',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe('FileUpload', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const file = new File(['hello world'], 'doc.pdf', { type: 'application/pdf' });

  it('presigns, PUTs with returned headers, then calls onUpload with fileUrl', async () => {
    fetchMock.mockResolvedValueOnce(json(200, presignOk)).mockResolvedValueOnce(new Response(null));
    const onUpload = vi.fn();
    const { container } = render(<FileUpload kind="private" onUpload={onUpload} />);
    pick(container, file);

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith('/api/files/private/u1/abc.pdf'));

    const [presignUrl, presignInit] = fetchMock.mock.calls[0];
    expect(presignUrl).toBe('/api/v1/files/presign');
    expect(presignInit.method).toBe('POST');
    expect(presignInit.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(presignInit.body)).toEqual({
      kind: 'private',
      contentType: 'application/pdf',
      size: file.size,
    });

    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(putUrl).toBe(presignOk.url);
    expect(putInit.method).toBe('PUT');
    expect(putInit.headers).toEqual(presignOk.headers);
    expect(putInit.body).toBe(file);
  });

  it('reports a translated error when storage is not configured (503)', async () => {
    fetchMock.mockResolvedValueOnce(json(503, { error: 'storage_not_configured' }));
    const onError = vi.fn();
    const onUpload = vi.fn();
    const { container } = render(
      <FileUpload kind="private" onUpload={onUpload} onError={onError} />
    );
    pick(container, file);

    await waitFor(() => expect(onError).toHaveBeenCalledWith('upload.notConfigured'));
    expect(onUpload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an error when the PUT fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, presignOk))
      .mockResolvedValueOnce(new Response('denied', { status: 403 }));
    const onError = vi.fn();
    const onUpload = vi.fn();
    const { container } = render(
      <FileUpload kind="private" onUpload={onUpload} onError={onError} />
    );
    pick(container, file);

    await waitFor(() => expect(onError).toHaveBeenCalledWith('upload.failed'));
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('rejects files over maxSize without any request', async () => {
    const onError = vi.fn();
    const { container } = render(
      <FileUpload kind="private" maxSize={5} onUpload={vi.fn()} onError={onError} />
    );
    pick(container, file);
    await waitFor(() => expect(onError).toHaveBeenCalledWith('upload.tooLarge'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the browse prompt', () => {
    render(<FileUpload kind="private" onUpload={vi.fn()} />);
    expect(screen.getByText('upload.browse')).toBeTruthy();
  });
});
