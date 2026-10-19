import type { Point } from './types';

export type StabilizationMode = 'off' | 'light' | 'natural' | 'strong';
export interface StrokeStabilizer { next(point: Point): Point }

interface Tuning { minimumCutoff: number; speedGain: number; derivativeCutoff: number; maximumLag: number }
// Frequencies are Hz; velocity is document pixels/second; lag is document pixels.
// These are handwriting starting points, not a claim of physical iPad validation.
const TUNING: Record<Exclude<StabilizationMode, 'off'>, Tuning> = {
  light: { minimumCutoff: 3.2, speedGain: .055, derivativeCutoff: 12, maximumLag: 1 },
  natural: { minimumCutoff: 1.8, speedGain: .045, derivativeCutoff: 10, maximumLag: 2 },
  strong: { minimumCutoff: 1.15, speedGain: .035, derivativeCutoff: 8, maximumLag: 3 },
};
const DEFAULT_INTERVAL = 1 / 120;
const alpha = (cutoff: number, seconds: number): number => 1 / (1 + 1 / (2 * Math.PI * cutoff * seconds));

/**
 * Causal, speed-adaptive 2D low-pass filtering inspired by Casiez, Roussel & Vogel,
 * CHI 2012: https://gery.casiez.net/1euro/ . This is an original implementation.
 *
 * Both axes share one speed-based cutoff, avoiding an axis preference. A spatial
 * lag bound protects small symbols and quick turns. No prediction, line fitting,
 * resampling, pen-up reconstruction, or changes to saved strokes take place here.
 * Input t is an optional millisecond timestamp; no wall-clock time is consulted.
 */
export function createStrokeStabilizer(mode: StabilizationMode = 'natural'): StrokeStabilizer {
  if (mode === 'off') return { next: point => ({ ...point }) };
  const tuning = TUNING[mode] ?? TUNING.natural;
  let previousRaw: Point | undefined;
  let outputX = 0, outputY = 0, velocityX = 0, velocityY = 0;
  let timestamp: number | undefined, interval = DEFAULT_INTERVAL, moved = false;
  return {
    next(point: Point): Point {
      const time = typeof point.t === 'number' && Number.isFinite(point.t) ? point.t : undefined;
      if (!previousRaw) {
        previousRaw = { ...point }; outputX = point.x; outputY = point.y; timestamp = time;
        return { ...point };
      }
      let elapsed = interval;
      if (time !== undefined && timestamp !== undefined && time > timestamp) {
        // Bound ill-conditioned or delayed timestamps, not the input path itself.
        elapsed = Math.min(1 / 15, Math.max(1 / 1000, (time - timestamp) / 1000));
        interval = elapsed;
      }
      if (time !== undefined && (timestamp === undefined || time > timestamp)) timestamp = time;
      if (point.x === previousRaw.x && point.y === previousRaw.y) {
        // A stationary pointer-up/pressure update cannot grow an artificial tail.
        previousRaw = { ...point };
        return { ...point, x: outputX, y: outputY };
      }
      const derivativeAlpha = alpha(tuning.derivativeCutoff, elapsed);
      velocityX += derivativeAlpha * ((point.x - previousRaw.x) / elapsed - velocityX);
      velocityY += derivativeAlpha * ((point.y - previousRaw.y) / elapsed - velocityY);
      const cutoff = tuning.minimumCutoff + tuning.speedGain * Math.hypot(velocityX, velocityY);
      let weight = alpha(cutoff, elapsed);
      // Keep a tiny intentional two-sample dash from turning into only a dot.
      if (!moved) weight = Math.max(.65, weight);
      let nextX = outputX + weight * (point.x - outputX);
      let nextY = outputY + weight * (point.y - outputY);
      const lag = Math.hypot(point.x - nextX, point.y - nextY);
      if (lag > tuning.maximumLag) {
        const fraction = tuning.maximumLag / lag;
        nextX = point.x + (nextX - point.x) * fraction;
        nextY = point.y + (nextY - point.y) * fraction;
      }
      previousRaw = { ...point }; outputX = nextX; outputY = nextY; moved = true;
      return { ...point, x: nextX, y: nextY };
    },
  };
}
