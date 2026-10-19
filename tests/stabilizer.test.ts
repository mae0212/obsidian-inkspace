import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrokeStabilizer, type StabilizationMode } from '../src/stabilizer';
import type { Point } from '../src/types';

const modes: StabilizationMode[] = ['off', 'light', 'natural', 'strong'];
const process = (points: Point[], mode: StabilizationMode = 'natural'): Point[] => { const filter = createStrokeStabilizer(mode); return points.map(point => filter.next(point)); };
const rms = (values: number[]): number => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
function area(points: Point[]): number {
  return Math.abs(points.reduce((sum, point, i) => { const next = points[(i + 1) % points.length]; return sum + point.x * next.y - point.y * next.x; }, 0) / 2);
}

test('off is exact; every profile preserves the first point, dots, pressure, time and input ownership', () => {
  const dot = { x: 15.25, y: -3.75, pressure: .31, t: 1234.5 };
  for (const mode of modes) {
    const filter = createStrokeStabilizer(mode), output = filter.next(dot);
    assert.deepEqual(output, dot); assert.notEqual(output, dot);
    output.x = 500; assert.equal(dot.x, 15.25);
  }
  const points = Array.from({ length: 30 }, (_, i) => ({ x: i / 3, y: Math.sin(i), pressure: i / 30, t: i * 8.3 }));
  assert.deepEqual(process(points, 'off'), points);
  for (const mode of modes) process(points, mode).forEach((point, i) => { assert.equal(point.pressure, points[i].pressure); assert.equal(point.t, points[i].t); });
});

test('natural removes small high-frequency wobble at normal writing speeds without flattening the intended path', () => {
  for (const speed of [35, 80, 150]) {
    const raw = Array.from({ length: 361 }, (_, i) => {
      const seconds = i / 120;
      return { x: speed * seconds, y: .85 * Math.sin(2 * Math.PI * 27 * seconds) + .3 * Math.sin(2 * Math.PI * 19 * seconds), pressure: .5, t: seconds * 1000 };
    });
    const filtered = process(raw);
    const before = rms(raw.slice(30).map(point => point.y)), after = rms(filtered.slice(30).map(point => point.y));
    assert.ok(after < before * .65, `At ${speed}px/s jitter RMS ${before.toFixed(3)} -> ${after.toFixed(3)}`);
    assert.ok(filtered.at(-1)!.x > raw.at(-1)!.x - 2.001);
  }
});

test('profiles provide progressively more stabilization for a slowly moving hand', () => {
  const raw = Array.from({ length: 300 }, (_, i) => ({ x: i / 12, y: .8 * Math.sin(i * 1.2) + .3 * Math.sin(i * .79), pressure: .5, t: i * 1000 / 120 }));
  const jitter = modes.map(mode => rms(process(raw, mode).slice(30).map(point => point.y)));
  assert.ok(jitter[1] < jitter[0] * .6);
  assert.ok(jitter[2] < jitter[1]);
  assert.ok(jitter[3] < jitter[2]);
});

test('natural also reduces lower-frequency hand tremor on a diagonal trace', () => {
  const raw = Array.from({ length: 361 }, (_, i) => {
    const seconds = i / 120;
    return { x: seconds * 90 + .7 * Math.sin(seconds * 2 * Math.PI * 9), y: seconds * 45 + .8 * Math.sin(seconds * 2 * Math.PI * 12), pressure: .5, t: seconds * 1000 };
  });
  // Cross-track distance measures unwanted wobble independently of the allowed along-stroke lag.
  const crossTrack = (points: Point[]): number => rms(points.slice(30).map(point => (point.y * 2 - point.x) / Math.sqrt(5)));
  const before = crossTrack(raw), after = crossTrack(process(raw));
  assert.ok(after < before * .7, `Hand-tremor RMS ${before.toFixed(3)} -> ${after.toFixed(3)}`);
});

test('fast flicks and sharp turns stay close to the physical samples in document units', () => {
  const raw: Point[] = [];
  for (let i = 0; i <= 40; i++) raw.push({ x: i * 8, y: 0, pressure: .5, t: i * 4 });
  for (let i = 1; i <= 30; i++) raw.push({ x: 320, y: i * 5, pressure: .5, t: 160 + i * 8 });
  for (const [mode, maximum] of [['light', 1], ['natural', 2], ['strong', 3]] as const) {
    const filtered = process(raw, mode);
    filtered.forEach((point, i) => assert.ok(distance(point, raw[i]) <= maximum + 1e-9));
    assert.ok(filtered[41].y > 2, `${mode} failed to follow the first turning movement`);
    assert.ok(filtered.every(point => point.x >= 0 && point.x <= 320 && point.y >= 0 && point.y <= 150));
  }
});

test('small round loops keep their winding, dimensions and most enclosed area', () => {
  const radius = 3;
  const raw = Array.from({ length: 121 }, (_, i) => { const theta = i * 2 * Math.PI / 120; return { x: radius * Math.cos(theta), y: radius * Math.sin(theta), pressure: .5, t: i * 500 / 120 }; });
  for (const mode of ['light', 'natural', 'strong'] as const) {
    const filtered = process(raw, mode);
    const ratio = area(filtered) / area(raw);
    assert.ok(ratio > .55 && ratio < 1.02, `${mode} loop area retained ${(ratio * 100).toFixed(1)}%`);
    assert.ok(Math.min(...filtered.map(p => p.x)) < -radius * .65);
    assert.ok(Math.min(...filtered.map(p => p.y)) < -radius * .65);
    assert.ok(Math.max(...filtered.map(p => p.y)) > radius * .65);
    let winding = 0;
    for (let i = 1; i < filtered.length; i++) {
      const a = Math.atan2(filtered[i - 1].y, filtered[i - 1].x), b = Math.atan2(filtered[i].y, filtered[i].x);
      winding += Math.atan2(Math.sin(b - a), Math.cos(b - a));
    }
    assert.ok(winding > 1.7 * Math.PI, `${mode} lost the loop's full turn`);
  }
});

test('crossing strokes retain both lobes instead of snapping to lines or a single oval', () => {
  const raw = Array.from({ length: 241 }, (_, i) => { const theta = i * 2 * Math.PI / 240; return { x: 7 * Math.sin(theta), y: 3 * Math.sin(theta * 2), pressure: .5, t: i * 800 / 240 }; });
  const filtered = process(raw);
  for (const section of [[0, 121], [120, 241]]) {
    const original = raw.slice(...section as [number, number]), result = filtered.slice(...section as [number, number]);
    assert.ok(area(result) > area(original) * .65);
  }
  assert.ok(Math.min(...filtered.map(p => p.x)) < -6 && Math.max(...filtered.map(p => p.x)) > 6);
  assert.ok(Math.min(...filtered.map(p => p.y)) < -2 && Math.max(...filtered.map(p => p.y)) > 2);
});

test('tiny two-sample dashes survive capture spacing and stationary pen-up cannot add a tail', () => {
  for (const mode of modes) {
    const filter = createStrokeStabilizer(mode);
    const start = filter.next({ x: 0, y: 0, pressure: .3, t: 0 });
    const end = filter.next({ x: .3, y: .1, pressure: .4, t: 8 });
    assert.ok(distance(start, end) > .15, `${mode} collapsed a tiny stroke into a dot`);
    const up = filter.next({ x: .3, y: .1, pressure: 0, t: 120 });
    assert.equal(up.x, end.x); assert.equal(up.y, end.y); assert.equal(up.t, 120); assert.equal(up.pressure, 0);
  }
});

test('coalesced event batching cannot change results or depend on wall-clock timing', () => {
  const raw = Array.from({ length: 80 }, (_, i) => ({ x: i * .9, y: 2 * Math.sin(i / 6), pressure: .3 + i / 160, t: i * 4.25 }));
  const expected = process(raw), filter = createStrokeStabilizer('natural'), batched: Point[] = [];
  for (let i = 0; i < raw.length; i += 7) for (const point of raw.slice(i, i + 7)) batched.push(filter.next(point));
  assert.deepEqual(batched, expected);
});

test('duplicate, missing, reversed and quantized timestamps remain finite and bounded', () => {
  const times = [0, 0, 0, 4, 4, 3, undefined, 5, 2000, 2000, 2000.001, 2008, NaN, Infinity, 2016];
  for (const mode of modes) {
    const raw = times.map((t, i) => ({ x: i * 2, y: Math.sin(i) * 3, pressure: .5, ...(t === undefined ? {} : { t }) }));
    const filtered = process(raw, mode);
    filtered.forEach((point, i) => {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.ok(distance(point, raw[i]) <= 3.000001);
      assert.equal(point.t, raw[i].t);
    });
  }
  const geometry = Array.from({ length: 40 }, (_, i) => ({ x: i * .8, y: Math.sin(i / 5), pressure: .5 }));
  const zeroClock = process(geometry.map(p => ({ ...p, t: 0 })));
  const realClock = process(geometry.map((p, i) => ({ ...p, t: i * 1000 / 120 })));
  zeroClock.forEach((point, i) => assert.ok(distance(point, realClock[i]) < 1e-9));
});

test('a time-based filter gives comparable traces at 60, 120 and 240 samples per second', () => {
  const sample = (hz: number): Point[] => process(Array.from({ length: hz * 2 + 1 }, (_, i) => { const t = i / hz; return { x: t * 100, y: 8 * Math.sin(t * 2 * Math.PI), pressure: .5, t: t * 1000 }; }));
  const slow = sample(60), medium = sample(120), fast = sample(240);
  const differences = slow.slice(15).flatMap((point, index) => [distance(point, medium[(index + 15) * 2]), distance(point, fast[(index + 15) * 4])]);
  assert.ok(Math.max(...differences) < .8, `Sampling-rate discrepancy ${Math.max(...differences)}`);
});

test('rotating a stroke rotates the stabilized result without favoring horizontal or vertical lines', () => {
  const theta = .83, cos = Math.cos(theta), sin = Math.sin(theta);
  const rotate = (point: Point): Point => ({ ...point, x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos });
  const raw = Array.from({ length: 100 }, (_, i) => ({ x: i / 3, y: 4 * Math.sin(i / 9), pressure: .5, t: i * 8 }));
  const a = process(raw).map(rotate), b = process(raw.map(rotate));
  a.forEach((point, i) => assert.ok(distance(point, b[i]) < 1e-9));
});
