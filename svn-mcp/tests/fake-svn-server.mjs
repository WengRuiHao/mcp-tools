// 測試用的假 SVN 上層網址：回傳 Apache SVNParentPath 風格的 repo 索引 XML，並可要求 Basic 驗證。
import http from "node:http";

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * @param {{ repos: string[], users?: Record<string, string> | null }} options
 *   users 有值就要求 Basic 驗證（帳號 → 密碼，帳號不分大小寫比對）；沒帶或密碼錯回 401。
 * @returns {Promise<{ url: string, port: number, requests: string[], close: () => Promise<void> }>}
 */
export async function startFakeSvnServer({ repos, users = null }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers.authorization ? "auth" : "anon");
    if (users) {
      const header = req.headers.authorization ?? "";
      const [name, ...rest] = Buffer.from(header.replace(/^Basic\s+/i, ""), "base64").toString("utf-8").split(":");
      const expected = Object.entries(users).find(([u]) => u.toLowerCase() === (name ?? "").toLowerCase())?.[1];
      if (!header.startsWith("Basic") || expected === undefined || expected !== rest.join(":")) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="svn"' });
        res.end("unauthorized");
        return;
      }
    }
    const dirs = repos.map((r) => `    <dir name="${escapeXml(r)}" href="${encodeURIComponent(r)}/" />`).join("\n");
    const body = `<?xml version="1.0"?>\n<svn version="1.10.6" href="http://subversion.apache.org/">\n  <index rev="0" path="Collection of Repositories">\n${dirs}\n  </index>\n</svn>\n`;
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/svn`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
