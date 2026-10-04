import { getPlayerColor, type LobbyMember } from "@numeral-lord/game-core";

type LobbyPreviewMember = Pick<LobbyMember, "participating" | "seat" | "playerColorId">;

/** Map each participating lobby member's selected swatch onto its map seat. */
export function getLobbyPreviewPlayerColors(
  members: readonly LobbyPreviewMember[]
): Readonly<Record<string, string>> {
  const entries = members.flatMap((member) => {
    if (!member.participating || member.seat === null) return [];
    const color = getPlayerColor(member.playerColorId);
    return color ? [[`player-${member.seat}`, color] as const] : [];
  });
  return Object.fromEntries(entries);
}
