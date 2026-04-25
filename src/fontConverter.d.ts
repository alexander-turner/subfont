export function convert(
  buffer: Buffer | Uint8Array,
  targetFormat: string,
  sourceFormat?: string
): Promise<Buffer>;
