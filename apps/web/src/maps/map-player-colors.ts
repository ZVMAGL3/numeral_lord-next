/** Change a seat's color and swap with the first seat already using it. */
export function changeSeatColor(colors: readonly string[], seatIndex: number, selectedColor: string): string[] {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= colors.length || !/^#[0-9a-fA-F]{6}$/.test(selectedColor)) {
    return [...colors];
  }
  const next = colors.map((color) => color.toUpperCase());
  const previousColor = next[seatIndex]!;
  const normalizedColor = selectedColor.toUpperCase();
  if (previousColor === normalizedColor) return next;

  const occupiedSeatIndex = next.findIndex((color, index) => index !== seatIndex && color === normalizedColor);
  next[seatIndex] = normalizedColor;
  if (occupiedSeatIndex >= 0) next[occupiedSeatIndex] = previousColor;
  return next;
}
