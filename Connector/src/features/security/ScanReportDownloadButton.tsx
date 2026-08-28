'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

export function ScanReportDownloadButton({
  projectId,
  disabled = false,
}: {
  projectId: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onDownload = async () => {
    if (disabled || busy || !projectId) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/scan/results/pdf?project_id=${encodeURIComponent(projectId)}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || 'Could not generate the PDF report');
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = match?.[1] || 'deplai-security-report.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate the PDF report');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void onDownload()}
        disabled={disabled || busy}
        title={disabled ? 'Load scan results before downloading the report' : 'Download the security vulnerabilities report as PDF'}
        className="inline-flex items-center gap-2 border-[3px] border-black bg-white px-3 py-2 text-xs font-bold text-black shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        {busy ? 'Preparing PDF…' : 'Download PDF'}
      </button>
      {error ? <p className="max-w-56 text-right text-[11px] text-rose-400">{error}</p> : null}
    </div>
  );
}
