/** Derive Nai selection ids from the current HRIS path. */

export function selectionFromPath(pathname: string): Record<string, string> {
  const path = pathname.split("?")[0] || "/";
  const out: Record<string, string> = {};

  const people = path.match(/^\/people\/([^/]+)/);
  if (people?.[1]) out.personId = decodeURIComponent(people[1]);

  const cycle = path.match(/^\/performance\/([^/]+)/);
  if (cycle?.[1] && cycle[1] !== "new") out.cycleId = decodeURIComponent(cycle[1]);

  const employment = path.match(/\/subject\/([^/]+)/);
  if (employment?.[1]) out.employmentId = decodeURIComponent(employment[1]);

  const memo = path.match(/^\/memos\/([^/]+)/);
  if (memo?.[1]) out.memoId = decodeURIComponent(memo[1]);

  const plan = path.match(/^\/plans\/([^/]+)/);
  if (plan?.[1]) out.planId = decodeURIComponent(plan[1]);

  const call = path.match(/^\/finance\/calls\/([^/]+)/);
  if (call?.[1] && call[1] !== "new") out.cashCallId = decodeURIComponent(call[1]);

  const account = path.match(/^\/finance\/accounts\/([^/]+)/);
  if (account?.[1] && account[1] !== "new") {
    out.accountId = decodeURIComponent(account[1]);
  }

  return out;
}
