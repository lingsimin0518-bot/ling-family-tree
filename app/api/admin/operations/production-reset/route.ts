import { env } from 'cloudflare:workers';
import { requireSuperAdmin } from '../../../../../lib/auth';
import { handleProductionReset, type ResetChannelEnvironment } from '../../../../../lib/production-reset-channel';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleProductionReset(request, env as unknown as ResetChannelEnvironment, { requireSuperAdmin });
}

// A fixed JSON 405 avoids framework-specific empty-response handling. This
// handler does not inspect auth, configuration, or database state.
export async function GET() {
  return Response.json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, {
    status: 405, headers: { Allow: 'POST', 'Cache-Control': 'private, no-store' },
  });
}
