// Normalizes an unknown thrown value to a human-readable string: the message when it's a
// real Error, otherwise its String() coercion. Extracted from the identical inline ternary
// that recurred across bundle/, pipeline/, and queue/ error-handling paths.
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
