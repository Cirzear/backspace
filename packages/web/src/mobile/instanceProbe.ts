import type { InstanceInfoResponse } from '@backspace/shared';
import i18n from '../i18n';
import { validateInstanceOrigin } from '../platform/instanceRuntime';

const INSTANCE_PROBE_TIMEOUT_MS = 10_000;

function isInstanceInfo(value: unknown): value is InstanceInfoResponse {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  const strings = ['name', 'version', 'instanceId', 'sourceCodeUrl'];
  const booleans = ['registrationOpen', 'federatedRegistrationOpen', 'directoryConfigured',
    'directoryAvailable', 'directoryEnabled', 'supportCardEnabled'];
  return strings.every(key => typeof info[key] === 'string')
    && booleans.every(key => typeof info[key] === 'boolean')
    && (info.commit === null || typeof info.commit === 'string');
}

export async function probeMobileInstance(input: string): Promise<{ origin: string; info: InstanceInfoResponse }> {
  let origin: string;
  try {
    origin = validateInstanceOrigin(input);
  } catch {
    throw new Error(i18n.t('mobile:instance.invalidOrigin'));
  }
  // Probe exactly the chosen origin, without credentials or redirecting to another server.
  const response = await fetch(`${origin}/api/instance/info`, {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(INSTANCE_PROBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(i18n.t('mobile:instance.httpError', { status: response.status }));
  const info: unknown = await response.json();
  if (!isInstanceInfo(info)) throw new Error(i18n.t('mobile:instance.invalidResponse'));
  return { origin, info };
}
