export function text(value: unknown) {
  // oxlint-disable-next-line typescript/no-base-to-string
  return String(value ?? '');
}

export async function apiError(error: unknown) {
  if (error instanceof Response) return Response.json({ error: await error.text() }, { status: error.status });
  console.error(error);
  return Response.json({ error: error instanceof Error ? error.message : '操作失败' }, { status: 500 });
}
