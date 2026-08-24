export function textResult(payload: unknown, isError = false) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { content: [{ type: "text" as const, text }], isError };
}
