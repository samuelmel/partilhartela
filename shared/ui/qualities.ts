export type QualityKey = '720p30' | '1080p30' | '1080p60';

export type QualityPreset = {
  label: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
};

export const qualities: Record<QualityKey, QualityPreset> = {
  '720p30': { label: '720p 30fps', width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
  '1080p30': { label: '1080p 30fps', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  '1080p60': { label: '1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 }
};

export const qualityKeys = Object.keys(qualities) as QualityKey[];

export function isQualityKey(value: string): value is QualityKey {
  return value in qualities;
}
