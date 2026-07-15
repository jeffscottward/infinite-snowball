const browserGlobal = globalThis;
const capability = "fetch";

export async function download(url: string): Promise<string> {
  const response = await browserGlobal[capability](url);
  return response.text();
}
