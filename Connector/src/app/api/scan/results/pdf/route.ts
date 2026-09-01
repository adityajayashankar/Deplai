import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { renderScanReportPdf, scanReportFilename } from '@/lib/security/scan-report-pdf';
import type { ScanResultsPayload } from '@/features/security/types';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { error, user } = await requireAuth();
    if (error) return error;

    const projectId = request.nextUrl.searchParams.get('project_id');
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const { project, error: ownershipError } = await verifyProjectOwnership(user!.id, projectId, 'security.scan.read');
    if (ownershipError) return ownershipError;

    const response = await fetch(`${AGENTIC_URL}/api/scan/results/${projectId}`, {
      headers: agenticHeaders(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({ detail: 'Failed to fetch results' })) as { detail?: string; error?: string };
      return NextResponse.json(
        { error: detail.detail || detail.error || 'No scan report is available yet. Run a scan first.' },
        { status: response.status === 404 ? 404 : response.status },
      );
    }

    const payload = await response.json() as { data?: ScanResultsPayload };
    const data = payload.data;
    if (!data) {
      return NextResponse.json({ error: 'Scan results are empty. Run a scan first.' }, { status: 404 });
    }

    const projectName = String(project?.name || project?.full_name || projectId);
    const pdf = await renderScanReportPdf({
      projectName,
      projectId,
      data,
    });

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${scanReportFilename(projectName)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Scan report PDF error:', error);
    return NextResponse.json(
      { error: 'Failed to generate the security report PDF' },
      { status: 500 },
    );
  }
}
