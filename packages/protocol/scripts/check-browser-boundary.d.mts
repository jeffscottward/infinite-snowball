export interface BrowserBoundaryViolation {
  ruleId: string;
  moduleId: string;
  remediation: string;
  evidence?: string;
}

export interface BrowserBoundaryResult {
  ok: boolean;
  modules: string[];
  violations: BrowserBoundaryViolation[];
  outputBytes: number;
}

export function inspectBrowserGraph(entry?: string): Promise<BrowserBoundaryResult>;
export function assertBrowserBoundary(entry?: string): Promise<BrowserBoundaryResult>;
