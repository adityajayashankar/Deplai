import { NextResponse } from 'next/server';
import { OrganizationError } from './store';

export function organizationApiError(error: unknown): NextResponse {
  if (error instanceof OrganizationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  const record = error as { code?: string; cause?: { code?: string } };
  if (record?.code === 'ER_DUP_ENTRY' || record?.cause?.code === 'ER_DUP_ENTRY') {
    return NextResponse.json({ error: 'That organization value is already in use', code: 'duplicate_value' }, { status: 409 });
  }
  if (record?.code === 'ER_NO_SUCH_TABLE' || record?.cause?.code === 'ER_NO_SUCH_TABLE') {
    return NextResponse.json({
      error: 'Organizations database schema is not installed. Run scripts/apply-organizations-migration.ts against this database.',
      code: 'organizations_schema_missing',
    }, { status: 503 });
  }
  console.error('Organization API request failed', {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : 'Unknown organization error',
  });
  return NextResponse.json({ error: 'Organization request failed' }, { status: 500 });
}

export function normalizeOrganizationName(value: unknown): string {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) {
    throw new OrganizationError('Organization name must be between 2 and 120 characters');
  }
  return name;
}

export function normalizeOrganizationSlug(value: unknown, fallbackName?: string): string {
  const source = String(value || fallbackName || '').trim().toLowerCase();
  const slug = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug.length < 2) throw new OrganizationError('Organization slug must contain at least 2 letters or numbers');
  return slug;
}

export function normalizeEmail(value: unknown): string {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new OrganizationError('A valid email address is required');
  }
  return email;
}

export function normalizeTeamName(value: unknown): string {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) throw new OrganizationError('Team name must be between 2 and 100 characters');
  return name;
}

export function normalizeDescription(value: unknown): string | null {
  const description = String(value || '').trim();
  if (description.length > 255) throw new OrganizationError('Description must be at most 255 characters');
  return description || null;
}
