class ScopeProbe {
  static {
    var fetch = (): undefined => undefined;
    void fetch;
  }
}

void ScopeProbe;
export const run = (url: string): Promise<Response> => fetch(url);
