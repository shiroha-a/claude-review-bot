// Creates the GitHub App through the manifest flow and writes its credentials to .env.
// Usage: node scripts/create-app.mjs --base-url https://review-bot.example.com --name my-review-bot [--port 8787]
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    name: { type: "string" },
    port: { type: "string", default: "8787" },
    repo: { type: "string", default: "https://github.com/shiroha-a/claude-review-bot" },
  },
});
if (!values["base-url"] || !values.name) {
  console.error("--base-url and --name are required");
  process.exit(1);
}
const baseUrl = values["base-url"].replace(/\/$/, "");
// 公開URL上で一時的に動くため、推測できないパスとstateで第三者の呼び出しを弾く
const token = randomBytes(16).toString("hex");
const setupPath = `/setup/${token}`;

const manifest = {
  name: values.name,
  url: values.repo,
  hook_attributes: { url: `${baseUrl}/api/github/webhooks`, active: true },
  redirect_url: `${baseUrl}${setupPath}/callback`,
  public: false,
  default_permissions: {
    pull_requests: "write",
    contents: "read",
    issues: "read",
    metadata: "read",
  },
  default_events: ["pull_request", "issue_comment"],
};

const escapeHtml = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function page(body) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App setup</title></head><body style="font-family:sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem">${body}</body></html>`;
}

function writeEnv(app) {
  const source = existsSync(".env") ? ".env" : ".env.example";
  const lines = readFileSync(source, "utf8").split("\n");
  const updates = {
    GITHUB_APP_ID: String(app.id),
    GITHUB_PRIVATE_KEY: `"${app.pem.trim().replace(/\n/g, "\\n")}"`,
    GITHUB_WEBHOOK_SECRET: app.webhook_secret,
  };
  const seen = new Set();
  const out = lines.map((line) => {
    const key = line.split("=", 1)[0];
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  writeFileSync(".env", out.join("\n"), { mode: 0o600 });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", baseUrl);
  if (url.pathname === setupPath) {
    const action = `https://github.com/settings/apps/new?state=${token}`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      page(`<h1>${escapeHtml(values.name)}</h1>
<p>下のボタンでGitHubのApp作成画面へ進み、「Create GitHub App」を押してください。</p>
<form action="${action}" method="post">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit" style="font-size:1.2rem;padding:.5rem 1rem">GitHub Appを作成</button>
</form>
<details><summary>manifest</summary><pre>${escapeHtml(JSON.stringify(manifest, null, 2))}</pre></details>`),
    );
    return;
  }
  if (url.pathname === `${setupPath}/callback`) {
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.get("state") !== token) {
      res.writeHead(400).end("invalid callback");
      return;
    }
    const r = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: { accept: "application/vnd.github+json" },
      },
    );
    if (!r.ok) {
      const text = await r.text();
      console.error(`conversion failed: ${r.status} ${text}`);
      res.writeHead(502).end(`conversion failed: ${r.status}`);
      return;
    }
    const app = await r.json();
    writeEnv(app);
    console.log(`created app id=${app.id} slug=${app.slug} -> .env updated`);
    const install = `${app.html_url}/installations/new`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      page(`<h1>作成しました</h1>
<p>App: <a href="${escapeHtml(app.html_url)}">${escapeHtml(app.slug)}</a>(ID ${app.id})</p>
<p>認証情報はサーバーの<code>.env</code>に保存しました。</p>
<p><a href="${escapeHtml(install)}" style="font-size:1.2rem">次へ: リポジトリにインストール</a></p>`),
    );
    setTimeout(() => server.close(() => process.exit(0)), 500);
    return;
  }
  res.writeHead(404).end();
});

server.listen(Number(values.port), () => {
  console.log(`open: ${baseUrl}${setupPath}`);
});
