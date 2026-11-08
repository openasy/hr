// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  employees: Record<string, number>;
  pendingLeave: number;
  identityFailing: number;
  mailWaiting: number;
  documentsExpiring: number;
  counters: { identity: Map<string, number>; mail: Map<string, number> };
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="hr",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_hr_employees Employees, by status.",
    "# TYPE openasy_hr_employees gauge",
    ...["upcoming", "active", "left"].map((s) => `openasy_hr_employees{status="${s}"} ${g.employees[s] ?? 0}`),
    "# HELP openasy_hr_leave_pending Leave requests waiting for a decision.",
    "# TYPE openasy_hr_leave_pending gauge",
    `openasy_hr_leave_pending ${g.pendingLeave}`,
    "# HELP openasy_hr_documents_expiring Documents expired or expiring within 30 days.",
    "# TYPE openasy_hr_documents_expiring gauge",
    `openasy_hr_documents_expiring ${g.documentsExpiring}`,
    "# HELP openasy_hr_identity_failing People whose account Identity could not be told about yet.",
    "# TYPE openasy_hr_identity_failing gauge",
    `openasy_hr_identity_failing ${g.identityFailing}`,
    "# HELP openasy_hr_identity_total Accounts turned on, changed and off at Identity, and failures.",
    "# TYPE openasy_hr_identity_total counter",
    ...[...g.counters.identity].map(([k, n]) => `openasy_hr_identity_total{result="${k}"} ${n}`),
    "# HELP openasy_hr_mail_waiting Emails waiting in the outbox.",
    "# TYPE openasy_hr_mail_waiting gauge",
    `openasy_hr_mail_waiting ${g.mailWaiting}`,
    "# HELP openasy_hr_mail_total Emails sent, failed and dropped.",
    "# TYPE openasy_hr_mail_total counter",
    ...[...g.counters.mail].map(([k, n]) => `openasy_hr_mail_total{result="${k}"} ${n}`),
    "# HELP openasy_hr_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_hr_config_error gauge",
    `openasy_hr_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
