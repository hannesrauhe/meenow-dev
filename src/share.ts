// Save an image to the user's device: OS share sheet where supported (the only
// route into iOS Photos from a PWA), anchor download as fallback.

export type SaveResult = 'shared' | 'downloaded' | 'cancelled' | 'failed';

export async function saveImage(blob: Blob, filename: string): Promise<SaveResult> {
  const file = new File([blob], filename, { type: 'image/jpeg' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      // User closed the share sheet — don't double up with a fallback download.
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}

export function dateFilename(prefix: string, date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${prefix}-${date.getFullYear()}-${m}-${d}.jpg`;
}
