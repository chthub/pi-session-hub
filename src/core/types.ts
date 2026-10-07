import type { NativeResumeAction } from "../adapters/types.ts";
import type { QueryOptions } from "../index/db.ts";
import type { ScanResult } from "../index/scan.ts";
import type { DetectionResult, ExternalSession, HarnessId } from "../types.ts";

export interface SessionRef {
  uid: string;
  harness: HarnessId;
  nativeId: string;
  path: string;
}

export type SessionQuery = QueryOptions;
export interface HubStatus {
  total: number;
  indexedAt: string | null;
  detections: DetectionResult[];
  repos: string[];
  harnesses: HarnessId[];
  scan: ScanResult | null;
}
export interface ResolvedResume {
  session: ExternalSession;
  action: NativeResumeAction;
}
export interface ResumeLauncher {
  launch(action: NativeResumeAction): Promise<void>;
}
