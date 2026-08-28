import PDFDocument from 'pdfkit';
import { uniqueFindingIds } from '../../features/security/normalize';
import { PHASE1_MODULES, type ScanResultsPayload, type UnifiedFinding } from '../../features/security/types';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
const PAGE_MARGIN = 48;

function bufferPdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function severityRank(value: string): number {
  const index = SEVERITY_ORDER.indexOf(value.toLowerCase() as (typeof SEVERITY_ORDER)[number]);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function truncate(value: string, max = 220): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function scanReportFilename(projectName: string, generatedAt = new Date()): string {
  const slug = projectName
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project';
  const date = generatedAt.toISOString().slice(0, 10);
  return `deplai-security-report-${slug}-${date}.pdf`;
}

function fromLegacyItem(item: Record<string, unknown>, category: string, index: number): UnifiedFinding[] {
  const occurrences = Array.isArray(item.occurrences) ? item.occurrences.filter(isRecord) : [];
  const title = asText(item.title || item.cwe_id || item.cve_id || item.name || item.check_id, 'Finding');
  const severity = asText(item.severity, 'medium');
  const name = asText(item.name || item.file || item.asset || item.filename);
  if (occurrences.length > 0) {
    return occurrences.map((occurrence, occIndex) => {
      const filename = asText(occurrence.filename, name || 'unknown');
      const lineNumber = asText(occurrence.line_number, '0');
      const location = `${filename}:${lineNumber}`;
      return {
        id: asText(item.id, `${category}:${title}:${location}:${occIndex}`),
        category,
        severity,
        title,
        asset: filename,
        location,
        status: asText(item.status, 'open'),
        metadata: {
          cwe_id: item.cwe_id,
          cve_id: item.cve_id,
          code_extract: occurrence.code_extract,
        },
      };
    });
  }
  const version = asText(item.version);
  const filePath = asText(item.file || item.filename, name);
  const lineNumber = asText(item.line_number);
  const location = asText(
    item.location,
    version ? `${name}@${version}` : lineNumber ? `${filePath}:${lineNumber}` : filePath || name,
  );
  return [{
    id: asText(item.id || item.cve_id, `${category}-${index}`),
    category,
    severity,
    title: item.cve_id ? `${asText(item.cve_id)} in ${name || 'dependency'}` : title,
    asset: name || filePath,
    location,
    status: asText(item.status, 'open'),
    scanner: asText(item.scanner) || undefined,
    evidence_source: asText(item.evidence_source) || undefined,
    metadata: isRecord(item.metadata) ? item.metadata : item,
  }];
}

export function collectReportFindings(data: ScanResultsPayload | null | undefined): UnifiedFinding[] {
  if (Array.isArray(data?.findings) && data.findings.length > 0) {
    return uniqueFindingIds(data.findings);
  }
  const buckets: Array<[string, unknown[] | undefined]> = [
    ['sast', data?.code_security],
    ['sca', data?.supply_chain],
    ['secrets', data?.secrets],
    ['iac', data?.iac],
    ['containers', data?.containers],
    ['kubernetes', data?.kubernetes],
    ['cicd', data?.cicd],
    ['api', data?.api],
    ['dast', data?.dast],
  ];
  const findings: UnifiedFinding[] = [];
  for (const [category, items] of buckets) {
    if (!Array.isArray(items)) continue;
    items.forEach((item, index) => {
      if (isRecord(item)) findings.push(...fromLegacyItem(item, category, index));
    });
  }
  return uniqueFindingIds(findings);
}

function postureFrom(data: ScanResultsPayload, findings: UnifiedFinding[]) {
  if (data.posture) return data.posture;
  const posture = { critical: 0, high: 0, medium: 0, low: 0, total: findings.length };
  for (const finding of findings) {
    const severity = String(finding.severity || '').toLowerCase();
    if (severity === 'critical' || severity === 'high' || severity === 'medium' || severity === 'low') {
      posture[severity] += 1;
    }
  }
  return posture;
}

function metaLine(finding: UnifiedFinding): string {
  const meta = finding.metadata || {};
  const parts: string[] = [];
  const push = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return;
    parts.push(`${label}: ${String(value)}`);
  };
  push('CWE', meta.cwe_id);
  push('CVE', meta.cve_id);
  push('Package', meta.version);
  push('Fix', meta.fix_version);
  push('Rule', meta.rule_id);
  push('Check', meta.check_id);
  push('Resource', meta.resource);
  if (finding.scanner) parts.push(`Scanner: ${finding.scanner}`);
  return parts.join('  ·  ');
}

export async function renderScanReportPdf(input: {
  projectName: string;
  projectId: string;
  generatedAt?: Date;
  data: ScanResultsPayload;
}): Promise<Buffer> {
  const generatedAt = input.generatedAt || new Date();
  const findings = collectReportFindings(input.data).sort((a, b) => {
    const rank = severityRank(String(a.severity)) - severityRank(String(b.severity));
    if (rank !== 0) return rank;
    return String(a.title).localeCompare(String(b.title));
  });
  const posture = postureFrom(input.data, findings);
  const modules = input.data.modules || [];
  const completedAt = input.data.completed_at ? new Date(input.data.completed_at) : null;

  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, info: {
    Title: `DeplAI security report — ${input.projectName}`,
    Author: 'DeplAI',
    CreationDate: generatedAt,
  } });
  const done = bufferPdf(doc);
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;

  const pageBottom = () => doc.page.height - PAGE_MARGIN;

  const ensureSpace = (needed: number) => {
    if (doc.y + needed > pageBottom()) doc.addPage();
  };

  const kv = (label: string, value: string) => {
    doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(`${label}: `, { continued: true });
    doc.font('Helvetica-Bold').fillColor('#0f172a').text(value);
  };

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a').text('Security Vulnerability Report');
  doc.moveDown(0.25);
  doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('DeplAI scan findings for review and remediation.');
  doc.moveDown(0.8);

  kv('Project', input.projectName);
  kv('Project ID', input.projectId);
  kv('Generated', generatedAt.toUTCString());
  if (completedAt && !Number.isNaN(completedAt.getTime())) {
    kv('Scan completed', completedAt.toUTCString());
  }

  doc.moveDown(0.9);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Executive summary');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9).fillColor('#334155');
  if (findings.length === 0) {
    doc.text('This pipeline run reported no vulnerabilities. Module status is included below for audit.');
  } else if (posture.critical + posture.high === 0) {
    doc.text(`This run reported ${posture.total} finding(s) with no critical or high severity issues.`);
  } else {
    doc.text(
      `This run reported ${posture.total} finding(s), including ${posture.critical} critical and ${posture.high} high. Prioritize those first.`,
    );
  }

  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Security posture');
  doc.moveDown(0.35);

  const summary = [
    ['Critical', posture.critical],
    ['High', posture.high],
    ['Medium', posture.medium],
    ['Low', posture.low],
    ['Total', posture.total],
  ] as const;
  const col = contentWidth / summary.length;
  const boxTop = doc.y;
  summary.forEach(([label, value], index) => {
    const x = PAGE_MARGIN + col * index;
    doc.rect(x, boxTop, col - 8, 36).strokeColor('#e2e8f0').stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(label, x + 8, boxTop + 6, { width: col - 24 });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a').text(String(value), x + 8, boxTop + 18, { width: col - 24 });
  });
  doc.y = boxTop + 48;

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Pipeline modules');
  doc.moveDown(0.35);
  const moduleRows = PHASE1_MODULES.map((module) => {
    const match = modules.find((item) => item.id === module.id);
    const extra = module.id === 'sbom'
      ? `${match?.component_count ?? input.data.sbom?.component_count ?? 0} components`
      : `${match?.finding_count ?? findings.filter((item) => item.category === module.id).length} findings`;
    return {
      label: module.label,
      status: match?.status || 'SKIPPED',
      extra,
    };
  });
  moduleRows.forEach((row) => {
    ensureSpace(16);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(row.label, PAGE_MARGIN, doc.y, {
      continued: true,
    });
    doc.font('Helvetica').fillColor('#334155').text(`  ${row.status}  ·  ${row.extra}`);
  });

  doc.moveDown(0.8);
  ensureSpace(28);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(`Findings (${findings.length})`);
  doc.moveDown(0.4);

  if (findings.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('No vulnerability findings were returned for this run.');
  } else {
    findings.forEach((finding, index) => {
      ensureSpace(72);
      const severity = String(finding.severity || 'medium').toUpperCase();
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a')
        .text(`${index + 1}. [${severity}] ${truncate(finding.title, 140)}`, { width: contentWidth });
      doc.font('Helvetica').fontSize(8).fillColor('#475569');
      doc.text(
        `${String(finding.category || 'unknown').toUpperCase()}  ·  ${truncate(finding.asset || finding.location || '—', 90)}  ·  ${finding.status || 'open'}`,
        { width: contentWidth },
      );
      if (finding.location && finding.location !== finding.asset) {
        doc.font('Helvetica-Oblique').text(truncate(finding.location, 120), { width: contentWidth });
      }
      const extra = metaLine(finding);
      if (extra) doc.font('Helvetica').fillColor('#64748b').text(truncate(extra, 180), { width: contentWidth });
      const extract = asText(finding.metadata?.code_extract);
      if (extract) {
        doc.font('Courier').fontSize(7).fillColor('#334155').text(truncate(extract, 180), { width: contentWidth });
      }
      doc.moveDown(0.2);
      doc.strokeColor('#e2e8f0').moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + contentWidth, doc.y).stroke();
      doc.moveDown(0.4);
    });
  }

  doc.moveDown(1.2);
  ensureSpace(24);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#94a3b8')
    .text('Computer-generated by DeplAI from the latest security pipeline run. This report is not a compliance certification.');

  doc.end();
  return done;
}
