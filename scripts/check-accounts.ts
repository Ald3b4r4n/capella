// Check of the Accounts section against a REAL opencode (2.x or 1.x), in a throwaway home with the API keys stripped: a
// DUMMY key is connected to one provider, it shows as a connection, nothing Capella returns contains the key, and it
// disappears when signed out. No real credential is used and no model is called. (On 2.x, a browser sign-in is started
// and cancelled at once: opencode contacts its console for a device code, and nothing is signed in.)
//
// Usage: node scripts/check-accounts.ts <opencode executable>
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeSession } from "../src/opencode/session.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/check-accounts.ts <opencode executable>");
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "capella-accounts-")));
const home = join(base, "home");
const project = join(base, "project");
mkdirSync(project);
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

const DUMMY = "DUMMY-NOT-A-REAL-KEY-Zq81xK";
const session = new OpencodeSession({ binary, workspaceRoot: project, env });
try {
  await session.start();
  console.log(`opencode ${session.version} (${session.generation})`);
  const before = await session.accounts();
  check("the providers are listed", before.length > 50, before.length);
  const target = before.find((a) => a.id === "anthropic" && a.key) ?? before.find((a) => a.key && a.connections.length === 0);
  if (!target) throw new Error("no provider to try with");
  console.log("provider used:", target.id);
  check("it starts not connected", target.connections.length === 0, target.connections);

  await session.connectKey(target.id, DUMMY, "Capella check");
  const after = (await session.accounts()).find((a) => a.id === target.id)!;
  check("after connecting a key it shows as connected", after.connections.length === 1 && after.connections[0]!.kind === "credential", after.connections);
  check("nothing Capella returns contains the key", !JSON.stringify(await session.accounts()).includes(DUMMY));

  await session.disconnect(target.id, after.connections[0]!.id);
  const gone = (await session.accounts()).find((a) => a.id === target.id)!;
  check("signing out removes it", gone.connections.length === 0, gone.connections);

  if (session.generation === "v2") {
    const oauthProvider = before.find((a) => a.id === "opencode" && a.oauth.length > 0);
    if (oauthProvider) {
      const method = oauthProvider.oauth[0]!;
      const answers = Object.fromEntries(method.form.filter((f) => f.hidden && f.default !== undefined).map((f) => [f.key, f.default!]));
      const attempt = await session.oauthStart(oauthProvider.id, method.id, answers);
      check("a browser sign-in gives an https address and instructions", /^https:\/\//.test(attempt.url) && attempt.instructions !== "", { url: new URL(attempt.url).origin, mode: attempt.mode });
      check("it is pending until the user signs in", (await session.oauthStatus(oauthProvider.id, attempt.attemptId)).status === "pending");
      await session.oauthCancel(oauthProvider.id, attempt.attemptId);
      check("cancelling it ends it", (await session.oauthStatus(oauthProvider.id, attempt.attemptId).catch(() => ({ status: "gone" }))).status !== "pending");
    }
  } else {
    await session.oauthStart("opencode", "x", {}).then(
      () => check("1.x says to use the terminal for a browser sign-in", false),
      (e) => check("1.x says to use the terminal for a browser sign-in", /opencode auth login/.test(String(e))),
    );
  }
} finally {
  await session.dispose();
  rmSync(base, { recursive: true, force: true });
}
console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
