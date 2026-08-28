import { NextRequest } from 'next/server';
import { Client } from 'ssh2';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { isPublicIpv4Address } from '@/lib/net-guard';

export const dynamic = 'force-dynamic';

interface Ec2LogsBody {
  ipAddress?: string;
  privateKey?: string;
  projectId?: string;
  instanceId?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function assertOwnedInstance(params: {
  projectName: string;
  instanceId: string;
  ipAddress: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  awsRegion: string;
}): Promise<Response | null> {
  let agenticRes: Response;
  try {
    agenticRes = await fetch(`${AGENTIC_URL}/api/aws/runtime-details`, {
      method: 'POST',
      headers: {
        ...agenticHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project_name: params.projectName,
        aws_access_key_id: params.awsAccessKeyId,
        aws_secret_access_key: params.awsSecretAccessKey,
        aws_session_token: params.awsSessionToken || undefined,
        aws_region: params.awsRegion,
        instance_id: params.instanceId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return new Response('Unable to confirm instance ownership', { status: 502 });
  }

  const data = await agenticRes.json().catch(() => ({})) as {
    success?: boolean;
    details?: {
      instance?: {
        instance_id?: string;
        public_ipv4_address?: string;
      };
    };
  };

  const liveInstanceId = String(data.details?.instance?.instance_id || '').trim();
  const livePublicIp = String(data.details?.instance?.public_ipv4_address || '').trim();
  if (
    !agenticRes.ok
    || data.success !== true
    || !liveInstanceId
    || liveInstanceId === 'n/a'
    || !isPublicIpv4Address(livePublicIp)
    || !sameText(liveInstanceId, params.instanceId)
    || livePublicIp !== params.ipAddress
  ) {
    return new Response('Forbidden: instance does not belong to this project', { status: 403 });
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json() as Ec2LogsBody;
    const ipAddress = String(body.ipAddress || '').trim();
    const privateKey = String(body.privateKey || '').trim();
    const projectId = String(body.projectId || '').trim();
    const instanceId = String(body.instanceId || '').trim();
    const awsAccessKeyId = String(body.aws_access_key_id || '').trim();
    const awsSecretAccessKey = String(body.aws_secret_access_key || '').trim();
    const awsSessionToken = String(body.aws_session_token || '').trim();
    const awsRegion = String(body.aws_region || '').trim();

    if (!ipAddress || !privateKey || !projectId || !instanceId) {
      return new Response('Missing projectId, instanceId, ipAddress, or privateKey', { status: 400 });
    }
    if (!awsAccessKeyId || !awsSecretAccessKey || !awsRegion) {
      return new Response('AWS credentials are required to confirm instance ownership', { status: 400 });
    }
    if (!isPublicIpv4Address(ipAddress)) {
      return new Response('ipAddress must be a public IPv4 address', { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).trim();
    const ownershipError = await assertOwnedInstance({
      projectName,
      instanceId,
      ipAddress,
      awsAccessKeyId,
      awsSecretAccessKey,
      awsSessionToken,
      awsRegion,
    });
    if (ownershipError) return ownershipError;

    const stream = new ReadableStream({
      start(controller) {
        const conn = new Client();
        let streamActive = true;

        const cleanup = () => {
          if (streamActive) {
            streamActive = false;
            try { controller.close(); } catch {}
            conn.end();
          }
        };

        conn.on('ready', () => {
          controller.enqueue(new TextEncoder().encode(`Connecting to ${ipAddress}...\n`));
          controller.enqueue(new TextEncoder().encode('Connection established.\n\n'));

          const tailCmd = `
            while [ ! -f /var/log/cloud-init-output.log ] && [ ! -f /var/log/deplai-init.log ]; do sleep 1; done;
            sudo tail -f -n 1000 /var/log/cloud-init-output.log /var/log/deplai-init.log 2>/dev/null
          `;

          conn.exec(tailCmd, (err, stream) => {
            if (err) {
              controller.enqueue(new TextEncoder().encode(`Error starting tail: ${err.message}\n`));
              cleanup();
              return;
            }

            stream.on('data', (data: Buffer) => {
              if (streamActive) {
                controller.enqueue(data);
                const text = data.toString();
                if (text.includes('Cloud-init v.') && text.includes('finished at')) {
                  setTimeout(cleanup, 2000);
                }
              }
            }).stderr.on('data', (data: Buffer) => {
              if (streamActive) {
                controller.enqueue(data);
              }
            }).on('close', () => {
              cleanup();
            });
          });
        }).on('error', (err) => {
          controller.enqueue(new TextEncoder().encode(`SSH Error: ${err.message}\n`));
          cleanup();
        });

        conn.connect({
          host: ipAddress,
          port: 22,
          username: 'ec2-user',
          privateKey,
          readyTimeout: 30000,
        });

        setTimeout(cleanup, 3600 * 1000);
      },
      cancel() {
        // Client disconnected
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'EC2 log stream failed';
    return new Response(message, { status: 500 });
  }
}
