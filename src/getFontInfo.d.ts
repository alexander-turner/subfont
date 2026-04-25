declare function getFontInfo(
  fontBuffer: Buffer | Uint8Array
): Promise<{ characterSet: number[]; [key: string]: any }>;
export = getFontInfo;
