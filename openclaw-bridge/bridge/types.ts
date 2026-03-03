export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskSubmission {
  instruction: string;
  requester: string;
  initiative_id?: string;
  session_id?: string;
  context_urls?: string[];
  model?: string;
  hints?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  request: TaskSubmission;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  workspace_path: string;
  error_message?: string;
  summary?: string;
}

export interface MissionReportIndex {
  updated_at: string;
  jobs: Array<{
    id: string;
    status: JobStatus;
    created_at: string;
    workspace_path: string;
    report_path: string;
  }>;
}
