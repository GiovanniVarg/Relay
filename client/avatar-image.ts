/** Browser-side preparation of bot thumbnails: any dropped PNG/JPEG/WebP becomes a small square data URL the server accepts. */
export const AVATAR_SOURCE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AVATAR_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const AVATAR_PIXELS = 256;
/** The API accepts at most 250 KB of image bytes in a 240 KB request body, so stay well below both. */
const AVATAR_MAX_CHARACTERS = 150_000;

export const isAvatarSourceType = (type: string) => (AVATAR_SOURCE_TYPES as readonly string[]).includes(type);

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read that image. Try a different PNG, JPEG, or WebP file.'));
    image.src = url;
  });
}

/** Center-crops to a square, scales to 256 px and re-encodes so the saved thumbnail is always small. */
export async function prepareAvatarImage(file: File): Promise<string> {
  if (!isAvatarSourceType(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > AVATAR_SOURCE_MAX_BYTES) throw new Error('Choose an image smaller than 10 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const width = image.naturalWidth, height = image.naturalHeight, side = Math.min(width, height);
    if (!side) throw new Error('Could not read that image. Try a different PNG, JPEG, or WebP file.');
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_PIXELS; canvas.height = AVATAR_PIXELS;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot resize images. Try a different browser.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS);
    // WebP keeps transparency; browsers that cannot encode it fall back to PNG/JPEG below.
    for (const quality of [0.9, 0.75, 0.55]) {
      const webp = canvas.toDataURL('image/webp', quality);
      if (webp.startsWith('data:image/webp;base64,') && webp.length <= AVATAR_MAX_CHARACTERS) return webp;
      if (!webp.startsWith('data:image/webp;base64,')) break;
    }
    // JPEG has no alpha channel, so repaint on a solid background first.
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, AVATAR_PIXELS, AVATAR_PIXELS);
    for (const quality of [0.9, 0.75, 0.55, 0.4]) {
      const jpeg = canvas.toDataURL('image/jpeg', quality);
      if (jpeg.startsWith('data:image/jpeg;base64,') && jpeg.length <= AVATAR_MAX_CHARACTERS) return jpeg;
    }
    throw new Error('That image is too detailed to shrink into a thumbnail. Try a simpler image.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
