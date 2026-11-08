// Joining and leaving checklists. A checklist in the file `on: start` is started for each new employee, anchored on
// their start day; one `on: end` is started when an end day is set, anchored on it. Each task is due some days from
// the anchor and is for HR, the person's manager, the person themselves or a named member. Moving the day moves the
// tasks not yet done; clearing the end day cancels the leaving checklist. The file's tasks are copied in when a
// checklist starts, so a later change to the file does not rewrite a checklist under way.
//
// Identity is not a task here: on the start and end days HR tells Identity itself (sync.ts), and the leaving checklist
// shows whether the account is off.
import { atLeast } from "@openasy/auth";
import type { Words3 } from "./holidays.ts";
import type { Core, EmployeeRow, Viewer } from "./core.ts";
import { addDays } from "./dates.ts";
import { forbidden, notFound } from "./store.ts";

interface RunRow {
  id: string;
  employee_id: string;
  checklist: string;
  name: string;
  on_kind: "start" | "end";
  anchor: string;
  created_at: string;
  cancelled_at: string | null;
}
interface TaskRow {
  id: string;
  run_id: string;
  task: string;
  pos: number;
  text: string;
  who: "hr" | "manager" | "employee" | "member";
  assignee_id: string | null;
  assignee_email: string | null;
  offset_days: number;
  due_date: string;
  done_at: string | null;
  done_by: string | null;
}

export function createChecklists(c: Core) {
  function start(e: EmployeeRow, on: "start" | "end", anchor: string) {
    for (const list of c.cfg().checklists.filter((l) => l.on === on)) {
      const runId = c.newId();
      c.run(
        "INSERT INTO checklist_runs (id, employee_id, checklist, name, on_kind, anchor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        runId,
        e.id,
        list.id,
        JSON.stringify(list.name),
        on,
        anchor,
        c.iso(),
      );
      list.tasks.forEach((t, pos) => {
        const who = typeof t.who === "object" ? "member" : t.who;
        const assignee = who === "manager" ? e.manager_id : who === "employee" ? e.id : null;
        c.run(
          "INSERT INTO checklist_tasks (id, run_id, task, pos, text, who, assignee_id, assignee_email, offset_days, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          c.newId(),
          runId,
          t.id,
          pos,
          JSON.stringify(t.text),
          who,
          assignee,
          typeof t.who === "object" ? t.who.email : null,
          t.due,
          addDays(anchor, t.due),
        );
      });
    }
  }

  /** Starts, moves or cancels the person's checklists so they follow the start and end days. */
  function follow(e: EmployeeRow) {
    const runs = c.q<RunRow>("SELECT * FROM checklist_runs WHERE employee_id = ? AND cancelled_at IS NULL", e.id);
    const move = (r: RunRow, anchor: string) => {
      if (r.anchor === anchor) return;
      c.run("UPDATE checklist_runs SET anchor = ? WHERE id = ?", anchor, r.id);
      for (const t of c.q<TaskRow>("SELECT * FROM checklist_tasks WHERE run_id = ? AND done_at IS NULL", r.id))
        c.run("UPDATE checklist_tasks SET due_date = ? WHERE id = ?", addDays(anchor, t.offset_days), t.id);
    };
    const starts = runs.filter((r) => r.on_kind === "start");
    if (!starts.length && !c.one("SELECT 1 FROM checklist_runs WHERE employee_id = ? AND on_kind = 'start'", e.id)) start(e, "start", e.start_date);
    for (const r of starts) move(r, e.start_date);
    const ends = runs.filter((r) => r.on_kind === "end");
    if (e.end_date && !ends.length) start(e, "end", e.end_date);
    for (const r of ends) e.end_date ? move(r, e.end_date) : c.run("UPDATE checklist_runs SET cancelled_at = ? WHERE id = ?", c.iso(), r.id);
  }

  const words = (json: string): Words3 => JSON.parse(json) as Words3;

  function canDo(v: Viewer, t: TaskRow): boolean {
    if (atLeast(v.actor.role, "editor")) return true;
    if (t.assignee_id && t.assignee_id === v.employeeId) return true;
    return !!(t.assignee_email && v.actor.email && t.assignee_email === v.actor.email.toLowerCase());
  }

  function presentTask(v: Viewer, t: TaskRow, e?: EmployeeRow) {
    const assignee = t.assignee_id ? c.employee(t.assignee_id) : undefined;
    return {
      id: t.id,
      task: t.task,
      text: words(t.text),
      who: t.who,
      assignee: assignee ? { id: assignee.id, name: c.displayName(assignee) } : t.assignee_email ? { id: null, name: t.assignee_email } : null,
      dueDate: t.due_date,
      overdue: !t.done_at && t.due_date < c.today(),
      doneAt: t.done_at,
      doneBy: t.done_by,
      canDo: canDo(v, t),
      ...(e && { employee: { id: e.id, name: c.displayName(e) } }),
    };
  }

  function forEmployee(v: Viewer, e: EmployeeRow) {
    const runs = c.q<RunRow>("SELECT * FROM checklist_runs WHERE employee_id = ? ORDER BY on_kind DESC, created_at", e.id);
    const today = c.today();
    return runs.map((r) => {
      const tasks = c.q<TaskRow>("SELECT * FROM checklist_tasks WHERE run_id = ? ORDER BY pos", r.id);
      const identity =
        r.on_kind === "end" && c.cfg().identity
          ? {
              status: e.identity_state === "disabled" ? "done" : e.identity_error ? "failed" : "waiting",
              accountId: e.identity_id,
              error: e.identity_error,
            }
          : null;
      return {
        id: r.id,
        checklist: r.checklist,
        name: words(r.name),
        on: r.on_kind,
        anchor: r.anchor,
        cancelled: !!r.cancelled_at,
        done: tasks.filter((t) => t.done_at).length,
        total: tasks.length,
        overdue: tasks.filter((t) => !t.done_at && t.due_date < today).length,
        tasks: tasks.map((t) => presentTask(v, t)),
        identity,
      };
    });
  }

  /** Open tasks for the viewer: theirs, those of the people they manage for the manager, and HR's for editors. */
  function mine(v: Viewer, all: boolean) {
    const rows = c.q<TaskRow & { employee_id: string }>(
      `SELECT t.*, r.employee_id FROM checklist_tasks t JOIN checklist_runs r ON r.id = t.run_id
       WHERE r.cancelled_at IS NULL AND t.done_at IS NULL ORDER BY t.due_date, t.pos`,
    );
    const editor = atLeast(v.actor.role, "editor");
    const email = v.actor.email?.toLowerCase() ?? null;
    const isMine = (t: TaskRow) => (!!v.employeeId && t.assignee_id === v.employeeId) || (!!email && t.assignee_email === email) || (editor && t.who === "hr");
    return rows.filter((t) => (all && editor) || isMine(t)).map((t) => presentTask(v, t, c.employee(t.employee_id)));
  }

  function setDone(v: Viewer, id: string, done: boolean) {
    const t = c.one<TaskRow & { employee_id: string; cancelled_at: string | null }>(
      "SELECT t.*, r.employee_id, r.cancelled_at FROM checklist_tasks t JOIN checklist_runs r ON r.id = t.run_id WHERE t.id = ?",
      id,
    );
    if (!t) throw notFound(`Task ${id}`);
    if (!canDo(v, t)) throw forbidden("This task is not yours.");
    c.run("UPDATE checklist_tasks SET done_at = ?, done_by = ? WHERE id = ?", done ? c.iso() : null, done ? v.actor.name : null, id);
    return presentTask(v, c.one<TaskRow>("SELECT * FROM checklist_tasks WHERE id = ?", id)!, c.employee(t.employee_id));
  }

  return { follow, forEmployee, mine, setDone };
}

export type Checklists = ReturnType<typeof createChecklists>;
