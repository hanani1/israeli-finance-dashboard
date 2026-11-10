/** Return provider-supplied transaction detail without inventing a recipient. */
export function transactionMemoText(memo: string | null | undefined): string | null {
  const trimmed = memo?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}
