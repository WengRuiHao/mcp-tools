export function textResult(payload: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError };
}

export function toolResult(result: { success: boolean; [key: string]: unknown }) {
  return textResult(result, result.success !== true);
}
