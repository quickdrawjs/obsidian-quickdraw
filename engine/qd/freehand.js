// The pencil's ink: turns a raw pointer trail into a filled outline whose
// width breathes with pressure (real from a pen, simulated from speed for
// anything else). The stroke model is perfect-freehand's, ported to plain JS
// below under its MIT license; inkOptions holds Quickdraw's own settings.
// Dependency-free ESM (see palette.js).
//
// perfect-freehand 1.2.3 — https://github.com/steveruizok/perfect-freehand
// MIT License
//
// Copyright (c) 2021 Stephen Ruiz Ltd
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// input: flat [x, y, pressure, ...] triplets (pressure 0..1)
// output: flat [x, y, ...] closed outline polygon

const { PI, min } = Math

// ---- Quickdraw's settings ----------------------------------------------------

const easeOutSine = (t) => Math.sin((t * PI) / 2)

/**
 * The ink's settings for a stroke `width` wide: a pen's own pressure drives
 * the width, anything else simulates it from speed (fast = thin). Round caps
 * at both ends, no taper: a tip is as full as the line it ends. `done` marks
 * a finished stroke, which then reaches exactly to its last point.
 */
export function inkOptions(width, { isPen = false, done = false } = {}) {
  if (isPen) {
    return { size: width * 1.2, thinning: 0.6, smoothing: 0.6, streamline: 0.6, simulatePressure: false, easing: easeOutSine, last: done }
  }
  return { size: width, thinning: 0.5, smoothing: 0.6, streamline: 0.6, simulatePressure: true, easing: easeOutSine, last: done }
}

/** The stroke's outline polygon, flat [x, y, ...] (perfect-freehand's getStroke). */
export function strokeOutline(pts, options = {}) {
  const n = Math.floor(pts.length / 3)
  if (n === 0) return []
  const input = new Array(n)
  for (let i = 0; i < n; i++) input[i] = [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]]
  const outline = getStrokeOutlinePoints(getStrokePoints(input, options), options)
  const out = new Array(outline.length * 2)
  for (let i = 0; i < outline.length; i++) {
    out[i * 2] = outline[i][0]
    out[i * 2 + 1] = outline[i][1]
  }
  return out
}

// ---- perfect-freehand (MIT, see above) ---------------------------------------

const RATE_OF_PRESSURE_CHANGE = 0.275
const FIXED_PI = PI + 0.0001
const START_CAP_SEGMENTS = 13
const END_CAP_SEGMENTS = 29
const CORNER_CAP_SEGMENTS = 13
const END_NOISE_THRESHOLD = 3
const MIN_STREAMLINE_T = 0.15
const STREAMLINE_T_RANGE = 0.85
const MIN_RADIUS = 0.01
const DEFAULT_FIRST_PRESSURE = 0.25
const DEFAULT_PRESSURE = 0.5
const UNIT_OFFSET = [1, 1]

const getStrokeRadius = (size, thinning, pressure, easing = (t) => t) =>
  size * easing(0.5 - thinning * (0.5 - pressure))

function simulatePressure(prevPressure, distance, size) {
  const sp = min(1, distance / size)
  const rp = min(1, 1 - sp)
  return min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE))
}

const neg = (a) => [-a[0], -a[1]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const mul = (a, n) => [a[0] * n, a[1] * n]
const per = (a) => [a[1], -a[0]]
const dpr = (a, b) => a[0] * b[0] + a[1] * b[1]
const isEqual = (a, b) => a[0] === b[0] && a[1] === b[1]
const len = (a) => Math.hypot(a[0], a[1])
const uni = (a) => { const l = len(a); return l === 0 ? [0, 0] : [a[0] / l, a[1] / l] }
const dist = (a, b) => Math.hypot(a[1] - b[1], a[0] - b[0])
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
const lrp = (a, b, t) => add(a, mul(sub(b, a), t))
const prj = (a, b, c) => add(a, mul(b, c))
function rotAround(a, c, r) {
  const s = Math.sin(r), co = Math.cos(r)
  const px = a[0] - c[0], py = a[1] - c[1]
  return [px * co - py * s + c[0], px * s + py * co + c[1]]
}

const isValidPressure = (p) => p != null && p >= 0

function getStrokePoints(points, options = {}) {
  const { streamline = 0.5, size = 16, last: isComplete = false } = options
  if (points.length === 0) return []
  const t = MIN_STREAMLINE_T + (1 - streamline) * STREAMLINE_T_RANGE
  let pts = points

  // extra points between just two, to avoid "dash" lines
  if (pts.length === 2) {
    const last = pts[1]
    pts = pts.slice(0, -1)
    for (let i = 1; i < 5; i++) pts.push(lrp(pts[0], last, i / 4))
  }
  // a lone point gets a second one, a unit away
  if (pts.length === 1) pts = [...pts, [...add(pts[0], UNIT_OFFSET), ...pts[0].slice(2)]]

  const strokePoints = [{
    point: [pts[0][0], pts[0][1]],
    pressure: isValidPressure(pts[0][2]) ? pts[0][2] : DEFAULT_FIRST_PRESSURE,
    vector: [...UNIT_OFFSET],
    distance: 0,
    runningLength: 0,
  }]
  let hasReachedMinimumLength = false
  let runningLength = 0
  let prev = strokePoints[0]
  const max = pts.length - 1

  for (let i = 1; i < pts.length; i++) {
    const point = isComplete && i === max ? [pts[i][0], pts[i][1]] : lrp(prev.point, pts[i], t)
    if (isEqual(prev.point, point)) continue
    const distance = dist(point, prev.point)
    runningLength += distance
    // wait until the line is a little way from its start, to avoid noise
    if (i < max && !hasReachedMinimumLength) {
      if (runningLength < size) continue
      hasReachedMinimumLength = true
    }
    prev = {
      point,
      pressure: isValidPressure(pts[i][2]) ? pts[i][2] : DEFAULT_PRESSURE,
      vector: uni(sub(prev.point, point)),
      distance,
      runningLength,
    }
    strokePoints.push(prev)
  }
  strokePoints[0].vector = strokePoints[1]?.vector || [0, 0]
  return strokePoints
}

function computeTaperDistance(taper, size, totalLength) {
  if (taper === false || taper === undefined) return 0
  if (taper === true) return Math.max(size, totalLength)
  return taper
}

function getStrokeOutlinePoints(points, options = {}) {
  const {
    size = 16,
    smoothing = 0.5,
    thinning = 0.5,
    simulatePressure: shouldSimulatePressure = true,
    easing = (t) => t,
    start = {},
    end = {},
    last: isComplete = false,
  } = options
  const { cap: capStart = true, easing: taperStartEase = (t) => t * (2 - t) } = start
  const { cap: capEnd = true, easing: taperEndEase = (t) => --t * t * t + 1 } = end

  if (points.length === 0 || size <= 0) return []

  const totalLength = points[points.length - 1].runningLength
  const taperStart = computeTaperDistance(start.taper, size, totalLength)
  const taperEnd = computeTaperDistance(end.taper, size, totalLength)
  const minDistance = Math.pow(size * smoothing, 2)
  const leftPts = []
  const rightPts = []

  // the first few points' average pressure: lines almost always start slow
  let prevPressure = points.slice(0, 10).reduce((acc, curr) => {
    let pressure = curr.pressure
    if (shouldSimulatePressure) pressure = simulatePressure(acc, curr.distance, size)
    return (acc + pressure) / 2
  }, points[0].pressure)

  let radius = getStrokeRadius(size, thinning, points[points.length - 1].pressure, easing)
  let firstRadius
  let prevVector = points[0].vector
  let prevLeftPoint = points[0].point
  let prevRightPoint = prevLeftPoint
  let tempLeftPoint = prevLeftPoint
  let tempRightPoint = prevRightPoint
  let isPrevPointSharpCorner = false

  for (let i = 0; i < points.length; i++) {
    let { pressure } = points[i]
    const { point, vector, distance, runningLength } = points[i]
    const isLastPoint = i === points.length - 1

    // noise at the end of the line
    if (!isLastPoint && totalLength - runningLength < END_NOISE_THRESHOLD) continue

    if (thinning) {
      if (shouldSimulatePressure) pressure = simulatePressure(prevPressure, distance, size)
      radius = getStrokeRadius(size, thinning, pressure, easing)
    } else {
      radius = size / 2
    }
    if (firstRadius === undefined) firstRadius = radius

    const taperStartStrength = runningLength < taperStart ? taperStartEase(runningLength / taperStart) : 1
    const taperEndStrength = totalLength - runningLength < taperEnd ? taperEndEase((totalLength - runningLength) / taperEnd) : 1
    radius = Math.max(MIN_RADIUS, radius * Math.min(taperStartStrength, taperEndStrength))

    const nextVector = (!isLastPoint ? points[i + 1] : points[i]).vector
    const nextDpr = !isLastPoint ? dpr(vector, nextVector) : 1.0
    const prevDpr = dpr(vector, prevVector)
    const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner
    const isNextPointSharpCorner = nextDpr !== null && nextDpr < 0

    if (isPointSharpCorner || isNextPointSharpCorner) {
      // a sharp corner: round it, and move on
      const offset = mul(per(prevVector), radius)
      const step = 1 / CORNER_CAP_SEGMENTS
      for (let t = 0; t <= 1; t += step) {
        tempLeftPoint = rotAround(sub(point, offset), point, FIXED_PI * t)
        leftPts.push(tempLeftPoint)
        tempRightPoint = rotAround(add(point, offset), point, FIXED_PI * -t)
        rightPts.push(tempRightPoint)
      }
      prevLeftPoint = tempLeftPoint
      prevRightPoint = tempRightPoint
      if (isNextPointSharpCorner) isPrevPointSharpCorner = true
      continue
    }
    isPrevPointSharpCorner = false

    if (isLastPoint) {
      const offset = mul(per(vector), radius)
      leftPts.push(sub(point, offset))
      rightPts.push(add(point, offset))
      continue
    }

    // regular points, one radius to each side
    const offset = mul(per(lrp(nextVector, vector, nextDpr)), radius)
    tempLeftPoint = sub(point, offset)
    if (i <= 1 || dist2(prevLeftPoint, tempLeftPoint) > minDistance) {
      leftPts.push(tempLeftPoint)
      prevLeftPoint = tempLeftPoint
    }
    tempRightPoint = add(point, offset)
    if (i <= 1 || dist2(prevRightPoint, tempRightPoint) > minDistance) {
      rightPts.push(tempRightPoint)
      prevRightPoint = tempRightPoint
    }
    prevPressure = pressure
    prevVector = vector
  }

  const firstPoint = [points[0].point[0], points[0].point[1]]
  const lastPoint = points.length > 1
    ? [points[points.length - 1].point[0], points[points.length - 1].point[1]]
    : add(points[0].point, [1, 1])
  const startCap = []
  const endCap = []

  if (points.length === 1) {
    if (!(taperStart || taperEnd) || isComplete) return drawDot(firstPoint, firstRadius || radius)
  } else {
    if (taperStart || (taperEnd && points.length === 1)) {
      // tapered start: no cap
    } else if (capStart) {
      const step = 1 / START_CAP_SEGMENTS
      for (let t = step; t <= 1; t += step) startCap.push(rotAround(rightPts[0], firstPoint, FIXED_PI * t))
    } else {
      const corners = sub(leftPts[0], rightPts[0])
      const a = mul(corners, 0.5), b = mul(corners, 0.51)
      startCap.push(sub(firstPoint, a), sub(firstPoint, b), add(firstPoint, b), add(firstPoint, a))
    }

    const direction = per(neg(points[points.length - 1].vector))
    if (taperEnd || (taperStart && points.length === 1)) {
      endCap.push(lastPoint)
    } else if (capEnd) {
      const s = prj(lastPoint, direction, radius)
      const step = 1 / END_CAP_SEGMENTS
      for (let t = step; t < 1; t += step) endCap.push(rotAround(s, lastPoint, FIXED_PI * 3 * t))
    } else {
      endCap.push(
        add(lastPoint, mul(direction, radius)),
        add(lastPoint, mul(direction, radius * 0.99)),
        sub(lastPoint, mul(direction, radius * 0.99)),
        sub(lastPoint, mul(direction, radius)),
      )
    }
  }
  return leftPts.concat(endCap, rightPts.reverse(), startCap)
}

function drawDot(center, radius) {
  const start = prj(center, uni(per(sub(center, add(center, [1, 1])))), -radius)
  const out = []
  const step = 1 / START_CAP_SEGMENTS
  for (let t = step; t <= 1; t += step) out.push(rotAround(start, center, FIXED_PI * 2 * t))
  return out
}
