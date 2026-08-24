export function jsonResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data),
      },
    ],
    ...(isError ? { isError: true as const } : {}),
  };
}

export function invalidGitDirResult(absGitDir: string) {
  return jsonResult({ error: `提供的目錄不是有效的 git 版控目錄: ${absGitDir}` }, true);
}
