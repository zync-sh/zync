import type { UsageFeatureId } from './catalog';

export interface UsagePayload {
  schemaVersion: number;
  installId: string;
  day?: string;
  appVersion?: string;
  platform?: string;
  arch?: string;
  openSeconds?: number;
  features?: Array<{ id: UsageFeatureId; count: number }>;
  sessions?: UsageSessionPayload[];
}

export interface UsageSessionPayload {
  id: string;
  openedAt: string;
  closedAt?: string;
  openSeconds?: number;
  timezone?: string;
  utcOffsetMinutes?: number;
}

export interface UsageApiResult {
  status: string;
}
