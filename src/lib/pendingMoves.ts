// lib/pendingMoves.ts
const pendingMoves = new Map<string, string>();
// key: aeTitle, value: hospitalId

export const registerPendingMove = (aeTitle: string, hospitalId: string) => {
  pendingMoves.set(aeTitle, hospitalId);
};

export const resolveHospitalFromPendingMove = (aeTitle: string): string | null => {
  return pendingMoves.get(aeTitle) ?? null;
};

export const clearPendingMove = (aeTitle: string) => {
  pendingMoves.delete(aeTitle);
};
