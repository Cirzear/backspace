import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { createNativePublisher, NativeVoiceError } from '../utils/nativeVoicePublisher.js';
import { requestFederatedNativePublisher } from '../utils/nativeVoiceFederation.js';
import { getNativeVoiceSession, stopNativeVoiceSession } from '../ws/nativeVoiceSessions.js';
import { resolveHostedNativeOwner, validateScreenTokenRequest } from './livekitScreenOwner.js';
import { authenticateS2SPeer } from './federation/handlers/s2sAuth.js';
import { attributionRefusal, resolveRelayActor } from './federation/identity.js';
import { getDb } from '../db/index.js';

function respondError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof NativeVoiceError)) throw error;
  reply.log.warn({ err: error }, 'Native voice request refused');
  const code = error.statusCode === 400 ? 'validation_failed' : error.statusCode >= 500 ? 'internal_error' : 'forbidden';
  sendError(reply, error.statusCode, code);
}

function stopIdentity(body: unknown): string {
  if (!body || typeof body !== 'object' || !('identity' in body) ||
      typeof body.identity !== 'string' || !/^screen:[\da-f-]{36}$/.test(body.identity)) {
    throw new NativeVoiceError(400, 'Invalid native screen identity');
  }
  return body.identity;
}

async function stopOwnedPublisher(userId: string, body: unknown): Promise<void> {
  const identity = stopIdentity(body);
  const session = getNativeVoiceSession(identity);
  if (session && session.userId !== userId) throw new NativeVoiceError(403, 'Cannot stop another user\'s native session');
  await stopNativeVoiceSession(identity);
}

export function registerLivekitScreenRoutes(app: FastifyInstance): void {
  app.post('/api/livekit/screen-token', { preHandler: authenticate }, async (request, reply) => {
    try {
      const body = validateScreenTokenRequest(request.body);
      const remote = await requestFederatedNativePublisher({ request: body, userId: request.userId });
      if (remote) return reply.send(remote);
      const owner = resolveHostedNativeOwner({ request: body, userId: request.userId, federated: false });
      return reply.send(await createNativePublisher(owner));
    } catch (error) {
      respondError(reply, error);
    }
  });
  app.post('/api/livekit/screen-stop', { preHandler: authenticate }, async (request, reply) => {
    try {
      await stopOwnedPublisher(request.userId, request.body);
      return reply.code(204).send();
    } catch (error) {
      respondError(reply, error);
    }
  });
  registerFederatedScreenRoutes(app);
}

function federatedActor(request: FastifyRequest, sourceOrigin: string): string {
  const body = request.body as Record<string, unknown> | null;
  const actor = body?.actor;
  if (!actor || typeof actor !== 'object' || !('homeUserId' in actor) || !('homeInstance' in actor) ||
      typeof actor.homeUserId !== 'string' || typeof actor.homeInstance !== 'string') {
    throw new NativeVoiceError(400, 'Invalid federation actor');
  }
  const identity = { homeUserId: actor.homeUserId, homeInstance: actor.homeInstance };
  const db = getDb();
  if (attributionRefusal(identity, sourceOrigin, db)) throw new NativeVoiceError(403, 'Federation actor is not homed on the requesting peer');
  const resolution = resolveRelayActor(identity, db);
  if (resolution.kind !== 'found') throw new NativeVoiceError(403, 'Federation actor is not a local member');
  return resolution.user.id;
}

function registerFederatedScreenRoutes(app: FastifyInstance): void {
  app.post('/api/federation/livekit/screen-token', async (request, reply) => {
    const auth = authenticateS2SPeer(request, reply);
    if (!auth.ok) return;
    try {
      const userId = federatedActor(request, auth.peer.origin);
      const body = validateScreenTokenRequest(request.body);
      if (!body.federatedCallId) throw new NativeVoiceError(400, 'Federation requires a federated call id');
      const owner = resolveHostedNativeOwner({ request: body, userId, federated: true });
      return reply.send(await createNativePublisher(owner));
    } catch (error) {
      respondError(reply, error);
    }
  });
  app.post('/api/federation/livekit/screen-stop', async (request, reply) => {
    const auth = authenticateS2SPeer(request, reply);
    if (!auth.ok) return;
    try {
      await stopOwnedPublisher(federatedActor(request, auth.peer.origin), request.body);
      return reply.code(204).send();
    } catch (error) {
      respondError(reply, error);
    }
  });
}
