const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function sha256Hex(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function hmacSha256Hex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export function aliyunPercentEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function canonicalizeAliyunQuery(query: Record<string, string>) {
  return Object.entries(query)
    .map(([key, value]) => [aliyunPercentEncode(key), aliyunPercentEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export async function createAliyunAcs3Request(input: {
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  action: string;
  version: string;
  query: Record<string, string>;
  date?: Date;
  nonce?: string;
}) {
  const endpoint = new URL(input.endpoint.startsWith('http') ? input.endpoint : `https://${input.endpoint}`);
  const host = endpoint.host;
  const date = (input.date ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = input.nonce ?? crypto.randomUUID();
  const payloadHash = await sha256Hex('');
  const headers: Record<string, string> = {
    host,
    'x-acs-action': input.action,
    'x-acs-content-sha256': payloadHash,
    'x-acs-date': date,
    'x-acs-signature-nonce': nonce,
    'x-acs-version': input.version,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key].trim()}\n`).join('');
  const canonicalQuery = canonicalizeAliyunQuery(input.query);
  const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `ACS3-HMAC-SHA256\n${await sha256Hex(canonicalRequest)}`;
  const signature = await hmacSha256Hex(input.accessKeySecret, stringToSign);
  const authorization = `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return {
    url: `${endpoint.origin}/?${canonicalQuery}`,
    init: { method: 'POST', headers: { ...headers, authorization } } satisfies RequestInit,
    canonicalRequest,
    stringToSign,
  };
}
