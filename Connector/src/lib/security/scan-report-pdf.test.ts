import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectReportFindings, renderScanReportPdf, scanReportFilename } from './scan-report-pdf';

describe('scan report pdf', () => {
  it('prefers unified findings when present', () => {
    const findings = collectReportFindings({
      findings: [
        { id: '1', category: 'sast', severity: 'high', title: 'XSS', asset: 'app.ts', location: 'app.ts:12' },
      ],
      supply_chain: [{ name: 'lodash', cve_id: 'CVE-1' }],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, 'XSS');
  });

  it('expands legacy code and supply-chain findings', () => {
    const findings = collectReportFindings({
      supply_chain: [
        { name: 'lodash', version: '4.17.20', cve_id: 'CVE-2021-23337', severity: 'high' },
      ],
      code_security: [
        {
          cwe_id: 'CWE-79',
          title: 'Cross-site scripting',
          severity: 'medium',
          occurrences: [{ filename: 'app.js', line_number: 12, code_extract: 'innerHTML' }],
        },
      ],
    });
    assert.equal(findings.length, 2);
    assert.ok(findings.some((item) => item.category === 'sca' && item.title.includes('CVE-2021-23337')));
    assert.ok(findings.some((item) => item.category === 'sast' && item.location === 'app.js:12'));
  });

  it('builds a safe download filename', () => {
    assert.equal(
      scanReportFilename('My App! v2', new Date('2026-08-26T00:00:00.000Z')),
      'deplai-security-report-My-App-v2-2026-08-26.pdf',
    );
  });

  it('renders a PDF document', async () => {
    const pdf = await renderScanReportPdf({
      projectName: 'demo-app',
      projectId: 'proj-1',
      generatedAt: new Date('2026-08-26T00:00:00.000Z'),
      data: {
        findings: [
          { id: '1', category: 'sast', severity: 'critical', title: 'SQL injection', asset: 'db.ts', location: 'db.ts:9' },
        ],
        posture: { critical: 1, high: 0, medium: 0, low: 0, total: 1 },
        modules: [{ id: 'sast', status: 'COMPLETED', finding_count: 1 }],
      },
    });
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.ok(pdf.length > 500);
  });
});
