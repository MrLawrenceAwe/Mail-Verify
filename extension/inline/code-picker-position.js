export function calculatePickerPosition(
  rect,
  width,
  height,
  viewportWidth,
  viewportHeight,
  controlRects,
) {
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const clampLeft = (value) =>
    Math.max(8, Math.min(value, viewportWidth - width - 8));
  const clampTop = (value) =>
    Math.max(8, Math.min(value, viewportHeight - height - 8));
  const below = { left, top: rect.bottom + 4 };
  const above = { left, top: rect.top - height - 4 };
  const positions =
    below.top + height <= viewportHeight - 8 ? [below, above] : [above, below];
  positions.push(
    { left: rect.right + 4, top: rect.top },
    { left: rect.left - width - 4, top: rect.top },
  );
  const obstacles = [rect, ...controlRects];
  const overlap = (position) =>
    obstacles.reduce(
      (area, obstacle) =>
        area +
        Math.max(
          0,
          Math.min(position.left + width, obstacle.right) -
            Math.max(position.left, obstacle.left),
        ) *
          Math.max(
            0,
            Math.min(position.top + height, obstacle.bottom) -
              Math.max(position.top, obstacle.top),
          ),
      0,
    );
  let best,
    leastOverlap = Infinity;
  for (const position of positions) {
    const candidate = {
      left: clampLeft(position.left),
      top: clampTop(position.top),
    };
    const area = overlap(candidate);
    if (area < leastOverlap) {
      best = candidate;
      leastOverlap = area;
    }
    if (area === 0) break;
  }
  return best;
}
