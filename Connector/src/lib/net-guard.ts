import { isIP } from 'node:net';

const BLOCKED_V4_PREFIXES = [
  '0.',
  '10.',
  '127.',
  '169.254.',
  '192.168.',
];

function isCarrierGradeNat(parts: number[]): boolean {
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isRfc1918ClassB(parts: number[]): boolean {
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function isMulticastOrReserved(parts: number[]): boolean {
  return parts[0] >= 224;
}

/** True only for a dotted IPv4 address that is safe to open an outbound SSH session to. */
export function isPublicIpv4Address(value: string | null | undefined): boolean {
  const ip = String(value || '').trim();
  if (!ip || isIP(ip) !== 4) return false;
  if (BLOCKED_V4_PREFIXES.some((prefix) => ip.startsWith(prefix))) return false;
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  if (isRfc1918ClassB(parts) || isCarrierGradeNat(parts) || isMulticastOrReserved(parts)) {
    return false;
  }
  return true;
}
