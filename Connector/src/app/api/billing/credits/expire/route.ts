import { NextRequest, NextResponse } from 'next/server';
import { requireServiceKey } from '@/lib/auth';
import {
  provisionDueOrganizationCreditReleases,
  releaseAbandonedOrganizationCreditReservations,
} from '@/lib/billing/organization-credits';

export async function POST(request: NextRequest) {
  const denied = requireServiceKey(request);
  if (denied) return denied;

  const [releasedAnnualGrants, releasedReservations] = await Promise.all([
    provisionDueOrganizationCreditReleases(),
    releaseAbandonedOrganizationCreditReservations(),
  ]);
  return NextResponse.json({ releasedAnnualGrants, releasedReservations });
}
