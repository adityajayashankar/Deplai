import { NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, SessionData } from "@/lib/session";
import { cookies } from "next/headers";

const AGENTIC_URL = process.env.AGENTIC_LAYER_URL ?? "http://localhost:8001";
const AGENTIC_KEY = process.env.DEPLAI_SERVICE_KEY ?? "";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;

  const upstream = await fetch(`${AGENTIC_URL}/api/iac/status/${runId}`, {
    headers: { "X-API-Key": AGENTIC_KEY },
  });

  if (!upstream.ok) {
    return NextResponse.json(
      { error: "Status fetch failed" },
      { status: upstream.status }
    );
  }

  const data = await upstream.json();
  return NextResponse.json(data);
}

// DELETE -- proxies "destroy resources" button
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { runId } = await params;

  const upstream = await fetch(`${AGENTIC_URL}/api/iac/run/${runId}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": AGENTIC_KEY,
    },
    body: JSON.stringify(body.aws_credentials),
  });

  const data = await upstream.json();
  return NextResponse.json(data, { status: upstream.status });
}
