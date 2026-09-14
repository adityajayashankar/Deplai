import assert from 'node:assert/strict';
import { listUsers, getUserDetail } from '../src/lib/platform/users';
import { getOrganizationDetail } from '../src/lib/platform/organizations-admin';
import { resetDbPool } from '../src/lib/db';

// Read-only smoke check; do not print personal account data.
async function main() {
  try {
    const page = await listUsers({ limit: 2 });
    if (page.users[0]) {
      const detail = await getUserDetail(page.users[0].id);
      assert.ok(detail);
      if (detail.organizations[0]) assert.ok(await getOrganizationDetail(detail.organizations[0].id));
    }
    if (page.total > 1) {
      const second = await listUsers({ limit: 1, offset: 1 });
      assert.equal(second.users[0].id, page.users[1].id);
    }
    console.log(`Directory check passed: ${page.total} accounts; profile and pagination reads checked where available.`);
  } finally {
    await resetDbPool();
  }
}
main().catch(() => { console.error('Directory check failed; inspect schema and database connectivity.'); process.exitCode = 1; });
