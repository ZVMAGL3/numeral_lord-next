/** Remove the direct-join marker while preserving unrelated URL state. */
export function withoutRoomInvite<T extends Record<string, unknown>>(query: T): Omit<T, "room"> {
  const { room: _room, ...remainingQuery } = query;
  return remainingQuery;
}
