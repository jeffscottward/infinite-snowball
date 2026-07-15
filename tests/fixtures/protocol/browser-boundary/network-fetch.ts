export async function loadRemote(): Promise<Response> {
  return fetch("https://untrusted.example/community.json");
}
