import { NextRequest } from 'next/server';
import { Client } from 'ssh2';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { ipAddress, privateKey } = await req.json();

    if (!ipAddress || !privateKey) {
      return new Response('Missing ipAddress or privateKey', { status: 400 });
    }

    const stream = new ReadableStream({
      start(controller) {
        const conn = new Client();
        let streamActive = true;

        const cleanup = () => {
          if (streamActive) {
            streamActive = false;
            try { controller.close(); } catch (e) {}
            conn.end();
          }
        };

        conn.on('ready', () => {
          controller.enqueue(new TextEncoder().encode(`Connecting to ${ipAddress}...\n`));
          controller.enqueue(new TextEncoder().encode('Connection established.\n\n'));
          
          // Poll for cloud-init-output.log if it doesn't exist yet
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

            stream.on('data', (data: any) => {
              if (streamActive) {
                controller.enqueue(data);
                const text = data.toString();
                if (text.includes('Cloud-init v.') && text.includes('finished at')) {
                  setTimeout(cleanup, 2000);
                }
              }
            }).stderr.on('data', (data: any) => {
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
          privateKey: privateKey,
          readyTimeout: 30000,
        });

        // Safety timeout (1 hour max)
        setTimeout(cleanup, 3600 * 1000);
      },
      cancel() {
        // Client disconnected
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error: any) {
    return new Response(error.message, { status: 500 });
  }
}
