import fs from "node:fs/promises";
import path from "node:path";
import { StateStore } from "./state-store";
import { JobRecord } from "./types";
import { nowIso as runtimeNowIso } from "../core/time-provider.js";

interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  step: string;
  message: string;
  data?: unknown;
}

interface WorkerOptions {
  store: StateStore;
  commsRoot?: string;
}

function nowIso(): string {
  return runtimeNowIso();
}

async function appendLog(logPath: string, entry: LogEntry): Promise<void> {
  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(logPath, line, "utf-8");
}

function summarizeInstruction(instruction: string): string {
  const cleaned = instruction.replace(/\s+/g, " ").trim();
  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
}

function buildSuccessReport(job: JobRecord): string {
  return [
    `# Mission Report: ${job.id}`,
    "",
    `- Status: succeeded`,
    `- Created: ${job.created_at}`,
    `- Finished: ${nowIso()}`,
    `- Requester: ${job.request.requester}`,
    `- Workspace: ${job.workspace_path}`,
    "",
    "## Instruction",
    "",
    job.request.instruction,
    "",
    "## Notes",
    "",
    "Phase 1 runtime skeleton processed this job in no-op mode for architecture validation.",
  ].join("\n");
}

function buildFailureReport(job: JobRecord, errorMessage: string): string {
  return [
    `# Mission Report: ${job.id}`,
    "",
    `- Status: failed`,
    `- Created: ${job.created_at}`,
    `- Finished: ${nowIso()}`,
    `- Requester: ${job.request.requester}`,
    `- Workspace: ${job.workspace_path}`,
    "",
    "## Instruction",
    "",
    job.request.instruction,
    "",
    "## Error",
    "",
    errorMessage,
  ].join("\n");
}

export class JobWorker {
  private readonly store: StateStore;
  private readonly queue: string[] = [];
  private readonly commsRoot: string;
  private processing = false;

  constructor(options: WorkerOptions) {
    this.store = options.store;
    this.commsRoot = options.commsRoot || path.join(this.store.getWorkspaceRoot(), "comms");
  }

  enqueue(jobId: string): void {
    if (!this.queue.includes(jobId)) {
      this.queue.push(jobId);
    }

    void this.processLoop();
  }

  enqueueQueuedJobs(): void {
    for (const jobId of this.store.listQueuedJobIds()) {
      this.enqueue(jobId);
    }
  }

  private async processLoop(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift();
        if (!jobId) {
          continue;
        }

        await this.processJob(jobId);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processJob(jobId: string): Promise<void> {
    const existing = this.store.getJob(jobId);
    if (!existing || existing.status === "cancelled") {
      return;
    }

    const job = await this.store.updateStatus(jobId, "running", {
      summary: summarizeInstruction(existing.request.instruction),
      error_message: undefined,
    });

    const missionInputPath = path.join(job.workspace_path, "MISSION_INPUT.json");
    const missionLogPath = path.join(job.workspace_path, "MISSION_LOG.ndjson");
    const missionReportPath = path.join(job.workspace_path, "MISSION_REPORT.md");

    await fs.mkdir(job.workspace_path, { recursive: true });
    await fs.mkdir(this.commsRoot, { recursive: true });

    await fs.writeFile(
      missionInputPath,
      JSON.stringify(
        {
          job_id: job.id,
          request: job.request,
          created_at: job.created_at,
          started_at: job.started_at,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const logger = async (entry: { level: "info" | "warn" | "error"; step: string; message: string; data?: unknown }) => {
      await appendLog(missionLogPath, {
        timestamp: nowIso(),
        ...entry,
      });
    };

    try {
      await logger({ level: "info", step: "job.start", message: `Processing ${job.id}` });

      const inboxFile = path.join(this.commsRoot, "supervisor.inbox.md");
      const envelope = [
        `## ${nowIso()} ${job.id}`,
        "",
        `initiative_id: ${job.request.initiative_id || "(none)"}`,
        `session_id: ${job.request.session_id || "(none)"}`,
        `requester: ${job.request.requester}`,
        "",
        "instruction:",
        job.request.instruction,
        "",
      ].join("\n");
      await fs.appendFile(inboxFile, `${envelope}\n`, "utf-8");

      const report = buildSuccessReport(job);
      await fs.writeFile(missionReportPath, report, "utf-8");

      await this.store.updateStatus(job.id, "succeeded", {
        summary: `Completed ${job.id} in Phase 1 no-op skeleton mode.`,
      });

      await logger({
        level: "info",
        step: "job.finish",
        message: "Job succeeded",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.updateStatus(job.id, "failed", {
        error_message: message,
        summary: `Failed ${job.id}`,
      });

      await logger({
        level: "error",
        step: "job.error",
        message,
      });

      await fs.writeFile(missionReportPath, buildFailureReport(job, message), "utf-8");
    }
  }
}
