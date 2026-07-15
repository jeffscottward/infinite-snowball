export async function follow(url: string): Promise<string> {
  return globalThis.fetch(url).then((response) => response.text());
}
