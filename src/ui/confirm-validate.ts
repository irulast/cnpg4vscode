/**
 * Pure validation helpers for the typed-name destructive-confirmation modal
 * (US5; FR-024, SC-009). Kept separate from confirm.ts so unit tests can
 * import without pulling in the VS Code runtime.
 */

export function validateTypedName(
  input: string,
  expectedFullyQualifiedName: string,
): string | null {
  if (input.trim().length === 0) {
    return `Type the fully-qualified name (${expectedFullyQualifiedName}) to confirm.`;
  }
  if (input !== expectedFullyQualifiedName) {
    return `Name does not match. Type "${expectedFullyQualifiedName}" exactly.`;
  }
  return null;
}

export function formatConfirmationPrompt(
  operation: string,
  expectedFullyQualifiedName: string,
): string {
  return (
    `Confirm ${operation} on ${expectedFullyQualifiedName}.\n\n` +
    `Type the fully-qualified name to proceed.`
  );
}
