import exifr from 'exifr';

export interface MetadataInspectionResult {
  categoriesPresent: string[];
  hasGps: boolean;
  hasDeviceInfo: boolean;
  hasTimestamps: boolean;
  orientation?: number;
  pngTextChunksFound: string[];
  rawSummaryInMemory: Record<string, string>;
  notes: string[];
}

export function scanPngTextChunks(bytes: Uint8Array): string[] {
  const found: string[] = [];
  if (bytes.length < 16 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return found;
  let offset = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt' || type === 'eXIf') {
      found.push(type);
    }
    if (type === 'IEND') break;
    offset += 12 + length;
    if (length > bytes.length) break;
  }
  return Array.from(new Set(found));
}

export async function inspectImageMetadata(bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg'): Promise<MetadataInspectionResult> {
  const categoriesPresent: string[] = [];
  const rawSummaryInMemory: Record<string, string> = {};
  const notes: string[] = [];
  let hasGps = false;
  let hasDeviceInfo = false;
  let hasTimestamps = false;
  let orientation: number | undefined;

  const pngTextChunksFound = mimeType === 'image/png' ? scanPngTextChunks(bytes) : [];
  if (pngTextChunksFound.length > 0) {
    categoriesPresent.push(`PNG Chunks (${pngTextChunksFound.join(', ')})`);
  }

  try {
    const parsed = await exifr.parse(bytes, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: false,
      icc: false,
    });
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.latitude === 'number' || typeof parsed.longitude === 'number' || parsed.GPSLatitude) {
        hasGps = true;
        categoriesPresent.push('GPS Coordinates');
        rawSummaryInMemory.GPS = `${parsed.latitude ?? '?'}, ${parsed.longitude ?? '?'}`;
      }
      if (parsed.Make || parsed.Model || parsed.Software || parsed.LensModel) {
        hasDeviceInfo = true;
        categoriesPresent.push('Camera / Device / Software');
        rawSummaryInMemory.Device = [parsed.Make, parsed.Model, parsed.Software].filter(Boolean).join(' / ');
      }
      if (parsed.DateTimeOriginal || parsed.CreateDate || parsed.ModifyDate) {
        hasTimestamps = true;
        categoriesPresent.push('Timestamps');
        rawSummaryInMemory.Timestamp = String(parsed.DateTimeOriginal || parsed.CreateDate || parsed.ModifyDate);
      }
      if (typeof parsed.Orientation === 'number') {
        orientation = parsed.Orientation;
        categoriesPresent.push(`Orientation (${parsed.Orientation})`);
        rawSummaryInMemory.Orientation = String(parsed.Orientation);
      }
    }
  } catch {
    notes.push('EXIF parser reported no readable TIFF/EXIF header.');
  }

  if (categoriesPresent.length === 0) {
    notes.push('No EXIF/GPS/PNG text metadata detected by supported parser checks.');
  } else {
    notes.push('Fresh Canvas re-encoding on export omits original EXIF/GPS/PNG text chunks.');
  }

  return {
    categoriesPresent,
    hasGps,
    hasDeviceInfo,
    hasTimestamps,
    orientation,
    pngTextChunksFound,
    rawSummaryInMemory,
    notes,
  };
}
