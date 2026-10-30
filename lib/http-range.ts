/**
 * Single-range `bytes=a-b` support for file APIs (media seeking).
 *
 * Returns null for absent / multi-range / unsatisfiable headers so the caller
 * serves the whole body — the same "best effort" contract the local /api/files
 * stream uses.
 */
export function sliceByteRange(bytes: Buffer, header: string | null): { body: Buffer; contentRange: string } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const size = bytes.length;
  let start = m[1] ? Number(m[1]) : NaN;
  let end = m[2] ? Number(m[2]) : NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // suffix range: last N bytes
    const suffix = end;
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) {
    return null;
  }
  end = Math.min(end, size - 1);
  return { body: bytes.subarray(start, end + 1), contentRange: `bytes ${start}-${end}/${size}` };
}
