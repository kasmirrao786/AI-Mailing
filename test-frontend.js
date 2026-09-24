const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:3000";
const errors = [];

async function run() {
  // Log in with a throwaway test account, creating it via signup if it doesn't exist yet —
  // this harness should be runnable against a fresh database with no manual setup.
  const testEmail = "frontend-test@example.com";
  const testPassword = "frontend-test-pass-123";
  let loginRes = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword })
  });
  if (!loginRes.ok) {
    const signupRes = await fetch(`${BASE}/api/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, password: testPassword })
    });
    if (!signupRes.ok) throw new Error("Could not log in or sign up the frontend-test account — is the server running against DATABASE_URL?");
    loginRes = signupRes;
  }
  const cookie = loginRes.headers.get("set-cookie");

  // 2. Fetch the real index.html and set up jsdom with a fetch that carries the cookie
  const indexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  const dom = new JSDOM(indexHtml, {
    url: BASE + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true
  });

  dom.window.fetch = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { Cookie: cookie });
    return fetch(url.startsWith("http") ? url : BASE + url, opts);
  };
  dom.window.onerror = (msg, src, line, col, err) => {
    errors.push(`window.onerror: ${msg} (${src}:${line}:${col})`);
  };
  dom.window.confirm = () => true; // auto-confirm any delete dialogs during the walk

  const virtualConsole = dom.window.document.defaultView;
  dom.window.addEventListener("error", (e) => {
    errors.push(`uncaught: ${e.error ? e.error.stack : e.message}`);
  });

  // 3. Manually load the real app.js and views.js into this jsdom window (avoids relying
  // on jsdom's own script-tag fetching, which can be flaky over a real HTTP connection).
  const appJs = fs.readFileSync(path.join(__dirname, "public", "app.js"), "utf8");
  const viewsJs = fs.readFileSync(path.join(__dirname, "public", "views.js"), "utf8");
  // Concatenated into one eval so top-level `const`/`let` bindings are shared, matching
  // how two sequential <script src> tags in a real document share top-level scope.
  dom.window.eval(appJs + "\n" + viewsJs);

  // 4. Fire DOMContentLoaded to kick off the app's own bootstrap (renderNav + navigate)
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true, cancelable: true }));
  await sleep(400);

  const routes = ["dashboard", "contacts", "clientTypes", "assets", "sequences", "campaigns", "sendJobs", "mailboxes", "settings"];
  for (const route of routes) {
    try {
      await dom.window.navigate(route);
      await sleep(300);
      const content = dom.window.document.getElementById("content").innerHTML;
      if (!content || content.trim().length === 0) {
        errors.push(`Route "${route}" rendered empty content.`);
      }
      console.log(`✓ ${route} rendered (${content.length} chars)`);
    } catch (e) {
      errors.push(`Route "${route}" threw: ${e.stack || e.message}`);
    }
  }

  // 5. Exercise a couple of interactive flows: open a modal, check it actually has fields
  try {
    await dom.window.navigate("mailboxes");
    await sleep(200);
    const addBtn = dom.window.document.getElementById("addMailboxBtn");
    if (!addBtn) throw new Error("addMailboxBtn not found on mailboxes view");
    addBtn.click();
    await sleep(200);
    const modalHasLabelField = !!dom.window.document.getElementById("f_label");
    if (!modalHasLabelField) errors.push("Add-mailbox modal did not render expected fields.");
    else console.log("✓ Add-mailbox modal opens and renders fields");
    dom.window.closeModal();
  } catch (e) {
    errors.push(`Mailbox modal flow threw: ${e.stack || e.message}`);
  }

  try {
    await dom.window.navigate("clientTypes");
    await sleep(200);
    const addBtn = dom.window.document.getElementById("addCtBtn");
    if (!addBtn) throw new Error("addCtBtn not found on clientTypes view");
    addBtn.click();
    await sleep(200);
    const hasNameField = !!dom.window.document.getElementById("f_name");
    if (!hasNameField) errors.push("Add-client-type modal did not render expected fields.");
    else console.log("✓ Add-client-type modal opens and renders fields");
    dom.window.closeModal();
  } catch (e) {
    errors.push(`Client type modal flow threw: ${e.stack || e.message}`);
  }

  try {
    await dom.window.navigate("campaigns");
    await sleep(200);
    const camps = await (await fetch(`${BASE}/api/campaigns`, { headers: { Cookie: cookie } })).json();
    if (camps.campaigns.length) {
      const openLink = dom.window.document.querySelector("[data-open]");
      if (!openLink) throw new Error("No campaign open-link rendered despite campaigns existing.");
      openLink.click();
      await sleep(400);
      const modalTitle = dom.window.document.querySelector(".modal h2");
      if (!modalTitle) errors.push("Campaign detail modal did not open.");
      else console.log(`✓ Campaign detail modal opens (${modalTitle.textContent})`);
      dom.window.closeModal();
    } else {
      console.log("(no campaigns to test detail view against)");
    }
  } catch (e) {
    errors.push(`Campaign detail flow threw: ${e.stack || e.message}`);
  }

  console.log("\n--- RESULT ---");
  if (errors.length) {
    console.log(`${errors.length} error(s) found:`);
    errors.forEach(e => console.log(" - " + e));
    process.exit(1);
  } else {
    console.log("No runtime errors across all routes and tested interactions.");
    process.exit(0);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

run().catch(e => { console.error("Harness itself failed:", e); process.exit(1); });
