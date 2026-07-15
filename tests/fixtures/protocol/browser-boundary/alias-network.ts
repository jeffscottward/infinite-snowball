const { fetch: get } = globalThis;

export async function download(url: string): Promise<string> {
  const response = await get(url);
  return response.text();
}
